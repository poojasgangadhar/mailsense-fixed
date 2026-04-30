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

const authRoutes  = require('./routes/auth');
const gmailRoutes = require('./routes/gmail');
const { startScheduler } = require('./scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ── Middleware ────────────────────────────────────────────────
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
