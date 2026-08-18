// backend/zoom.js
// ─────────────────────────────────────────────────────────────
//  Zoom OAuth2 + Meetings API helpers.
//  Separate OAuth app from Gmail/Calendar — Zoom is its own
//  provider, so it gets its own token table (zoom_tokens) and
//  its own connect/disconnect flow (routes/meetingProviders.js).
//
//  Uses Zoom's "OAuth app" (User-managed) flow:
//  https://developers.zoom.us/docs/integrations/oauth/
//  Required env vars: ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_REDIRECT_URI
// ─────────────────────────────────────────────────────────────
const fetch = require('node-fetch');
require('dotenv').config();

const ZOOM_AUTHORIZE_URL = 'https://zoom.us/oauth/authorize';
const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
const ZOOM_API_BASE = 'https://api.zoom.us/v2';

function basicAuthHeader() {
  const creds = `${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(creds).toString('base64')}`;
}

// ── Generate the consent URL ──────────────────────────────────
function getAuthUrl(state) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.ZOOM_CLIENT_ID,
    redirect_uri: process.env.ZOOM_REDIRECT_URI,
    state,
  });
  return `${ZOOM_AUTHORIZE_URL}?${params.toString()}`;
}

// ── Exchange an authorization code for tokens ─────────────────
async function exchangeCode(code) {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: process.env.ZOOM_REDIRECT_URI,
  });
  const res = await fetch(`${ZOOM_TOKEN_URL}?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Zoom token exchange failed: ${data.reason || data.error || res.status}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

// ── Refresh an expired access token ────────────────────────────
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await fetch(`${ZOOM_TOKEN_URL}?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: basicAuthHeader() },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Zoom token refresh failed: ${data.reason || data.error || res.status}`);
  return data;
}

// ── Ensure we have a live access token, refreshing + persisting if needed ──
// Zoom access tokens are short-lived (~1hr); token_expiry is a stored ms epoch.
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
    }).catch(err => console.error('[Zoom] Failed to persist refreshed token:', err.message));
  }
  return tokenRow.access_token;
}

async function zoomApi(tokenRow, saveToken, path, options = {}) {
  const accessToken = await ensureFreshToken(tokenRow, saveToken);
  const res = await fetch(`${ZOOM_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Zoom API error (${res.status}): ${data.message || JSON.stringify(data)}`);
  return data;
}

// ── Create a scheduled meeting and return its join link ───────
async function createMeeting(tokenRow, { topic, startISO, durationMinutes, timezone }, saveToken) {
  const data = await zoomApi(tokenRow, saveToken, '/users/me/meetings', {
    method: 'POST',
    body: JSON.stringify({
      topic: topic || 'Meeting',
      type: 2, // scheduled meeting
      start_time: startISO,
      duration: durationMinutes,
      timezone,
      settings: {
        join_before_host: true,
        waiting_room: false,
      },
    }),
  });
  return { meetingId: data.id ? String(data.id) : null, joinUrl: data.join_url || null };
}

// ── Update a meeting's scheduled time (used for reschedules) ──
async function updateMeeting(tokenRow, meetingId, { startISO, durationMinutes, timezone }, saveToken) {
  await zoomApi(tokenRow, saveToken, `/meetings/${meetingId}`, {
    method: 'PATCH',
    body: JSON.stringify({ start_time: startISO, duration: durationMinutes, timezone }),
  });
}

// ── Delete/cancel a meeting (used for cancellations) ───────────
async function deleteMeeting(tokenRow, meetingId, saveToken) {
  await zoomApi(tokenRow, saveToken, `/meetings/${meetingId}`, { method: 'DELETE' }).catch(err => {
    // Treat "meeting not found / already deleted" as a no-op, not a hard failure
    if (!/404|3001/.test(err.message)) throw err;
  });
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  createMeeting,
  updateMeeting,
  deleteMeeting,
};
