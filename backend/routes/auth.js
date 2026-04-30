// backend/routes/auth.js
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { google } = require('googleapis');
const { db, stmts, exec, queryOne } = require('../db');
const { generateOTP, otpExpiresAt, sendOTPEmail } = require('../mailer');
const { signToken } = require('../middleware/auth');

const router = express.Router();

// ─── Google OAuth2 helper ─────────────────────────────────────
function getGoogleOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_LOGIN_REDIRECT_URI || `${process.env.APP_URL || 'http://localhost:3000'}/api/google-callback`
  );
}

// ─── GET /api/google-login ───────────────────────────────────
// Redirects user to Google consent screen for login/signup
router.get('/google-login', (req, res) => {
  const oAuth2Client = getGoogleOAuth2Client();
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
  res.redirect(url);
});

// ─── GET /api/google-callback ────────────────────────────────
// Google redirects here after user selects account
router.get('/google-callback', async (req, res) => {
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`${APP_URL}/?google_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return res.redirect(`${APP_URL}/?google_error=missing_code`);
  }

  try {
    const oAuth2Client = getGoogleOAuth2Client();
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);

    // Get user profile from Google
    const oauth2 = google.oauth2({ version: 'v2', auth: oAuth2Client });
    const { data: profile } = await oauth2.userinfo.get();

    const { email, given_name, family_name, name, id: google_id } = profile;
    if (!email) {
      return res.redirect(`${APP_URL}/?google_error=no_email`);
    }

    // Upsert user — create if new, skip if existing
    let user = stmts.getUserByEmail.get(email);
    if (!user) {
      const first_name = given_name || name?.split(' ')[0] || 'User';
      const last_name  = family_name || name?.split(' ').slice(1).join(' ') || '';
      // Google users have no password — store empty hash
      const hash = await bcrypt.hash(google_id + process.env.JWT_SECRET, 12);
      stmts.createUser.run({ first_name, last_name, email, password: hash, role: 'user', is_verified: 1 });
      user = stmts.getUserByEmail.get(email);
    } else if (!user.is_verified) {
      // Mark existing unverified user as verified via Google
      stmts.verifyUser.run(email);
      user = stmts.getUserByEmail.get(email);
    }

    const token = signToken(user);
    // Pass token via URL fragment — index.html picks it up and stores in sessionStorage
    res.redirect(`${APP_URL}/?google_token=${encodeURIComponent(token)}&google_email=${encodeURIComponent(email)}&google_name=${encodeURIComponent(user.first_name)}`);
  } catch (err) {
    console.error('[Google OAuth callback]', err);
    res.redirect(`${APP_URL}/?google_error=auth_failed`);
  }
});

// ─── POST /api/signup-send-otp ───────────────────────────────
router.post('/signup-send-otp', async (req, res) => {
  try {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password)
      return res.status(400).json({ error: 'All fields are required.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const existing = stmts.getUserByEmail.get(email);
    if (existing && existing.is_verified)
      return res.status(409).json({ error: 'An account with this email already exists.' });

    const hash = await bcrypt.hash(password, 12);
    if (existing && !existing.is_verified)
      exec('DELETE FROM users WHERE email = ? AND is_verified = 0', email);

    stmts.createUser.run({ first_name, last_name, email, password: hash, role: 'user', is_verified: 0 });

    const otp = generateOTP();
    stmts.insertOTP.run({ email, code: otp, type: 'signup', expires_at: otpExpiresAt() });

    // Always send to email — no dev leakage
    await sendOTPEmail({ to: email, name: first_name, otp, type: 'signup' });
    res.json({ success: true, message: `Verification code sent to ${email}` });

  } catch (err) {
    console.error('[signup-send-otp]', err);
    if (err.code === 'EAUTH' || err.code === 'ECONNREFUSED' || err.responseCode === 535) {
      return res.status(500).json({
        error: 'Email delivery failed. Please check your SMTP settings in .env (SMTP_USER, SMTP_PASS).'
      });
    }
    res.status(500).json({ error: 'Failed to send verification email.' });
  }
});

// ─── POST /api/signup-verify-otp ────────────────────────────
router.post('/signup-verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and OTP required.' });

  const record = stmts.getValidOTP.get(email, 'signup');
  if (!record) return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
  if (record.code !== otp) return res.status(400).json({ error: 'Incorrect verification code.' });

  stmts.markOTPUsed.run(record.id);
  stmts.verifyUser.run(email);
  res.json({ success: true, message: 'Account verified successfully.' });
});

// ─── POST /api/login ─────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const user = stmts.getUserByEmail.get(email);
  if (!user) return res.status(401).json({ error: 'No account found with this email.' });
  if (!user.is_verified) return res.status(401).json({ error: 'Please verify your email before logging in.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

  const token = signToken(user);
  res.json({
    success: true, token,
    user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role, agent_mode: user.agent_mode },
  });
});

// ─── POST /api/forgot-send-otp ───────────────────────────────
router.post('/forgot-send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  const user = stmts.getUserByEmail.get(email);
  if (!user || !user.is_verified)
    return res.json({ success: true, message: 'If this email exists, a code was sent.' });

  const otp = generateOTP();
  stmts.insertOTP.run({ email, code: otp, type: 'forgot', expires_at: otpExpiresAt() });

  try {
    await sendOTPEmail({ to: email, name: user.first_name, otp, type: 'forgot' });
    res.json({ success: true, message: 'Verification code sent.' });
  } catch (err) {
    console.error('[forgot-send-otp]', err);
    res.status(500).json({ error: 'Failed to send email. Check SMTP settings.' });
  }
});

// ─── POST /api/forgot-verify-otp ────────────────────────────
router.post('/forgot-verify-otp', (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'Email and code required.' });

  const record = stmts.getValidOTP.get(email, 'forgot');
  if (!record) return res.status(400).json({ error: 'Code expired or not found. Request a new one.' });
  if (record.code !== otp) return res.status(400).json({ error: 'Incorrect verification code.' });

  stmts.markOTPUsed.run(record.id);
  res.json({ success: true, message: 'Code verified.' });
});

// ─── POST /api/forgot-reset-password ────────────────────────
router.post('/forgot-reset-password', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and new password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

  const user = stmts.getUserByEmail.get(email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  const hash = await bcrypt.hash(password, 12);
  stmts.updatePassword.run(hash, email);
  res.json({ success: true, message: 'Password updated successfully.' });
});

// ─── POST /api/verify-credentials ────────────────────────────
// Used before deleting account — verifies email + password
router.post('/verify-credentials', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const user = stmts.getUserByEmail.get(email);
  if (!user) return res.status(401).json({ error: 'No account found with this email.' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password.' });

  res.json({ success: true });
});

// ─── POST /api/delete-account ────────────────────────────────
router.post('/delete-account', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const user = stmts.getUserByEmail.get(email);
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  // Re-verify password before deletion
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Incorrect password. Account not deleted.' });

  exec('DELETE FROM gmail_tokens  WHERE user_email = ?', email);
  exec('DELETE FROM emails        WHERE user_email = ?', email);
  exec('DELETE FROM agent_logs    WHERE user_email = ?', email);
  exec('DELETE FROM agent_stats   WHERE user_email = ?', email);
  exec('DELETE FROM otp_codes     WHERE email = ?', email);
  try { exec('DELETE FROM user_settings WHERE user_email = ?', email); } catch {}
  stmts.deleteUser.run(email);

  res.json({ success: true, message: 'Account deleted.' });
});

// ─── POST /api/save-settings ─────────────────────────────────
router.post('/save-settings', (req, res) => {
  const { email, key, value } = req.body;
  if (!email || !key || value === undefined)
    return res.status(400).json({ error: 'email, key and value required.' });
  try {
    exec(`
      INSERT INTO user_settings (user_email, setting_key, setting_value)
      VALUES (?, ?, ?)
      ON CONFLICT(user_email, setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at    = datetime('now')
    `, email, key, typeof value === 'string' ? value : JSON.stringify(value));
    res.json({ success: true });
  } catch (err) {
    console.error('[save-settings]', err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

module.exports = router;
