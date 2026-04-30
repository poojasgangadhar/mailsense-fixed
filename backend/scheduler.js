// backend/scheduler.js
const { stmts, recomputeStats, markEmailsDeleted, query, queryOne, exec } = require('./db');
const gmailHelper = require('./gmail');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

async function getAutoDeleteSettings(userEmail) {
  try {
    const row = await queryOne("SELECT setting_value FROM user_settings WHERE user_email = ? AND setting_key = 'auto_delete'", userEmail);
    if (row?.setting_value) return JSON.parse(row.setting_value);
  } catch {}
  return { spam: '7', promo: '30', bin: '30' };
}

function cutoffDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

async function runForUser(userEmail) {
  const settings = await getAutoDeleteSettings(userEmail);
  const tokenRow = await stmts.getToken.get(userEmail);

  const deletedIds = [];
  const logLines   = [];

  async function processCategory(tag, daysStr, labelName) {
    if (!daysStr || daysStr === 'never') return;
    const days = parseInt(daysStr);
    if (isNaN(days) || days <= 0) return;
    const cutoff = cutoffDate(days);
    const rows = await query(
      'SELECT id, gmail_id, from_name, from_addr, subject FROM emails WHERE user_email = ? AND tag = ? AND deleted = 0 AND fetched_at < ?',
      userEmail, tag, cutoff
    );
    if (rows.length > 0) {
      deletedIds.push(...rows.map(r => r.id));
      logLines.push({
        dot: 'red',
        msg: `⏰ Auto-deleted <strong>${rows.length}</strong> ${labelName} email${rows.length > 1 ? 's' : ''} (older than ${days} day${days > 1 ? 's' : ''})`,
        gmailIds: rows.map(r => r.gmail_id).filter(Boolean),
      });
    }
  }

  async function processBin(daysStr) {
    if (!daysStr || daysStr === 'never') return;
    const days = parseInt(daysStr);
    if (isNaN(days) || days <= 0) return;
    const cutoff = cutoffDate(days);
    const rows = await query(
      'SELECT id, gmail_id FROM emails WHERE user_email = ? AND deleted = 1 AND fetched_at < ?',
      userEmail, cutoff
    );
    if (rows.length > 0) {
      for (const r of rows) {
        await exec('DELETE FROM emails WHERE id = ?', r.id);
      }
      logLines.push({
        dot: 'red',
        msg: `🗑️ Permanently purged <strong>${rows.length}</strong> email${rows.length > 1 ? 's' : ''} from Bin (older than ${days} day${days > 1 ? 's' : ''})`,
        gmailIds: [],
      });
    }
  }

  await processCategory('spam',  settings.spam,  'Spam');
  await processCategory('promo', settings.promo, 'Promotion');
  await processBin(settings.bin);

  if (deletedIds.length === 0 && logLines.length === 0) return;

  if (deletedIds.length > 0) await markEmailsDeleted(userEmail, deletedIds);

  for (const line of logLines) {
    if (line.gmailIds.length > 0 && tokenRow) {
      try { await gmailHelper.trashMessages(tokenRow, line.gmailIds); }
      catch (err) { console.warn(`[Scheduler] Gmail trash failed for ${userEmail}:`, err.message); }
    }
    await stmts.insertLog.run(userEmail, line.dot, line.msg);
    console.log(`[Scheduler] ${userEmail}: ${line.msg.replace(/<[^>]+>/g, '')}`);
  }

  await recomputeStats(userEmail);
}

async function runScheduler() {
  const now = new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
  console.log(`[Scheduler] Running auto-delete check at ${now}…`);
  let users = [];
  try {
    users = await query('SELECT DISTINCT user_email FROM gmail_tokens');
  } catch (err) {
    console.error('[Scheduler] Could not load users:', err.message);
    return;
  }
  if (users.length === 0) { console.log('[Scheduler] No Gmail-connected users.'); return; }
  for (const { user_email } of users) {
    try { await runForUser(user_email); }
    catch (err) { console.error(`[Scheduler] Error processing ${user_email}:`, err.message); }
  }
  console.log(`[Scheduler] Done. Processed ${users.length} user(s).`);
}

async function ensureSettingsTable() {
  await exec(`CREATE TABLE IF NOT EXISTS user_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL, setting_key TEXT NOT NULL,
    setting_value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_email, setting_key)
  )`);
}

function startScheduler() {
  // On Vercel (serverless) scheduler doesn't run — skip silently
  if (process.env.NODE_ENV === 'production') {
    console.log('[Scheduler] Skipped — serverless environment.');
    return;
  }

  ensureSettingsTable().then(() => {
    setTimeout(async () => { await runScheduler(); }, 10_000);
    const interval = setInterval(async () => { await runScheduler(); }, CHECK_INTERVAL_MS);
    interval.unref();
    console.log(`[Scheduler] Started. Runs every ${CHECK_INTERVAL_MS / 60000} minute(s).`);
  }).catch(err => console.error('[Scheduler] Failed to init:', err.message));
}

module.exports = { startScheduler, runScheduler, ensureSettingsTable };