// backend/mistral.js — Mistral AI + classifier
const fetch = require('node-fetch');
require('dotenv').config();

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || '';
const MISTRAL_MODEL   = process.env.MISTRAL_MODEL   || 'mistral-small-latest';
const MISTRAL_URL     = 'https://api.mistral.ai/v1/chat/completions';

async function mistralChat(messages, maxTokens = 300) {
  if (!MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY not set');
  const res = await fetch(MISTRAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_API_KEY}` },
    body: JSON.stringify({ model: MISTRAL_MODEL, messages, max_tokens: maxTokens, temperature: 0.4 }),
  });
  if (!res.ok) throw new Error(`Mistral API ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
}

// ── No-reply / notification sender detection ─────────────────
const NO_REPLY_PATTERNS = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'notifications@', 'notification@', 'alerts@', 'alert@',
  'mailer@', 'mailer-daemon', 'postmaster@', 'bounce@',
  'support@', 'help@', 'info@', 'newsletter@', 'updates@',
  'automated@', 'system@', 'robot@', 'daemon@',
  'accounts-noreply@', 'mail-noreply@', 'verify@',
  'confirmation@', 'confirm@', 'billing@', 'invoices@',
  'receipts@', 'orders@', 'shipping@', 'tracking@',
];

const NO_REPLY_SUBJECTS = [
  'otp', 'verification code', 'verify your', 'confirm your',
  'password reset', 'reset your password', 'account confirmed',
  'welcome to', 'thank you for signing', 'thank you for your order',
  'order confirmation', 'order #', 'invoice #', 'receipt for',
  'your receipt', 'payment confirmation', 'subscription confirmed',
  'successfully subscribed', 'unsubscribe', 'delivery notification',
  'tracking update', 'your account has been', 'security alert',
  'login attempt', 'new sign-in', 'two-factor', '2fa',
  'do not reply', 'do not respond', 'automated message',
  'automatic reply', 'this is an automated',
];

function isNoReplyEmail(fromAddr = '', subject = '', snippet = '') {
  const addr = fromAddr.toLowerCase();
  const subj = subject.toLowerCase();
  const snip = snippet.toLowerCase();

  // Check sender address patterns
  if (NO_REPLY_PATTERNS.some(p => addr.includes(p))) return true;

  // Check subject for notification/transactional patterns
  if (NO_REPLY_SUBJECTS.some(p => subj.includes(p))) return true;

  // Check snippet for automated message indicators
  if (snip.includes('do not reply') || snip.includes('do not respond') ||
      snip.includes('this is an automated') || snip.includes('automated message')) return true;

  return false;
}

// ── Rule-based fallback ───────────────────────────────────────
const SPAM_KEYWORDS = [
  'winner','won','lottery','prize','claim now','urgent action',
  'account suspended','verify immediately','free money','wire transfer',
  'nigerian','inheritance','bitcoin investment','act now','selected',
  'congratulations you','limited offer expires','click here to claim',
];
const PROMO_KEYWORDS = [
  'sale','% off','coupon','promo code','newsletter','marketing',
  'shop now','buy now','flash sale','clearance','order confirmation',
  'unsubscribe','weekly digest','daily deals','special offer',
  'discount','deal of the day','limited time',
];

function ruleBasedClassify(subject = '', snippet = '', fromAddr = '', userOwnEmail = '') {
  if (userOwnEmail && fromAddr.toLowerCase().includes(userOwnEmail.toLowerCase().split('@')[0])) {
    return 'important';
  }
  // Notification/OTP emails → promo (no reply needed)
  if (isNoReplyEmail(fromAddr, subject, snippet)) return 'promo';

  const text = `${subject} ${snippet} ${fromAddr}`.toLowerCase();
  const spamScore  = SPAM_KEYWORDS.filter(k => text.includes(k)).length;
  const promoScore = PROMO_KEYWORDS.filter(k => text.includes(k)).length;

  if (spamScore  >= 2) return 'spam';
  if (promoScore >= 2) return 'promo';
  if (promoScore >= 1 && spamScore === 0) return 'promo';
  return 'important';
}

// ── Classify email ────────────────────────────────────────────
async function classifyEmail({ subject, snippet, fromAddr, fromName, userOwnEmail }) {
  // Self-email → always important
  if (userOwnEmail && fromAddr && fromAddr.toLowerCase().includes(userOwnEmail.toLowerCase().split('@')[0])) {
    return 'important';
  }

  // No-reply/notification emails → always promo (never reply)
  if (isNoReplyEmail(fromAddr, subject, snippet)) return 'promo';

  if (!MISTRAL_API_KEY) {
    return ruleBasedClassify(subject, snippet, fromAddr, userOwnEmail);
  }

  const messages = [
    {
      role: 'system',
      content:
        'You are an email classifier. Classify emails as: important, promo, or spam.\n' +
        '- important: personal messages, work emails, direct human communication that needs a reply\n' +
        '- promo: marketing, newsletters, offers, receipts, order confirmations, OTP codes, automated notifications, system alerts\n' +
        '- spam: unsolicited bulk, phishing, scams\n' +
        'Key rule: Any automated, transactional, or notification email = promo. Only classify as important if a real human is writing directly to the user and expects a reply.\n' +
        'Respond with ONE word only: important, promo, or spam.',
    },
    {
      role: 'user',
      content: `From: ${fromName || ''} <${fromAddr || ''}>\nSubject: ${subject || '(no subject)'}\nPreview: ${snippet || ''}`,
    },
  ];

  try {
    const result = await mistralChat(messages, 10);
    const clean  = result.toLowerCase().replace(/[^a-z]/g, '');
    if (['important', 'promo', 'spam'].includes(clean)) return clean;
    return ruleBasedClassify(subject, snippet, fromAddr, userOwnEmail);
  } catch (err) {
    console.error('[Mistral] classify error:', err.message);
    return ruleBasedClassify(subject, snippet, fromAddr, userOwnEmail);
  }
}

// ── Generate reply ────────────────────────────────────────────
async function generateReply({ subject, snippet, fromName, replyTemplate, customContext }) {
  if (!MISTRAL_API_KEY) {
    return replyTemplate || `Hi ${fromName || 'there'},\n\nThank you for your email. I'll get back to you shortly.\n\nBest regards`;
  }

  const contextNote = customContext ? `\nAdditional context from user: ${customContext}` : '';
  const messages = [
    {
      role: 'system',
      content:
        'You are a professional email assistant writing personalized auto-replies.\n' +
        'Rules:\n' +
        '- Write 2-4 sentences tailored specifically to the email content\n' +
        '- Reference the actual subject or content of their email\n' +
        '- Sound natural and human, not generic\n' +
        '- Do NOT use placeholder text like [Your Name] or [Company]\n' +
        '- Do NOT include subject line\n' +
        '- Do NOT include signature\n' +
        '- Start with greeting like "Hi [their name]," or "Hello,"\n' +
        '- Every reply must be UNIQUE and specific to this email',
    },
    {
      role: 'user',
      content: `Write a personalized auto-reply for this email:\nFrom: ${fromName || 'Unknown'}\nSubject: ${subject || '(no subject)'}\nContent: ${snippet || '(no preview)'}${contextNote}`,
    },
  ];

  try {
    const reply = await mistralChat(messages, 250);
    if (reply && reply.length > 20) return reply;
    return replyTemplate || `Hi ${fromName || 'there'},\n\nThank you for reaching out regarding "${subject}". I'll review this and get back to you shortly.\n\nBest regards`;
  } catch (err) {
    console.error('[Mistral] generateReply error:', err.message);
    return replyTemplate || `Hi ${fromName || 'there'},\n\nThank you for reaching out regarding "${subject}". I'll get back to you shortly.\n\nBest regards`;
  }
}

module.exports = { classifyEmail, generateReply, isNoReplyEmail };