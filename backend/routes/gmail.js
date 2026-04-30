// backend/routes/gmail.js
const express = require('express');
const { db, stmts, recomputeStats, markEmailsDeleted, queryOne, exec } = require('../db');
const gmailHelper = require('../gmail');
const { classifyEmail, generateReply } = require('../mistral');

const router = express.Router();

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
  const email = req.query.email;
  if (!email) return res.status(400).send('Email required');
  res.redirect(gmailHelper.getAuthUrl(email));
});

router.get('/oauth2callback', async (req, res) => {
  const { code, state: email, error } = req.query;
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';
  if (error) return res.redirect(`${APP_URL}/dashboard.html?gmail=error&reason=${error}`);
  if (!code || !email) return res.redirect(`${APP_URL}/dashboard.html?gmail=error&reason=missing_code`);
  try {
    const tokens = await gmailHelper.exchangeCode(code);
    await stmts.upsertToken.run({
      user_email: email, access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_expiry: tokens.expiry_date ? tokens.expiry_date.toString() : null,
      scope: tokens.scope || '',
    });
    await stmts.insertLog.run(email, 'green', `Gmail connected successfully for <strong>${email}</strong>`);
    res.redirect(`${APP_URL}/dashboard.html?gmail=connected`);
  } catch (err) {
    console.error('[OAuth]', err);
    res.redirect(`${APP_URL}/dashboard.html?gmail=error&reason=token_exchange`);
  }
});

router.post('/gmail-status', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const tokenRow = await stmts.getToken.get(email);
  if (!tokenRow) return res.json({ connected: false });
  const emailRows = await stmts.getEmails.all(email);
  const stats = await recomputeStats(email);
  const logs = await stmts.getLogs.all(email);
  res.json({
    connected: true,
    emails: emailRows.map(formatEmail),
    stats: { total: stats.total, important: stats.important, promo: stats.promo, spam: stats.spam, replied: stats.replied },
    logs: logs.map(l => ({ id: l.id, time: l.created_at.substring(11, 16), dot: l.dot_color, text: l.message })),
  });
});

router.post('/gmail-fetch', async (req, res) => {
  const { email, maxEmails = 100, dateRange = 'all' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const tokenRow = await stmts.getToken.get(email);
  if (!tokenRow) return res.status(400).json({ error: 'Gmail not connected.' });
  try {
    await stmts.insertLog.run(email, 'blue', `Fetching emails from Gmail (${dateRange === 'all' ? 'all time' : dateRange})…`);
    const messages = await gmailHelper.fetchMessages(tokenRow, parseInt(maxEmails), dateRange);
    if (tokenRow.access_token) {
      await stmts.upsertToken.run({
        user_email: email, access_token: tokenRow.access_token,
        refresh_token: tokenRow.refresh_token, token_expiry: tokenRow.token_expiry, scope: tokenRow.scope,
      });
    }
    let newCount = 0;
    for (const msg of messages) {
      const existing = await queryOne('SELECT id, tag FROM emails WHERE id = ?', msg.id);
      let tag = existing?.tag;
      if (!tag) {
        tag = await classifyEmail({ subject: msg.subject, snippet: msg.snippet, fromAddr: msg.from_addr, fromName: msg.from_name, userOwnEmail: email });
        newCount++;
      }
      await stmts.upsertEmail.run({
        id: msg.id, user_email: email, gmail_id: msg.gmail_id, thread_id: msg.thread_id || null,
        from_addr: msg.from_addr || '', from_name: msg.from_name || '',
        subject: msg.subject || '', snippet: msg.snippet || '', body: msg.body || '',
        tag, color: colorForEmail(msg.from_addr), email_time: msg.email_time || '',
      });
    }
    const toArchive = [];
    for (const m of messages) {
      const t = await queryOne('SELECT tag FROM emails WHERE id = ?', m.id);
      if (t?.tag === 'promo' || t?.tag === 'spam') toArchive.push(m.gmail_id);
    }
    if (toArchive.length > 0) {
      await gmailHelper.archiveMessages(tokenRow, toArchive).catch(() => {});
      await stmts.insertLog.run(email, 'amber', `Auto-archived <strong>${toArchive.length}</strong> promo/spam emails`);
    }
    const stats = await recomputeStats(email);
    await stmts.insertLog.run(email, 'green', `Fetched <strong>${messages.length}</strong> emails (${newCount} new, classified)`);
    const allEmails = await stmts.getEmails.all(email);
    const pendingImportant = allEmails.filter(e => e.tag === 'important' && !e.replied && !e.deleted).map(e => e.id);
    res.json({
      success: true, fetched: messages.length, new_classified: newCount, stats,
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
    await stmts.insertLog.run(email, 'red', `Fetch failed: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to fetch emails.' });
  }
});

router.post('/gmail-reply', async (req, res) => {
  const { userEmail, emailId, mode, replyTemplate } = req.body;
  if (!userEmail || !emailId) return res.status(400).json({ error: 'userEmail and emailId required.' });
  const tokenRow = await stmts.getToken.get(userEmail);
  if (!tokenRow) return res.status(400).json({ error: 'Gmail not connected.' });
  const emailRow = await queryOne('SELECT * FROM emails WHERE id = ? AND user_email = ?', emailId, userEmail);
  if (!emailRow) return res.status(404).json({ error: 'Email not found.' });
  if (emailRow.replied) return res.json({ success: true, skipped: true, message: 'Already replied.' });
  try {
    const replyBody = await generateReply({ subject: emailRow.subject, snippet: emailRow.snippet, fromName: emailRow.from_name, replyTemplate });
    const params = { from: userEmail, to: emailRow.from_addr, subject: emailRow.subject, messageId: emailRow.gmail_id, threadId: emailRow.thread_id, body: replyBody };
    let action, logMsg;
    if (mode === 'fast') {
      await gmailHelper.sendReply(tokenRow, params);
      action = 'sent';
      logMsg = `⚡ Auto-reply <strong>sent</strong> to <strong>${emailRow.from_name || emailRow.from_addr}</strong>`;
    } else {
      await gmailHelper.saveDraft(tokenRow, params);
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

router.post('/gmail-action', async (req, res) => {
  const { userEmail, emailIds, action } = req.body;
  if (!userEmail || !emailIds?.length) return res.status(400).json({ error: 'userEmail and emailIds required.' });
  const tokenRow = await stmts.getToken.get(userEmail);
  try {
    let count = 0;
    if (action === 'trash') {
      if (tokenRow) {
        const gmailIds = [];
        for (const id of emailIds) {
          const row = await queryOne('SELECT gmail_id FROM emails WHERE id = ?', id);
          if (row?.gmail_id) gmailIds.push(row.gmail_id);
        }
        if (gmailIds.length) count = await gmailHelper.trashMessages(tokenRow, gmailIds);
      }
      await markEmailsDeleted(userEmail, emailIds);
      count = count || emailIds.length;
      await stmts.insertLog.run(userEmail, 'red', `Moved <strong>${count}</strong> email${count !== 1 ? 's' : ''} to Bin`);
    }
    if (action === 'archive') {
      if (tokenRow) {
        const gmailIds = [];
        for (const id of emailIds) {
          const row = await queryOne('SELECT gmail_id FROM emails WHERE id = ?', id);
          if (row?.gmail_id) gmailIds.push(row.gmail_id);
        }
        if (gmailIds.length) await gmailHelper.archiveMessages(tokenRow, gmailIds);
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

router.post('/gmail-disconnect', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });
  const tokenRow = await stmts.getToken.get(email);
  if (tokenRow?.access_token) await gmailHelper.revokeToken(tokenRow.access_token).catch(() => {});
  await stmts.deleteToken.run(email);
  await stmts.insertLog.run(email, 'amber', 'Gmail disconnected');
  res.json({ success: true });
});

router.post('/gmail-generate-reply', async (req, res) => {
  const { userEmail, emailId, replyTemplate, customContext } = req.body;
  if (!userEmail || !emailId) return res.status(400).json({ error: 'userEmail and emailId required.' });
  const emailRow = await queryOne('SELECT * FROM emails WHERE id = ? AND user_email = ?', emailId, userEmail);
  if (!emailRow) return res.status(404).json({ error: 'Email not found.' });
  try {
    const replyBody = await generateReply({
      subject: emailRow.subject, snippet: emailRow.snippet, fromName: emailRow.from_name,
      replyTemplate: customContext ? `Context from user: ${customContext}\n\n${replyTemplate || ''}` : replyTemplate,
    });
    res.json({ success: true, reply: replyBody, email: { from: emailRow.from_name || emailRow.from_addr, subject: emailRow.subject, snippet: emailRow.snippet } });
  } catch (err) {
    console.error('[gmail-generate-reply]', err);
    res.status(500).json({ error: err.message || 'Failed to generate reply.' });
  }
});

module.exports = router;