// backend/scheduler.js
const { stmts, recomputeStats, markEmailsDeleted, query, queryOne, exec } = require('./db');
const gmailHelper = require('./gmail');
const schedulingHelper = require('./scheduling');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// ── Daily meeting agenda + reminder ────────────────────────────
// Runs once per day (piggybacking on the existing Vercel cron, since
// free-tier cron frequency is limited to once/day). Sends each user a
// summary of today's confirmed meetings — this doubles as the "meeting
// reminder" for anything scheduled later that day.
async function sendDailyAgenda(userEmail) {
  const todayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lastSent = await queryOne(
    "SELECT setting_value FROM user_settings WHERE user_email = ? AND setting_key = 'last_agenda_sent_date'", userEmail
  );
  if (lastSent?.setting_value === todayKey) return; // already sent today

  const settingsRow = await stmts.getAvailability.get(userEmail);
  const settings = schedulingHelper.parseSettingsRow(settingsRow);
  const tokenRow = await stmts.getToken.get(userEmail);
  if (!tokenRow) return; // no Gmail connected, nothing to send from

  const rows = await query(
    "SELECT * FROM appointments WHERE user_email = ? AND status = 'confirmed' ORDER BY confirmed_start ASC", userEmail
  );
  const now = new Date();
  const todaysMeetings = rows.filter(r => {
    if (!r.confirmed_start) return false;
    const d = new Date(r.confirmed_start);
    return d.toDateString() === now.toDateString() && d >= now;
  });

  // Mark as sent regardless (once/day, even if zero meetings) so we don't recheck all day
  await exec(
    "INSERT INTO user_settings (user_email, setting_key, setting_value) VALUES (?, 'last_agenda_sent_date', ?) ON CONFLICT(user_email, setting_key) DO UPDATE SET setting_value = excluded.setting_value",
    userEmail, todayKey
  );
  if (todaysMeetings.length === 0) return;

  const saveToken = (t) => stmts.upsertToken.run({ user_email: userEmail, ...t });
  const lines = todaysMeetings.map(m => {
    const time = new Date(m.confirmed_start).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: settings.timezone });
    return `• ${time} — ${m.contact_name || m.contact_email} (${m.subject || 'Meeting'})${m.meet_link ? ` — ${m.meet_link}` : ''}`;
  });
  const body = `Good morning! Here's your agenda for today (${todaysMeetings.length} meeting${todaysMeetings.length > 1 ? 's' : ''}):\n\n${lines.join('\n')}\n`;
  try {
    await gmailHelper.sendEmail(tokenRow, { from: userEmail, to: userEmail, subject: `Your agenda for today (${todaysMeetings.length} meeting${todaysMeetings.length > 1 ? 's' : ''})`, body }, saveToken);
    await stmts.insertLog.run(userEmail, 'blue', `Daily agenda sent — ${todaysMeetings.length} meeting${todaysMeetings.length > 1 ? 's' : ''} today`);
  } catch (err) {
    console.error(`[Scheduler] Daily agenda email failed for ${userEmail}:`, err.message);
  }
}

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
    try { await sendDailyAgenda(user_email); }
    catch (err) { console.error(`[Scheduler] Daily agenda error for ${user_email}:`, err.message); }
  }
  console.log(`[Scheduler] Done. Processed ${users.length} user(s).`);
}

function startScheduler() {
  // On Vercel (serverless) this interval won't persist across invocations.
  // Use the /api/run-scheduler cron endpoint instead (see vercel.json crons).
  // This function is still useful for local development.
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_SCHEDULER !== 'true') {
    console.log('[Scheduler] Skipped in production — use Vercel Cron (/api/run-scheduler) instead.');
    return;
  }

  setTimeout(async () => { await runScheduler(); }, 10_000);
  const interval = setInterval(async () => { await runScheduler(); }, CHECK_INTERVAL_MS);
  interval.unref();
  console.log(`[Scheduler] Started. Runs every ${CHECK_INTERVAL_MS / 60000} minute(s).`);
}

module.exports = { startScheduler, runScheduler };