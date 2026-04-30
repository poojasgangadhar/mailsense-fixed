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
    body: JSON.stringify({ model: MISTRAL_MODEL, messages, max_tokens: maxTokens, temperature: 0.2 }),
  });
  if (!res.ok) throw new Error(`Mistral API ${res.status}: ${await res.text().catch(()=>res.statusText)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim();
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
  // Always mark emails from yourself as important
  if (userOwnEmail && fromAddr.toLowerCase().includes(userOwnEmail.toLowerCase().split('@')[0])) {
    return 'important';
  }

  const text = `${subject} ${snippet} ${fromAddr}`.toLowerCase();

  // Must match ≥2 spam keywords to be spam (reduce false positives)
  const spamScore  = SPAM_KEYWORDS.filter(k => text.includes(k)).length;
  const promoScore = PROMO_KEYWORDS.filter(k => text.includes(k)).length;

  if (spamScore  >= 2) return 'spam';
  if (promoScore >= 2) return 'promo';
  if (promoScore >= 1 && spamScore === 0) return 'promo';
  // Single spam keyword is not enough alone
  return 'important';
}

// ── Classify email ────────────────────────────────────────────
async function classifyEmail({ subject, snippet, fromAddr, fromName, userOwnEmail }) {
  // Self-email → always important
  if (userOwnEmail && fromAddr && fromAddr.toLowerCase().includes(userOwnEmail.toLowerCase().split('@')[0])) {
    return 'important';
  }

  if (!MISTRAL_API_KEY) {
    return ruleBasedClassify(subject, snippet, fromAddr, userOwnEmail);
  }

  const messages = [
    {
      role: 'system',
      content:
        'You are an email classifier. Classify emails as: important, promo, or spam.\n' +
        '- important: personal, work, direct communication needing a reply\n' +
        '- promo: marketing, newsletters, offers, receipts\n' +
        '- spam: unsolicited bulk, phishing, scams\n' +
        'IMPORTANT: Emails from the same person to themselves are ALWAYS important.\n' +
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

  const contextNote = customContext ? `\nAdditional context: ${customContext}` : '';
  const messages = [
    {
      role: 'system',
      content:
        'You are a professional email assistant. Write a brief, warm, professional auto-reply.\n' +
        'Guidelines: 2-3 sentences max. Acknowledge their message. Do NOT include subject line or signature.\n' +
        'Start directly with the greeting (e.g. "Hi John,").',
    },
    {
      role: 'user',
      content: `Write an auto-reply for:\nFrom: ${fromName || 'Unknown'}\nSubject: ${subject || '(no subject)'}\nContent: ${snippet || '(no preview)'}${contextNote}`,
    },
  ];

  try {
    const reply = await mistralChat(messages, 200);
    if (reply && reply.length > 20) return reply;
    return replyTemplate || `Hi ${fromName || 'there'},\n\nThank you for your email. I'll respond shortly.\n\nBest regards`;
  } catch (err) {
    console.error('[Mistral] generateReply error:', err.message);
    return replyTemplate || `Hi ${fromName || 'there'},\n\nThank you for your email. I'll respond shortly.\n\nBest regards`;
  }
}

module.exports = { classifyEmail, generateReply };
