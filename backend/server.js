// backend/server.js
require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

const express = require('express');
const cors    = require('cors');
const path    = require('path');

const authRoutes    = require('./routes/auth');
const gmailRoutes   = require('./routes/gmail');
const webauthnRoutes = require('./routes/webauthn');
const bookingRoutes = require('./routes/booking');
const meetingProviderRoutes = require('./routes/meetingProviders');
const { startScheduler, runScheduler } = require('./scheduler');

const app  = express();
const { initPromise } = require('./db');
app.use((req, res, next) => {
  initPromise.then(() => next()).catch(next);
});
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Middleware ────────────────────────────────────────────────
app.set('trust proxy', 1); // Required for express-rate-limit behind Vercel/proxies
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [APP_URL, /\.vercel\.app$/]
    : '*',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static files ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API Routes ────────────────────────────────────────────────
app.use('/api', authRoutes);
app.use('/api', gmailRoutes);
app.use('/api', bookingRoutes);
app.use('/api', meetingProviderRoutes);
app.use('/api/webauthn', webauthnRoutes);

// ── Vercel Cron: auto-delete scheduler ───────────────────────
// Configure in vercel.json: { "crons": [{ "path": "/api/run-scheduler", "schedule": "0 * * * *" }] }
// Vercel sends a request from 64.23.160.0/20 — no auth header needed in practice,
// but we guard with a shared secret for safety.
app.post('/api/run-scheduler', async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await runScheduler();
    res.json({ success: true });
  } catch (err) {
    console.error('[Cron] run-scheduler error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Agentra MailSense', timestamp: new Date().toISOString() });
});

// ── API 404 — always JSON, never HTML ─────────────────────────
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
});

// ── SPA routes ────────────────────────────────────────────────
app.get(['/dashboard', '/dashboard.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Global error handler — always JSON ────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err.stack || err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred.'
      : (err.message || 'Unknown error'),
  });
});

// ── Start ─────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Agentra MailSense → http://localhost:${PORT}\n`);
    // Scheduler only runs in long-lived server environments, not serverless
    if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_SCHEDULER === 'true') {
      startScheduler();
    }
  });
}

module.exports = app;
