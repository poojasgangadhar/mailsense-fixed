// backend/routes/gmail.js
const express = require('express');
const { db, stmts, recomputeStats, markEmailsDeleted, queryOne, query, exec } = require('../db');
const gmailHelper = require('../gmail');
const { classifyEmail, generateReply, isNoReplyEmail, detectMeetingIntent } = require('../mistral');
const schedulingHelper = require('../scheduling');
const calendarHelper = require('../calendar');
const { requireAuth, verifyToken } = require('../middleware/auth');

const router = express.Router();

// Persist refreshed OAuth tokens back to DB (passed as callback into gmail helpers)
function makeSaveToken(userEmail) {
  return async (updated) => {
    await stmts.upsertToken.run({
      user_email:    userEmail,
      access_token:  updated.access_token,
      refresh_token: updated.refresh_token || null,
      token_expiry:  updated.token_expiry  || null,
      scope:         updated.scope         || '',
    });
  };
}



const AVATAR_COLORS = ['#4f6ef7','#2dd4bf','#f59e0b','#f87171','#a78bfa','#34d399','#fb7185','#60a5fa'];
function colorForEmail(email = '') {
  let hash = 0;
  for (const c of email) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatEmail(row) {
  return {
    id: row.id, gmail_id: row.gmail_id,
    from: row.from_name || row.from_addr || 'Unknown',
    subject: row.subject || '(no subject)',
    snippet: row.snippet || '',
    tag: row.tag || 'important',
    color: row.color || '#4f6ef7',
    time: row.email_time || '',
    replied: !!row.replied,
    archived: !!row.archived,
    deleted: !!row.deleted,
  };
}

router.get('/gmail-auth', (req, res) => {
  const token = req.query.token;
  const platform = req.query.platform || '';
  const payload = token && verifyToken(token);
  if (!payload?.email) return res.status(401).send('Authentication required.');
  // Encode platform into state so callback knows whether to use deep link
  const state = platform === 'mobile' ? `${token}|mobile` : token;
  res.redirect(gmailHelper.getAuthUrl(state));
});

router.get('/oauth2callback', async (req, res) => {
  const { code, state: rawState, error } = req.query;
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  // Parse state — may be "jwt|mobile" or just "jwt"
  const isMobile = rawState && rawState.endsWith('|mobile');
  const token = isMobile ? rawState.slice(0, -7) : rawState;
  const makeRedirect = (path, params) => {
    if (isMobile) return `mailsense://dashboard?${params}`;
    return `${APP_URL}/${path}?${params}`;
  };
  if (error) return res.redirect(makeRedirect('dashboard.html', `gmail=error&reason=${error}`));
  const payload = token && verifyToken(token);
  const email = payload?.email;
  if (!code || !email) return res.redirect(makeRedirect('dashboard.html', 'gmail=error&reason=missing_code'));
  try {
    const tokens = await gmailHelper.exchangeCode(code);
    await stmts.upsertToken.run({
      user_email: email, access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_expiry: tokens.expiry_date ? tokens.expiry_date.toString() : null,
      scope: tokens.scope || '',
    });
    // Every new authorization is treated as a fresh connection — clear any
    // cached mail/stats from a previously connected Gmail account so that
    // switching accounts (with or without an explicit "Disconnect" first)
    // never leaves stale messages mixed into the new account's inbox.
    await exec('DELETE FROM emails WHERE user_email = ?', email);
    await exec('DELETE FROM agent_stats WHERE user_email = ?', email);
    await stmts.insertLog.run(email, 'green', `Gmail connected successfully for <strong>${email}</strong>`);
    res.redirect(makeRedirect('dashboard.html', 'gmail=connected'));
  } catch (err) {
    console.error('[OAuth]', err);
    res.redirect(makeRedirect('dashboard.html', 'gmail=error&reason=token_exchange'));
  }
});

router.post('/gmail-status', requireAuth, async (req, res) => {
  const email = req.user.email;
  const tokenRow = await stmts.getToken.get(email);
  if (!tokenRow) return res.json({ connected: false });
  const emailRows = await stmts.getEmails.all(email);
  const stats = await recomputeStats(email);
  const logs = await stmts.getLogs.all(email);
  res.json({
    connected: true,
    emails: emailRows.map(formatEmail),
    stats: { total: stats.total, important: stats.important, promo: stats.promo, spam: stats.spam, social: stats.social, updates: stats.updates, replied: stats.replied },
    logs: logs.map(l => ({ id: l.id, time: l.created_at.substring(11, 16), dot: l.dot_color, text: l.message })),
  });
});

router.post('/gmail-fetch', requireAuth, async (req, res) => {
  const { maxEmails = 100, dateRange = 'all', pageToken = null } = req.body;
  const email = req.user.email;
  const tokenRow = await stmts.getToken.get(email);
  if (!tokenRow) return res.status(400).json({ error: 'Gmail not connected.' });
  try {
    if (!pageToken) await stmts.insertLog.run(email, 'blue', `Fetching emails from Gmail (${dateRange === 'all' ? 'all time' : dateRange})…`);
    const saveToken = makeSaveToken(email);
    const { messages, nextPageToken } = await gmailHelper.fetchMessages(tokenRow, parseInt(maxEmails), dateRange, saveToken, pageToken);
    if (tokenRow.access_token) {
      await stmts.upsertToken.run({
        user_email: email, access_token: tokenRow.access_token,
        refresh_token: tokenRow.refresh_token, token_expiry: tokenRow.token_expiry, scope: tokenRow.scope,
      });
    }
    // Step 1: Save all emails immediately with existing tag or 'important' as default
    // Social platform domains — force reclassify if tagged as promo/important incorrectly
    const SOCIAL_DOMAINS = ['linkedin.com','instagram.com','facebook.com','twitter.com','x.com','github.com','youtube.com','whatsapp.com','discord.com'];
    const UPDATE_DOMAINS = ['naukri.com','indeed.com','glassdoor.com','amazon.com','flipkart.com','swiggy.com','zomato.com','paytm.com','phonepe.com','razorpay.com'];

    // Batch-fetch existing tags for ALL messages in one query instead of
    // one round-trip per message (this was the main source of slow fetches —
    // 100 emails meant 100+ sequential network calls to Turso before this fix).
    let existingTagById = new Map();
    if (messages.length) {
      const ph = messages.map(() => '?').join(',');
      const rows = await query(`SELECT id, tag FROM emails WHERE id IN (${ph})`, ...messages.map(m => m.id));
      existingTagById = new Map(rows.map(r => [r.id, r.tag]));
    }

    let newCount = 0;
    const toClassify = [];
    const tagById = new Map(); // reused below for the archive check — avoids querying again
    for (const msg of messages) {
      const existingTag = existingTagById.get(msg.id);
      const addr = (msg.from_addr || '').toLowerCase();
      const isSocial = SOCIAL_DOMAINS.some(d => addr.includes(d));
      const isUpdate = UPDATE_DOMAINS.some(d => addr.includes(d));

      let tag = existingTag || 'important';
      // Force correct tag for known social/update domains regardless of old tag
      if (isSocial) tag = 'social';
      else if (isUpdate) tag = 'updates';
      else if (!existingTag) {
        toClassify.push(msg);
        newCount++;
      }
      tagById.set(msg.id, tag);
      await stmts.upsertEmail.run({
        id: msg.id, user_email: email, gmail_id: msg.gmail_id, thread_id: msg.thread_id || null,
        from_addr: msg.from_addr || '', from_name: msg.from_name || '',
        subject: msg.subject || '', snippet: msg.snippet || '', body: msg.body || '',
        tag, color: colorForEmail(msg.from_addr), email_time: msg.email_time || '',
        internal_date: msg.internal_date || 0,
      });
    }

    // Step 2: Classify new emails in parallel batches of 5 (fire and forget to avoid timeout)
    const CLASS_BATCH = 5;
    (async () => {
      for (let i = 0; i < toClassify.length; i += CLASS_BATCH) {
        const batch = toClassify.slice(i, i + CLASS_BATCH);
        await Promise.all(batch.map(async msg => {
          try {
            const tag = await classifyEmail({ subject: msg.subject, snippet: msg.snippet, fromAddr: msg.from_addr, fromName: msg.from_name, userOwnEmail: email });
            await exec('UPDATE emails SET tag = ? WHERE id = ?', tag, msg.id);
          } catch { /* keep default tag */ }

          // AI Appointment Booking Module (Phase 1) — detect meeting
          // requests and propose real Calendar slots for review.
          try {
            const existingAppt = await stmts.getAppointmentByEmail.get(msg.id, email);
            if (existingAppt) return; // already processed this email

            const intent = await detectMeetingIntent({
              subject: msg.subject, snippet: msg.snippet, body: msg.body,
              fromAddr: msg.from_addr, fromName: msg.from_name, userOwnEmail: email,
            });
            if (!intent.isMeeting) return;

            const tokenRow = await stmts.getToken.get(email);
            if (!tokenRow || !calendarHelper.hasCalendarScope(tokenRow)) return; // needs reconnect to grant Calendar access

            const saveToken = (t) => stmts.upsertToken.run({ user_email: email, ...t });
            const settingsRow = await stmts.getAvailability.get(email);
            const { slots } = await schedulingHelper.computeAvailableSlots({
              tokenRow, saveToken, settingsRow,
              durationMinutes: intent.durationMinutes,
              requestedTimeText: intent.requestedTimeText,
            });
            if (!slots.length) return;

            await stmts.createAppointment.run({
              user_email: email, email_id: msg.id, thread_id: msg.thread_id || null,
              contact_email: msg.from_addr, contact_name: msg.from_name || '',
              subject: msg.subject || '', duration_minutes: intent.durationMinutes,
              status: 'pending', proposed_slots: JSON.stringify(slots),
              urgency: intent.urgency, requested_time_text: intent.requestedTimeText,
            });
            await stmts.insertLog.run(email, 'blue', `Meeting request detected from ${msg.from_name || msg.from_addr} — slots proposed for review`);
          } catch (err) {
            console.error('[booking] meeting-intent detection failed:', err.message);
          }
        }));
      }
    })().catch(() => {});
    const toArchive = [];
    for (const m of messages) {
      const t = tagById.get(m.id);
      if (t === 'promo' || t === 'spam') toArchive.push(m.gmail_id);
    }
    if (toArchive.length > 0) {
      // Check whether the user has disabled auto-archive
      const archiveSetting = await queryOne(
        "SELECT setting_value FROM user_settings WHERE user_email = ? AND setting_key = 'auto_archive'",
        email
      );
      const autoArchiveEnabled = archiveSetting ? archiveSetting.setting_value !== 'false' : true;

      if (autoArchiveEnabled) {
        await gmailHelper.archiveMessages(tokenRow, toArchive, saveToken).catch(() => {});
        // Sync archived flag in local DB so dashboard reflects the correct state
        if (toArchive.length > 0) {
          const ph = toArchive.map(() => '?').join(',');
          await exec(
            `UPDATE emails SET archived = 1 WHERE user_email = ? AND gmail_id IN (${ph})`,
            email, ...toArchive
          );
        }
        // Persist the archived gmail_ids so the user can undo within the session
        await exec(
          `INSERT INTO user_settings (user_email, setting_key, setting_value)
           VALUES (?, 'last_auto_archived', ?)
           ON CONFLICT(user_email, setting_key)
           DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`,
          email, JSON.stringify(toArchive)
        );
        await stmts.insertLog.run(email, 'amber',
          `Auto-archived <strong>${toArchive.length}</strong> promo/spam emails — <a class="log-undo-link" data-action="undo-auto-archive">Undo</a>`
        );
      } else {
        await stmts.insertLog.run(email, 'blue',
          `Skipped auto-archive for <strong>${toArchive.length}</strong> promo/spam emails (disabled in Settings)`
        );
      }
    }
    const stats = await recomputeStats(email);
    await stmts.insertLog.run(email, 'green', `Fetched <strong>${messages.length}</strong> emails (${newCount} new, classified)`);
    const allEmails = await stmts.getEmails.all(email);
    const pendingImportant = allEmails
      .filter(e => e.tag === 'important' && !e.replied && !e.deleted && !e.archived)
      .filter(e => !isNoReplyEmail(e.from_addr, e.subject, e.snippet))
      .filter(e => {
        // Only reply to emails from real people (personal email domains)
        const addr = (e.from_addr || '').toLowerCase();
        // Skip if it looks like a platform/service email
        const platformDomains = [
          'naukri.com','linkedin.com','github.com','instagram.com','facebook.com',
          'twitter.com','youtube.com','google.com','amazon.com','flipkart.com',
          'swiggy.com','zomato.com','paytm.com','phonepe.com','razorpay.com',
          'stripe.com','paypal.com','indeed.com','glassdoor.com','monster.com',
          'internshala.com','apna.co','medium.com','substack.com','mailchimp.com',
          'sendgrid.net','amazonaws.com','notifications.google.com',
        ];
        return !platformDomains.some(d => addr.includes(d));
      })
      .map(e => e.id);
    res.json({
      success: true, fetched: messages.length, new_classified: newCount, stats,
      nextPageToken: nextPageToken || null,
      emails: allEmails.map(row => ({
        id: row.id, gmail_id: row.gmail_id, from: row.from_name || row.from_addr || 'Unknown',
        subject: row.subject || '(no subject)', snippet: row.snippet || '', body: row.body || '',
        tag: row.tag || 'important', color: row.color || '#4f6ef7', time: row.email_time || '',
        replied: !!row.replied, archived: !!row.archived, deleted: !!row.deleted,
      })),
      pendingImportant,
    });
  } catch (err) {
    console.error('[gmail-fetch]', err);
    const isInvalidGrant = err.message && err.message.includes('invalid_grant');
    if (isInvalidGrant) {
      // Refresh token is dead — clear it so user is prompted to reconnect cleanly
      try { await stmts.deleteToken.run(email); } catch {}
      await stmts.insertLog.run(email, 'red', 'Gmail connection expired. Please reconnect Gmail.');
      return res.status(401).json({
        error: 'Gmail connection expired. Please reconnect your Gmail account.',
        code: 'GMAIL_RECONNECT_REQUIRED',
      });
    }
    await stmts.insertLog.run(email, 'red', `Fetch failed: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to fetch emails.' });
  }
});

router.post('/gmail-reply', requireAuth, async (req, res) => {
  const { emailId, mode, replyTemplate } = req.body;
  const userEmail = req.user.email;
  if (!emailId) return res.status(400).json({ error: 'emailId required.' });
  const tokenRow = await stmts.getToken.get(userEmail);
  if (!tokenRow) return res.status(400).json({ error: 'Gmail not connected.' });
  const emailRow = await queryOne('SELECT * FROM emails WHERE id = ? AND user_email = ?', emailId, userEmail);
  if (!emailRow) return res.status(404).json({ error: 'Email not found.' });
  if (emailRow.replied) return res.json({ success: true, skipped: true, message: 'Already replied.' });
  if (isNoReplyEmail(emailRow.from_addr, emailRow.subject, emailRow.snippet)) {
    return res.json({ success: false, skipped: true, message: 'Skipped — automated/no-reply sender.' });
  }
  const platformDomains = [
    'naukri.com','linkedin.com','github.com','instagram.com','facebook.com',
    'twitter.com','youtube.com','google.com','amazon.com','flipkart.com',
    'swiggy.com','zomato.com','paytm.com','phonepe.com','razorpay.com',
    'stripe.com','paypal.com','indeed.com','glassdoor.com','monster.com',
    'internshala.com','apna.co','medium.com','substack.com','mailchimp.com',
    'sendgrid.net','amazonaws.com','notifications.google.com',
  ];
  const fromAddr = (emailRow.from_addr || '').toLowerCase();
  if (platformDomains.some(d => fromAddr.includes(d))) {
    return res.json({ success: false, skipped: true, message: 'Skipped — platform/service email.' });
  }
  try {
    const userRow = await stmts.getUserByEmail.get(userEmail);
    const senderFirstName = userRow?.first_name || '';
    const replyBody = await generateReply({ subject: emailRow.subject, snippet: emailRow.snippet, fromName: emailRow.from_name, replyTemplate, senderFirstName });
    const params = { from: userEmail, to: emailRow.from_addr, subject: emailRow.subject, messageId: emailRow.gmail_id, threadId: emailRow.thread_id, body: replyBody };
    let action, logMsg;
    if (mode === 'fast') {
      const saveTokenR = makeSaveToken(userEmail);
      await gmailHelper.sendReply(tokenRow, params, saveTokenR);
      action = 'sent';
      logMsg = `⚡ Auto-reply <strong>sent</strong> to <strong>${emailRow.from_name || emailRow.from_addr}</strong>`;
    } else {
      await gmailHelper.saveDraft(tokenRow, params, saveTokenR);
      action = 'draft';
      logMsg = `🛡️ Draft reply <strong>saved</strong> for <strong>${emailRow.from_name || emailRow.from_addr}</strong>`;
    }
    await stmts.markEmailReplied.run(emailId);
    await stmts.insertLog.run(userEmail, 'green', logMsg);
    await recomputeStats(userEmail);
    res.json({ success: true, action, message: logMsg });
  } catch (err) {
    console.error('[gmail-reply]', err);
    await stmts.insertLog.run(userEmail, 'red', `Reply failed for <strong>${emailRow.from_addr}</strong>: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to send reply.' });
  }
});

router.post('/gmail-action', requireAuth, async (req, res) => {
  const { emailIds, action } = req.body;
  const userEmail = req.user.email;
  if (!emailIds?.length) return res.status(400).json({ error: 'emailIds required.' });
  const tokenRow = await stmts.getToken.get(userEmail);
  // Single saveToken callback shared across all action branches
  const saveTokenA = makeSaveToken(userEmail);
  try {
    let count = 0;
    if (action === 'trash') {
      if (tokenRow) {
        const gmailIds = [];
        for (const id of emailIds) {
          const row = await queryOne('SELECT gmail_id FROM emails WHERE id = ?', id);
          if (row?.gmail_id) gmailIds.push(row.gmail_id);
        }
        if (gmailIds.length) count = await gmailHelper.trashMessages(tokenRow, gmailIds, saveTokenA);
      }
      await markEmailsDeleted(userEmail, emailIds);
      count = count || emailIds.length;
      await stmts.insertLog.run(userEmail, 'red', `Moved <strong>${count}</strong> email${count !== 1 ? 's' : ''} to Bin`);
    }
    if (action === 'restore') {
      if (tokenRow) {
        const gmailIds = [];
        for (const id of emailIds) {
          const row = await queryOne('SELECT gmail_id FROM emails WHERE id = ?', id);
          if (row?.gmail_id) gmailIds.push(row.gmail_id);
        }
        if (gmailIds.length) await gmailHelper.untrashMessages(tokenRow, gmailIds, saveTokenA);
      }
      for (const id of emailIds) {
        await exec('UPDATE emails SET deleted = 0 WHERE user_email = ? AND id = ?', userEmail, id);
      }
      count = emailIds.length;
      await stmts.insertLog.run(userEmail, 'green', `Restored <strong>${count}</strong> email${count !== 1 ? 's' : ''} to Inbox`);
    }
    if (action === 'permanent_delete') {
      if (tokenRow) {
        const gmailIds = [];
        for (const id of emailIds) {
          const row = await queryOne('SELECT gmail_id FROM emails WHERE id = ?', id);
          if (row?.gmail_id) gmailIds.push(row.gmail_id);
        }
        if (gmailIds.length) await gmailHelper.permanentlyDeleteMessages(tokenRow, gmailIds, saveTokenA);
      }
      for (const id of emailIds) {
        await exec('DELETE FROM emails WHERE user_email = ? AND id = ?', userEmail, id);
      }
      count = emailIds.length;
      await stmts.insertLog.run(userEmail, 'red', `Permanently deleted <strong>${count}</strong> email${count !== 1 ? 's' : ''}`);
    }
    if (action === 'archive') {
      if (tokenRow) {
        const gmailIds = [];
        for (const id of emailIds) {
          const row = await queryOne('SELECT gmail_id FROM emails WHERE id = ?', id);
          if (row?.gmail_id) gmailIds.push(row.gmail_id);
        }
        if (gmailIds.length) await gmailHelper.archiveMessages(tokenRow, gmailIds, saveTokenA);
      }
      for (const id of emailIds) {
        await exec('UPDATE emails SET archived = 1 WHERE user_email = ? AND id = ?', userEmail, id);
      }
      count = emailIds.length;
      await stmts.insertLog.run(userEmail, 'amber', `Archived <strong>${count}</strong> email${count !== 1 ? 's' : ''}`);
    }
    await recomputeStats(userEmail);
    res.json({ success: true, count });
  } catch (err) {
    console.error('[gmail-action]', err);
    res.status(500).json({ error: err.message || 'Action failed.' });
  }
});

// ── Undo last auto-archive ────────────────────────────────────
router.post('/undo-auto-archive', requireAuth, async (req, res) => {
  const email = req.user.email;
  const tokenRow = await stmts.getToken.get(email);
  if (!tokenRow) return res.status(400).json({ error: 'Gmail not connected.' });
  try {
    const row = await queryOne(
      "SELECT setting_value FROM user_settings WHERE user_email = ? AND setting_key = 'last_auto_archived'",
      email
    );
    if (!row || !row.setting_value) {
      return res.status(404).json({ error: 'No recent auto-archive to undo.' });
    }
    const gmailIds = JSON.parse(row.setting_value);
    if (!gmailIds.length) return res.status(404).json({ error: 'Nothing to restore.' });

    const saveTokenU = makeSaveToken(email);
    await gmailHelper.unarchiveMessages(tokenRow, gmailIds, saveTokenU);

    // Mark emails as unarchived in local DB
    for (const gmailId of gmailIds) {
      await exec('UPDATE emails SET archived = 0 WHERE user_email = ? AND gmail_id = ?', email, gmailId);
    }

    // Clear the stored list so this can't be triggered twice
    await exec(
      `UPDATE user_settings SET setting_value = '[]', updated_at = datetime('now')
       WHERE user_email = ? AND setting_key = 'last_auto_archived'`,
      email
    );

    await stmts.insertLog.run(email, 'green',
      `Restored <strong>${gmailIds.length}</strong> email${gmailIds.length !== 1 ? 's' : ''} to Inbox`
    );
    await recomputeStats(email);
    res.json({ success: true, restored: gmailIds.length });
  } catch (err) {
    console.error('[undo-auto-archive]', err);
    res.status(500).json({ error: err.message || 'Undo failed.' });
  }
});
router.post('/gmail-disconnect', requireAuth, async (req, res) => {
  const email = req.user.email;
  const tokenRow = await stmts.getToken.get(email);
  if (tokenRow?.access_token) await gmailHelper.revokeToken(tokenRow.access_token).catch(() => {});
  await stmts.deleteToken.run(email);
  // Clear cached data from the previously connected Gmail account so that
  // connecting a different Gmail account afterwards starts from a clean
  // slate instead of showing the old account's messages/stats.
  await exec('DELETE FROM emails WHERE user_email = ?', email);
  await exec('DELETE FROM agent_stats WHERE user_email = ?', email);
  await exec("DELETE FROM user_settings WHERE user_email = ? AND setting_key = 'last_auto_archived'", email);
  await stmts.insertLog.run(email, 'amber', 'Gmail disconnected');
  res.json({ success: true });
});


router.post('/gmail-generate-reply', requireAuth, async (req, res) => {
  const { emailId, replyTemplate, customContext } = req.body;
  const userEmail = req.user.email;
  if (!emailId) return res.status(400).json({ error: 'emailId required.' });
  const emailRow = await queryOne('SELECT * FROM emails WHERE id = ? AND user_email = ?', emailId, userEmail);
  if (!emailRow) return res.status(404).json({ error: 'Email not found.' });
  try {
    const userRow = await stmts.getUserByEmail.get(userEmail);
    const senderFirstName = userRow?.first_name || '';
    const replyBody = await generateReply({
      subject: emailRow.subject, snippet: emailRow.snippet, fromName: emailRow.from_name,
      replyTemplate: customContext ? `Context from user: ${customContext}\n\n${replyTemplate || ''}` : replyTemplate,
      senderFirstName,
    });
    res.json({ success: true, reply: replyBody, email: { from: emailRow.from_name || emailRow.from_addr, subject: emailRow.subject, snippet: emailRow.snippet } });
  } catch (err) {
    console.error('[gmail-generate-reply]', err);
    res.status(500).json({ error: err.message || 'Failed to generate reply.' });
  }
});

module.exports = router;