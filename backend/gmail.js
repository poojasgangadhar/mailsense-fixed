// backend/gmail.js
// ─────────────────────────────────────────────────────────────
//  Gmail OAuth2 + API helpers
//  Wraps googleapis to: authorize, fetch messages, send/draft replies
// ─────────────────────────────────────────────────────────────
const { google } = require('googleapis');
require('dotenv').config();

const { CALENDAR_SCOPES } = require('./calendar');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://mail.google.com/',
  ...CALENDAR_SCOPES,
];

// ── Build an OAuth2 client ────────────────────────────────────
function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// ── Generate the consent URL ──────────────────────────────────
function getAuthUrl(stateEmail) {
  const oAuth2Client = createOAuth2Client();
  return oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       SCOPES,
    state:       stateEmail,
  });
}

// ── Exchange code for tokens ──────────────────────────────────
async function exchangeCode(code) {
  const oAuth2Client = createOAuth2Client();
  const { tokens } = await oAuth2Client.getToken(code);
  return tokens;
}

// ── Build an authorized client from stored token row ─────────
// saveToken(updatedFields) is an optional async callback that persists
// refreshed credentials back to the DB. Without it, a refreshed
// access_token only lives in memory and the next request re-uses
// the expired token, causing Gmail API 401s.
function buildAuthorizedClient(tokenRow, saveToken) {
  const oAuth2Client = createOAuth2Client();
  oAuth2Client.setCredentials({
    access_token:  tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date:   tokenRow.token_expiry ? parseInt(tokenRow.token_expiry) : undefined,
  });

  // Auto-save refreshed tokens to DB so they survive across requests
  oAuth2Client.on('tokens', (newTokens) => {
    tokenRow.access_token = newTokens.access_token;
    if (newTokens.refresh_token) tokenRow.refresh_token = newTokens.refresh_token;
    if (newTokens.expiry_date)   tokenRow.token_expiry  = newTokens.expiry_date.toString();
    if (saveToken) {
      saveToken({
        access_token:  tokenRow.access_token,
        refresh_token: tokenRow.refresh_token,
        token_expiry:  tokenRow.token_expiry,
        scope:         tokenRow.scope,
      }).catch(err => console.error('[Gmail] Failed to persist refreshed token:', err.message));
    }
  });

  return oAuth2Client;
}

// ── Decode base64url ──────────────────────────────────────────
function decodeBase64url(str) {
  if (!str) return '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// ── Extract plain text body from a message part ──────────────
function extractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64url(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }
  return '';
}

// ── Fetch messages from inbox ─────────────────────────────────
async function fetchMessages(tokenRow, maxResults = 100, dateRange = 'all', saveToken, pageToken = null) {
  const auth   = buildAuthorizedClient(tokenRow, saveToken);
  const gmail  = google.gmail({ version: 'v1', auth });

  // Build Gmail search query based on date range
  let q = 'in:inbox';
  const now = new Date();
  if (dateRange === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    const s = d.toISOString().split('T')[0].replace(/-/g, '/');
    const e = now.toISOString().split('T')[0].replace(/-/g, '/');
    q = `in:inbox after:${s} before:${e}`;
  } else if (dateRange === '7days') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    q = `in:inbox after:${d.toISOString().split('T')[0].replace(/-/g, '/')}`;
  } else if (dateRange === '30days') {
    const d = new Date(now); d.setDate(d.getDate() - 30);
    q = `in:inbox after:${d.toISOString().split('T')[0].replace(/-/g, '/')}`;
  } else if (dateRange === '1year') {
    const d = new Date(now); d.setFullYear(d.getFullYear() - 1);
    q = `in:inbox after:${d.toISOString().split('T')[0].replace(/-/g, '/')}`;
  } else if (dateRange && dateRange.startsWith('custom:')) {
    const parts = dateRange.split(':');
    if (parts[1]) q += ` after:${parts[1]}`;
    if (parts[2]) q += ` before:${parts[2]}`;
  }
  // 'all' = no date filter

  // Fetch one page of 100 message IDs
  const PAGE_SIZE = 100;
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: PAGE_SIZE,
    q,
    ...(pageToken ? { pageToken } : {}),
  });

  const messageIds = (listRes.data.messages || []).map(m => m.id);
  const nextPageToken = listRes.data.nextPageToken || null;

  if (messageIds.length === 0) return { messages: [], nextPageToken: null };

  // Fetch each message metadata in parallel batches
  const BATCH = 25;
  const messages = [];

  for (let i = 0; i < messageIds.length; i += BATCH) {
    const batch = messageIds.slice(i, i + BATCH);
    const fetched = await Promise.all(
      batch.map(id =>
        gmail.users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] })
          .then(r => r.data)
          .catch(() => null)
      )
    );
    messages.push(...fetched.filter(Boolean));
  }

  // Sort by internalDate descending (newest first)
  messages.sort((a, b) => parseInt(b.internalDate || 0) - parseInt(a.internalDate || 0));

  return { messages: messages.map(msg => {
    const headers = {};
    for (const h of (msg.payload?.headers || [])) {
      headers[h.name.toLowerCase()] = h.value;
    }

    const fromHeader = headers['from'] || '';
    const fromName   = fromHeader.replace(/<.*>/, '').trim().replace(/"/g, '') || fromHeader;
    const fromAddr   = (fromHeader.match(/<(.+?)>/) || [])[1] || fromHeader;

    const dateStr  = headers['date'] || '';
    let emailTime  = '';
    try {
      const d = new Date(dateStr);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      emailTime = isToday
        ? d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })
        : d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
    } catch {}

    return {
      id:        msg.id,
      gmail_id:  msg.id,
      thread_id: msg.threadId,
      from_addr: fromAddr,
      from_name: fromName,
      subject:   headers['subject'] || '(no subject)',
      snippet:   msg.snippet || '',
      body:      extractBody(msg.payload),
      email_time: emailTime,
      internal_date: parseInt(msg.internalDate || 0),
    };
  }), nextPageToken };
}

// ── Build a raw RFC-2822 email (base64url encoded) ────────────
function buildRawEmail({ from, to, subject, replyToMessageId, replyToThreadId, body }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    `In-Reply-To: ${replyToMessageId}`,
    `References: ${replyToMessageId}`,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    '',
    body,
  ];
  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64url');
}

// ── Send a reply immediately (Fast Mode) ─────────────────────
async function sendReply(tokenRow, { from, to, subject, messageId, threadId, body }, saveToken) {
  const auth  = buildAuthorizedClient(tokenRow, saveToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = buildRawEmail({
    from, to, subject,
    replyToMessageId: messageId,
    replyToThreadId:  threadId,
    body,
  });

  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      threadId,
    },
  });
  return res.data;
}

// ── Save a draft (Safe Mode) ──────────────────────────────────
async function saveDraft(tokenRow, { from, to, subject, messageId, threadId, body }, saveToken) {
  const auth  = buildAuthorizedClient(tokenRow, saveToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = buildRawEmail({
    from, to, subject,
    replyToMessageId: messageId,
    replyToThreadId:  threadId,
    body,
  });

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw, threadId },
    },
  });
  return res.data;
}

// ── Move messages to Trash ────────────────────────────────────
async function trashMessages(tokenRow, gmailIds, saveToken) {
  const auth  = buildAuthorizedClient(tokenRow, saveToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const results = await Promise.allSettled(
    gmailIds.map(id => gmail.users.messages.trash({ userId: 'me', id }))
  );
  return results.filter(r => r.status === 'fulfilled').length;
}

// ── Archive messages (remove INBOX label) ────────────────────
async function archiveMessages(tokenRow, gmailIds, saveToken) {
  const auth  = buildAuthorizedClient(tokenRow, saveToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const results = await Promise.allSettled(
    gmailIds.map(id =>
      gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: { removeLabelIds: ['INBOX'] },
      })
    )
  );
  return results.filter(r => r.status === 'fulfilled').length;
}

// ── Untrash (restore from Bin to INBOX) ──────────────────────
async function untrashMessages(tokenRow, gmailIds, saveToken) {
  const auth  = buildAuthorizedClient(tokenRow, saveToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const results = await Promise.allSettled(
    gmailIds.map(id => gmail.users.messages.untrash({ userId: 'me', id }))
  );
  return results.filter(r => r.status === 'fulfilled').length;
}

// ── Permanently delete (irreversible) ────────────────────────
async function permanentlyDeleteMessages(tokenRow, gmailIds, saveToken) {
  const auth  = buildAuthorizedClient(tokenRow, saveToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const results = await Promise.allSettled(
    gmailIds.map(id => gmail.users.messages.delete({ userId: 'me', id }))
  );
  return results.filter(r => r.status === 'fulfilled').length;
}

// ── Unarchive (restore to INBOX) ─────────────────────────────
async function unarchiveMessages(tokenRow, gmailIds, saveToken) {
  const auth  = buildAuthorizedClient(tokenRow, saveToken);
  const gmail = google.gmail({ version: 'v1', auth });

  const results = await Promise.allSettled(
    gmailIds.map(id =>
      gmail.users.messages.modify({
        userId: 'me',
        id,
        requestBody: { addLabelIds: ['INBOX'] },
      })
    )
  );
  return results.filter(r => r.status === 'fulfilled').length;
}

// ── Revoke access token ───────────────────────────────────────
async function revokeToken(accessToken) {
  try {
    const oAuth2Client = createOAuth2Client();
    await oAuth2Client.revokeToken(accessToken);
  } catch (err) {
    console.warn('[Gmail] Token revocation warning:', err.message);
  }
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  buildAuthorizedClient,
  fetchMessages,
  sendReply,
  saveDraft,
  trashMessages,
  archiveMessages,
  unarchiveMessages,
  untrashMessages,
  permanentlyDeleteMessages,
  revokeToken,
};
