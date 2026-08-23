// backend/routes/meetingProviders.js
// ─────────────────────────────────────────────────────────────
//  Zoom + Microsoft Teams connect/disconnect flows. These are
//  separate OAuth apps from Gmail/Calendar (their own tables:
//  zoom_tokens / teams_tokens), used purely to mint a video-call
//  join link that gets dropped into the Google Calendar event
//  Agentra already creates. Same JWT-in-state pattern as the
//  Gmail OAuth flow in routes/gmail.js.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const { stmts } = require('../db');
const { requireAuth, verifyToken } = require('../middleware/auth');
const zoomHelper = require('../zoom');
const teamsHelper = require('../teams');

const router = express.Router();

function makeRedirect(isMobile, params) {
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  if (isMobile) return `mailsense://dashboard?${params}`;
  return `${APP_URL}/dashboard.html?${params}`;
}

function parseState(rawState) {
  const isMobile = rawState && rawState.endsWith('|mobile');
  const token = isMobile ? rawState.slice(0, -7) : rawState;
  return { isMobile, token };
}

// ── Zoom ────────────────────────────────────────────────────────
router.get('/zoom-auth', (req, res) => {
  const token = req.query.token;
  const platform = req.query.platform || '';
  const payload = token && verifyToken(token);
  if (!payload?.email) return res.status(401).send('Authentication required.');
  const state = platform === 'mobile' ? `${token}|mobile` : token;
  res.redirect(zoomHelper.getAuthUrl(state));
});

router.get('/zoom-callback', async (req, res) => {
  const { code, state: rawState, error } = req.query;
  const { isMobile, token } = parseState(rawState);
  if (error) return res.redirect(makeRedirect(isMobile, `zoom=error&reason=${error}`));
  const payload = token && verifyToken(token);
  const email = payload?.email;
  if (!code || !email) return res.redirect(makeRedirect(isMobile, 'zoom=error&reason=missing_code'));
  try {
    const tokens = await zoomHelper.exchangeCode(code);
    await stmts.upsertZoomToken.run({
      user_email: email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_expiry: (Date.now() + (tokens.expires_in || 3600) * 1000).toString(),
      zoom_email: null,
    });
    await stmts.insertLog.run(email, 'green', 'Zoom connected — meetings will use Zoom join links');
    res.redirect(makeRedirect(isMobile, 'zoom=connected'));
  } catch (err) {
    console.error('[Zoom OAuth]', err);
    res.redirect(makeRedirect(isMobile, 'zoom=error&reason=token_exchange'));
  }
});

router.post('/zoom-disconnect', requireAuth, async (req, res) => {
  try {
    await stmts.deleteZoomToken.run(req.user.email);
    await stmts.insertLog.run(req.user.email, 'amber', 'Zoom disconnected');
    res.json({ success: true });
  } catch (err) {
    console.error('[zoom-disconnect]', err);
    res.status(500).json({ error: 'Failed to disconnect Zoom' });
  }
});

// ── Microsoft Teams ────────────────────────────────────────────
router.get('/teams-auth', (req, res) => {
  const token = req.query.token;
  const platform = req.query.platform || '';
  const payload = token && verifyToken(token);
  if (!payload?.email) return res.status(401).send('Authentication required.');
  const state = platform === 'mobile' ? `${token}|mobile` : token;
  res.redirect(teamsHelper.getAuthUrl(state));
});

router.get('/teams-callback', async (req, res) => {
  const { code, state: rawState, error } = req.query;
  const { isMobile, token } = parseState(rawState);
  if (error) return res.redirect(makeRedirect(isMobile, `teams=error&reason=${error}`));
  const payload = token && verifyToken(token);
  const email = payload?.email;
  if (!code || !email) return res.redirect(makeRedirect(isMobile, 'teams=error&reason=missing_code'));
  try {
    const tokens = await teamsHelper.exchangeCode(code);
    await stmts.upsertTeamsToken.run({
      user_email: email,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_expiry: (Date.now() + (tokens.expires_in || 3600) * 1000).toString(),
      ms_email: null,
    });
    await stmts.insertLog.run(email, 'green', 'Microsoft Teams connected — meetings will use Teams join links');
    res.redirect(makeRedirect(isMobile, 'teams=connected'));
  } catch (err) {
    console.error('[Teams OAuth]', err);
    res.redirect(makeRedirect(isMobile, 'teams=error&reason=token_exchange'));
  }
});

router.post('/teams-disconnect', requireAuth, async (req, res) => {
  try {
    await stmts.deleteTeamsToken.run(req.user.email);
    await stmts.insertLog.run(req.user.email, 'amber', 'Microsoft Teams disconnected');
    res.json({ success: true });
  } catch (err) {
    console.error('[teams-disconnect]', err);
    res.status(500).json({ error: 'Failed to disconnect Microsoft Teams' });
  }
});

// ── Combined status (used by the Booking Settings panel) ──────
router.get('/meeting-providers-status', requireAuth, async (req, res) => {
  try {
    const [zoomRow, teamsRow] = await Promise.all([
      stmts.getZoomToken.get(req.user.email),
      stmts.getTeamsToken.get(req.user.email),
    ]);
    res.json({ zoomConnected: !!zoomRow, teamsConnected: !!teamsRow });
  } catch (err) {
    console.error('[meeting-providers-status]', err);
    res.status(500).json({ error: 'Failed to load meeting provider status' });
  }
});

module.exports = router;
