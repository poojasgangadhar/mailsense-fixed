// backend/teams.js
// ─────────────────────────────────────────────────────────────
//  Microsoft Teams meeting-link helpers, via the Microsoft Graph
//  "online meetings" API. This is deliberately independent of
//  Outlook Calendar — we only need a Teams join link to drop into
//  the Google Calendar event Agentra already creates, so this
//  uses the standalone /me/onlineMeetings endpoint rather than
//  full Outlook calendar sync.
//
//  App registration: https://portal.azure.com (Azure AD / Entra ID)
//  Delegated permission required: OnlineMeetings.ReadWrite
//  Required env vars: MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REDIRECT_URI,
//                      MS_TENANT_ID (or 'common' for multi-tenant/personal)
// ─────────────────────────────────────────────────────────────
const fetch = require('node-fetch');
require('dotenv').config();

const TENANT = process.env.MS_TENANT_ID || 'common';
const MS_AUTHORIZE_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

const SCOPES = ['offline_access', 'OnlineMeetings.ReadWrite', 'User.Read'];

// ── Generate the consent URL ──────────────────────────────────
function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.MS_REDIRECT_URI,
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
  });
  return `${MS_AUTHORIZE_URL}?${params.toString()}`;
}

// ── Exchange an authorization code for tokens ─────────────────
async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.MS_REDIRECT_URI,
    scope: SCOPES.join(' '),
  });
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Microsoft token exchange failed: ${data.error_description || data.error || res.status}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

// ── Refresh an expired access token ────────────────────────────
async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES.join(' '),
  });
  const res = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Microsoft token refresh failed: ${data.error_description || data.error || res.status}`);
  return data;
}

// ── Ensure we have a live access token, refreshing + persisting if needed ──
async function ensureFreshToken(tokenRow, saveToken) {
  const expiry = tokenRow.token_expiry ? parseInt(tokenRow.token_expiry) : 0;
  if (expiry && Date.now() < expiry - 60000) return tokenRow.access_token;

  const refreshed = await refreshAccessToken(tokenRow.refresh_token);
  tokenRow.access_token = refreshed.access_token;
  tokenRow.refresh_token = refreshed.refresh_token || tokenRow.refresh_token;
  tokenRow.token_expiry = (Date.now() + (refreshed.expires_in || 3600) * 1000).toString();
  if (saveToken) {
    await saveToken({
      access_token: tokenRow.access_token,
      refresh_token: tokenRow.refresh_token,
      token_expiry: tokenRow.token_expiry,
    }).catch(err => console.error('[Teams] Failed to persist refreshed token:', err.message));
  }
  return tokenRow.access_token;
}

async function graphApi(tokenRow, saveToken, path, options = {}) {
  const accessToken = await ensureFreshToken(tokenRow, saveToken);
  const res = await fetch(`${GRAPH_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Graph API error (${res.status}): ${data.error?.message || JSON.stringify(data)}`);
  return data;
}

// ── Create an online meeting and return its join link ─────────
async function createMeeting(tokenRow, { subject, startISO, endISO }, saveToken) {
  const data = await graphApi(tokenRow, saveToken, '/me/onlineMeetings', {
    method: 'POST',
    body: JSON.stringify({
      subject: subject || 'Meeting',
      startDateTime: startISO,
      endDateTime: endISO,
    }),
  });
  return { meetingId: data.id || null, joinUrl: data.joinWebUrl || null };
}

// ── Update a meeting's scheduled time (used for reschedules) ──
async function updateMeeting(tokenRow, meetingId, { startISO, endISO }, saveToken) {
  await graphApi(tokenRow, saveToken, `/me/onlineMeetings/${encodeURIComponent(meetingId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ startDateTime: startISO, endDateTime: endISO }),
  });
}

// ── Delete/cancel a meeting (used for cancellations) ───────────
async function deleteMeeting(tokenRow, meetingId, saveToken) {
  await graphApi(tokenRow, saveToken, `/me/onlineMeetings/${encodeURIComponent(meetingId)}`, { method: 'DELETE' }).catch(err => {
    if (!/404/.test(err.message)) throw err;
  });
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  createMeeting,
  updateMeeting,
  deleteMeeting,
};
