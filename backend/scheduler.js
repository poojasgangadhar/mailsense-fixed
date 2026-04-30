// backend/scheduler.js
// ─────────────────────────────────────────────────────────────
//  Server-side auto-delete scheduler
//
//  Runs every hour on the SERVER — completely independent of
//  whether the user has the dashboard open in a browser.
//
//  Flow:
//  1. Every hour, load all users who have gmail connected
//  2. For each user, load their auto-delete settings from DB
//  3. Find emails older than the configured days
//  4. Move them to Gmail Trash via API + mark deleted in DB
//  5. Log every action to agent_logs
// ─────────────────────────────────────────────────────────────
const { db, stmts, recomputeStats, markEmailsDeleted } = require('./db');
const gmailHelper = require('./gmail');

// How often the scheduler checks (milliseconds)
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // every 1 hour
// For testing you can set this to 60 * 1000 (every 1 minute)

// ── Load auto-delete settings for a user from DB ─────────────
// Settings are stored as a JSON string in user_settings table.
// Falls back to sensible defaults if not configured.
function getAutoDeleteSettings(userEmail) {
  try {
    const row = db.prepare(
      "SELECT setting_value FROM user_settings WHERE user_email = ? AND setting_key = 'auto_delete'"
    ).get(userEmail);
    if (row?.setting_value) {
      return JSON.parse(row.setting_value);
    }
  } catch {}
  // Default: spam=7 days, promo=30 days, bin=30 days, never for others
  return { spam: '7', promo: '30', bin: '30' };
}

// ── Calculate cutoff date string ─────────────────────────────
function cutoffDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  // SQLite datetime format: YYYY-MM-DD HH:MM:SS
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

// ── Run auto-delete for a single user ────────────────────────
async function runForUser(userEmail) {
  const settings = getAutoDeleteSettings(userEmail);
  const tokenRow = stmts.getToken.get(userEmail);

  const deletedIds = [];
  const logLines   = [];

  // Helper: find and trash emails matching tag + age
  function processCategory(tag, daysStr, labelName) {
    if (!daysStr || daysStr === 'never') return;
    const days = parseInt(daysStr);
    if (isNaN(days) || days <= 0) return;

    const cutoff = cutoffDate(days);
    const rows = db.prepare(`
      SELECT id, gmail_id, from_name, from_addr, subject
      FROM emails
      WHERE user_email = ?
        AND tag       = ?
        AND deleted   = 0
        AND fetched_at < ?
    `).all(userEmail, tag, cutoff);

    if (rows.length > 0) {
      deletedIds.push(...rows.map(r => r.id));
      logLines.push({
        dot: 'red',
        msg: `⏰ Auto-deleted <strong>${rows.length}</strong> ${labelName} email${rows.length > 1 ? 's' : ''} (older than ${days} day${days > 1 ? 's' : ''})`,
        gmailIds: rows.map(r => r.gmail_id).filter(Boolean),
      });
    }
  }

  // Helper: empty bin emails older than N days
  function processBin(daysStr) {
    if (!daysStr || daysStr === 'never') return;
    const days = parseInt(daysStr);
    if (isNaN(days) || days <= 0) return;

    const cutoff = cutoffDate(days);
    const rows = db.prepare(`
      SELECT id, gmail_id
      FROM emails
      WHERE user_email = ?
        AND deleted   = 1
        AND fetched_at < ?
    `).all(userEmail, cutoff);

    if (rows.length > 0) {
      // Permanently remove from our DB (they're already in Gmail Trash)
      const ph = rows.map(() => '?').join(',');
      db.prepare(`DELETE FROM emails WHERE id IN (${ph})`).run(...rows.map(r => r.id));
      logLines.push({
        dot: 'red',
        msg: `🗑️ Permanently purged <strong>${rows.length}</strong> email${rows.length > 1 ? 's' : ''} from Bin (older than ${days} day${days > 1 ? 's' : ''})`,
        gmailIds: [],
      });
    }
  }

  // Process each category
  processCategory('spam',  settings.spam,  'Spam');
  processCategory('promo', settings.promo, 'Promotion');
  processBin(settings.bin);

  if (deletedIds.length === 0 && logLines.length === 0) return; // Nothing to do

  // Mark emails as deleted in our DB
  if (deletedIds.length > 0) {
    markEmailsDeleted(userEmail, deletedIds);
  }

  // Move to Gmail Trash via API (best-effort — don't fail if token expired)
  for (const line of logLines) {
    if (line.gmailIds.length > 0 && tokenRow) {
      try {
        await gmailHelper.trashMessages(tokenRow, line.gmailIds);
      } catch (err) {
        console.warn(`[Scheduler] Gmail trash failed for ${userEmail}:`, err.message);
        // Still mark deleted in our DB — Gmail might already have them
      }
    }

    // Write to agent_logs
    stmts.insertLog.run(userEmail, line.dot, line.msg);
    console.log(`[Scheduler] ${userEmail}: ${line.msg.replace(/<[^>]+>/g, '')}`);
  }

  // Recompute stats
  recomputeStats(userEmail);
}

// ── Run for ALL users ─────────────────────────────────────────
async function runScheduler() {
  const now = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  console.log(`[Scheduler] Running auto-delete check at ${now}…`);

  // Get all users who have gmail connected (have a token)
  let users = [];
  try {
    users = db.prepare('SELECT DISTINCT user_email FROM gmail_tokens').all();
  } catch (err) {
    console.error('[Scheduler] Could not load users:', err.message);
    return;
  }

  if (users.length === 0) {
    console.log('[Scheduler] No Gmail-connected users. Skipping.');
    return;
  }

  // Process each user sequentially to avoid rate limit hammering
  for (const { user_email } of users) {
    try {
      await runForUser(user_email);
    } catch (err) {
      console.error(`[Scheduler] Error processing ${user_email}:`, err.message);
    }
  }

  console.log(`[Scheduler] Done. Processed ${users.length} user(s).`);
}

// ── Bootstrap: create user_settings table if needed ──────────
function ensureSettingsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_email    TEXT    NOT NULL,
      setting_key   TEXT    NOT NULL,
      setting_value TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_email, setting_key)
    );
  `);
}

// ── Start the scheduler ───────────────────────────────────────
function startScheduler() {
  ensureSettingsTable();

  // Run once immediately on startup (after a 10s delay to let server settle)
  setTimeout(async () => {
    await runScheduler();
  }, 10_000);

  // Then repeat every CHECK_INTERVAL_MS
  const interval = setInterval(async () => {
    await runScheduler();
  }, CHECK_INTERVAL_MS);

  // Keep Node from exiting (shouldn't be needed inside express but safe)
  interval.unref();

  console.log(`[Scheduler] Auto-delete scheduler started. Runs every ${CHECK_INTERVAL_MS / 60000} minute(s).`);
  return interval;
}

module.exports = { startScheduler, runScheduler, ensureSettingsTable };
