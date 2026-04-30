// backend/routes/gmail.js
// ─────────────────────────────────────────────────────────────
//  Gmail routes: OAuth, fetch, classify, reply, action, status
// ─────────────────────────────────────────────────────────────
const express = require('express');
const { db, stmts, recomputeStats, markEmailsDeleted, queryOne, exec } = require('../db');
const gmailHelper = require('../gmail');
const { classifyEmail, generateReply } = require('../mistral');

const router = express.Router();

// ── Avatar color palette ──────────────────────────────────────
const AVATAR_COLORS = [
  '#4f6ef7','#2dd4bf','#f59e0b','#f87171',
  '#a78bfa','#34d399','#fb7185','#60a5fa',
];
function colorForEmail(email = '') {
  let hash = 0;
  for (const c of email) hash = c.charCodeAt(0) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ── Helper: format emails for frontend ───────────────────────
function formatEmail(row) {
  return {
    id:       row.id,
    gmail_id: row.gmail_id,
    from:     row.from_name || row.from_addr || 'Unknown',
    subject:  row.subject   || '(no subject)',
    snippet:  row.snippet   || '',
    tag:      row.tag       || 'important',
    color:    row.color     || '#4f6ef7',
    time:     row.email_time || '',
    replied:  !!row.replied,
    archived: !!row.archived,
    deleted:  !!row.deleted,
  };
}

// ─── GET /api/gmail-auth?email=xxx ───────────────────────────
// Redirect user to Google consent screen
router.get('/gmail-auth', (req, res) => {
  const email = req.query.email;
  if (!email) return res.status(400).send('Email required');
  const url = gmailHelper.getAuthUrl(email);
  res.redirect(url);
});

// ─── GET /api/oauth2callback ──────────────────────────────────
// Google redirects here after user grants permission
router.get('/oauth2callback', async (req, res) => {
  const { code, state: email, error } = req.query;
  const APP_URL = process.env.APP_URL || 'http://localhost:3000';

  if (error) {
    console.error('[OAuth] Error:', error);
    return res.redirect(`${APP_URL}/dashboard.html?gmail=error&reason=${error}`);
  }
  if (!code || !email) {
    return res.redirect(`${APP_URL}/dashboard.html?gmail=error&reason=missing_code`);
  }

  try {
    const tokens = await gmailHelper.exchangeCode(code);
    stmts.upsertToken.run({
      user_email:    email,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      token_expiry:  tokens.expiry_date ? tokens.expiry_date.toString() : null,
      scope:         tokens.scope || '',
    });

    stmts.insertLog.run(email, 'green', `Gmail connected successfully for <strong>${email}</strong>`);
    res.redirect(`${APP_URL}/dashboard.html?gmail=connected`);
  } catch (err) {
    console.error('[OAuth] Token exchange error:', err);
    res.redirect(`${APP_URL}/dashboard.html?gmail=error&reason=token_exchange`);
  }
});

// ─── POST /api/gmail-status ───────────────────────────────────
// Returns connection status + cached emails + stats
router.post('/gmail-status', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  const tokenRow = stmts.getToken.get(email);
  if (!tokenRow) return res.json({ connected: false });

  const emailRows = stmts.getEmails.all(email);
  const stats     = recomputeStats(email);

  res.json({
    connected: true,
    emails:    emailRows.map(formatEmail),
    stats: {
      total:     stats.total,
      important: stats.important,
      promo:     stats.promo,
      spam:      stats.spam,
      replied:   stats.replied,
    },
    logs: stmts.getLogs.all(email).map(l => ({
      id:   l.id,
      time: l.created_at.substring(11, 16),
      dot:  l.dot_color,
      text: l.message,
    })),
  });
});

// ─── POST /api/gmail-fetch ────────────────────────────────────
// Fetch + classify emails from Gmail
router.post('/gmail-fetch', async (req, res) => {
  const { email, maxEmails = 100, dateRange = 'all' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  const tokenRow = stmts.getToken.get(email);
  if (!tokenRow) return res.status(400).json({ error: 'Gmail not connected.' });

  try {
    const rangeLabel = dateRange === 'all' ? 'all time' : dateRange;
    stmts.insertLog.run(email, 'blue', `Fetching emails from Gmail (${rangeLabel})…`);

    const messages = await gmailHelper.fetchMessages(tokenRow, parseInt(maxEmails), dateRange);

    // Update token if refreshed
    if (tokenRow.access_token) {
      stmts.upsertToken.run({
        user_email:    email,
        access_token:  tokenRow.access_token,
        refresh_token: tokenRow.refresh_token,
        token_expiry:  tokenRow.token_expiry,
        scope:         tokenRow.scope,
      });
    }

    let newCount = 0;
    for (const msg of messages) {
      // Check if already classified
      const existing = queryOne('SELECT id, tag FROM emails WHERE id = ?', msg.id);

      let tag = existing?.tag;
      if (!tag) {
        tag = await classifyEmail({
          subject:      msg.subject,
          snippet:      msg.snippet,
          fromAddr:     msg.from_addr,
          fromName:     msg.from_name,
          userOwnEmail: email,   // ← pass user's own email to avoid self-spam
        });
        newCount++;
      }

      stmts.upsertEmail.run({
        id:         msg.id,
        user_email: email,
        gmail_id:   msg.gmail_id,
        thread_id:  msg.thread_id || null,
        from_addr:  msg.from_addr || '',
        from_name:  msg.from_name || '',
        subject:    msg.subject   || '',
        snippet:    msg.snippet   || '',
        body:       msg.body      || '',
        tag,
        color:      colorForEmail(msg.from_addr),
        email_time: msg.email_time || '',
      });
    }

    // Auto-archive promo + spam in Gmail
    const toArchive = messages
      .filter(m => {
        const t = queryOne('SELECT tag FROM emails WHERE id = ?', m.id)?.tag;
        return t === 'promo' || t === 'spam';
      })
      .map(m => m.gmail_id);

    if (toArchive.length > 0) {
      await gmailHelper.archiveMessages(tokenRow, toArchive).catch(() => {});
      stmts.insertLog.run(email, 'amber', `Auto-archived <strong>${toArchive.length}</strong> promo/spam emails`);
    }

    const stats = recomputeStats(email);
    stmts.insertLog.run(
      email, 'green',
      `Fetched <strong>${messages.length}</strong> emails (${newCount} new, classified)`
    );

    // Return full email list and pending important emails so frontend
    // can use fresh data immediately (avoids stale React state bug)
    const allEmails = stmts.getEmails.all(email);
    const pendingImportant = allEmails
      .filter(e => e.tag === 'important' && !e.replied && !e.deleted)
      .map(e => e.id);

    res.json({
      success: true,
      fetched: messages.length,
      new_classified: newCount,
      stats,
      emails: allEmails.map(row => ({
        id:       row.id,
        gmail_id: row.gmail_id,
        from:     row.from_name || row.from_addr || 'Unknown',
        subject:  row.subject   || '(no subject)',
        snippet:  row.snippet   || '',
        body:     row.body      || '',
        tag:      row.tag       || 'important',
        color:    row.color     || '#4f6ef7',
        time:     row.email_time || '',
        replied:  !!row.replied,
        archived: !!row.archived,
        deleted:  !!row.deleted,
      })),
      pendingImportant,  // list of IDs needing auto-reply
    });
  } catch (err) {
    console.error('[gmail-fetch]', err);
    stmts.insertLog.run(email, 'red', `Fetch failed: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to fetch emails.' });
  }
});

// ─── POST /api/gmail-reply ────────────────────────────────────
// Auto-reply (Fast Mode) or save Draft (Safe Mode)
router.post('/gmail-reply', async (req, res) => {
  const { userEmail, emailId, mode, replyTemplate } = req.body;
  if (!userEmail || !emailId) return res.status(400).json({ error: 'userEmail and emailId required.' });

  const tokenRow = stmts.getToken.get(userEmail);
  if (!tokenRow) return res.status(400).json({ error: 'Gmail not connected.' });

  const emailRow = queryOne('SELECT * FROM emails WHERE id = ? AND user_email = ?', emailId, userEmail);
  if (!emailRow) return res.status(404).json({ error: 'Email not found.' });
  if (emailRow.replied) return res.json({ success: true, skipped: true, message: 'Already replied.' });

  try {
    const replyBody = await generateReply({
      subject:       emailRow.subject,
      snippet:       emailRow.snippet,
      fromName:      emailRow.from_name,
      replyTemplate: replyTemplate,
    });

    const params = {
      from:      userEmail,
      to:        emailRow.from_addr,
      subject:   emailRow.subject,
      messageId: emailRow.gmail_id,
      threadId:  emailRow.thread_id,
      body:      replyBody,
    };

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

    stmts.markEmailReplied.run(emailId);
    stmts.insertLog.run(userEmail, 'green', logMsg);
    recomputeStats(userEmail);

    res.json({ success: true, action, message: logMsg });
  } catch (err) {
    console.error('[gmail-reply]', err);
    stmts.insertLog.run(userEmail, 'red', `Reply failed for <strong>${emailRow.from_addr}</strong>: ${err.message}`);
    res.status(500).json({ error: err.message || 'Failed to send reply.' });
  }
});

// ─── POST /api/gmail-action ───────────────────────────────────
// Bulk actions: trash, archive
router.post('/gmail-action', async (req, res) => {
  const { userEmail, emailIds, action } = req.body;
  if (!userEmail || !emailIds?.length) return res.status(400).json({ error: 'userEmail and emailIds required.' });

  const tokenRow = stmts.getToken.get(userEmail);

  try {
    let count = 0;

    if (action === 'trash') {
      if (tokenRow) {
        const gmailIds = emailIds.map(id => queryOne('SELECT gmail_id FROM emails WHERE id = ?', id)?.gmail_id).filter(Boolean);
        if (gmailIds.length) {
          count = await gmailHelper.trashMessages(tokenRow, gmailIds);
        }
      }
      markEmailsDeleted(userEmail, emailIds);
      count = count || emailIds.length;
      stmts.insertLog.run(userEmail, 'red', `Moved <strong>${count}</strong> email${count !== 1 ? 's' : ''} to Bin`);
    }

    if (action === 'archive') {
      if (tokenRow) {
        const gmailIds = emailIds.map(id =>
          db.prepare('SELECT gmail_id FROM emails WHERE id = ?').get(id)?.gmail_id
        ).filter(Boolean);
        if (gmailIds.length) {
          await gmailHelper.archiveMessages(tokenRow, gmailIds);
        }
      }
      db.prepare(`UPDATE emails SET archived = 1 WHERE user_email = ? AND id IN (SELECT value FROM json_each(?))`).run(userEmail, JSON.stringify(emailIds));
      count = emailIds.length;
      stmts.insertLog.run(userEmail, 'amber', `Archived <strong>${count}</strong> email${count !== 1 ? 's' : ''}`);
    }

    recomputeStats(userEmail);
    res.json({ success: true, count });
  } catch (err) {
    console.error('[gmail-action]', err);
    res.status(500).json({ error: err.message || 'Action failed.' });
  }
});

// ─── POST /api/gmail-disconnect ──────────────────────────────
router.post('/gmail-disconnect', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required.' });

  const tokenRow = stmts.getToken.get(email);
  if (tokenRow?.access_token) {
    await gmailHelper.revokeToken(tokenRow.access_token).catch(() => {});
  }
  stmts.deleteToken.run(email);
  stmts.insertLog.run(email, 'amber', 'Gmail disconnected');

  res.json({ success: true });
});


// ─── POST /api/gmail-generate-reply ──────────────────────────
// Generate a preview of an AI reply WITHOUT sending it
// Used by Safe Mode "preview & confirm" and Fast Mode "analyze" views
router.post('/gmail-generate-reply', async (req, res) => {
  const { userEmail, emailId, replyTemplate, customContext } = req.body;
  if (!userEmail || !emailId) return res.status(400).json({ error: 'userEmail and emailId required.' });

  const emailRow = queryOne('SELECT * FROM emails WHERE id = ? AND user_email = ?', emailId, userEmail);
  if (!emailRow) return res.status(404).json({ error: 'Email not found.' });

  try {
    const { generateReply } = require('../mistral');
    const replyBody = await generateReply({
      subject:       emailRow.subject,
      snippet:       emailRow.snippet,
      fromName:      emailRow.from_name,
      replyTemplate: customContext
        ? `Context from user: ${customContext}

${replyTemplate || ''}`
        : replyTemplate,
    });
    res.json({ success: true, reply: replyBody, email: {
      from:    emailRow.from_name || emailRow.from_addr,
      subject: emailRow.subject,
      snippet: emailRow.snippet,
    }});
  } catch (err) {
    console.error('[gmail-generate-reply]', err);
    res.status(500).json({ error: err.message || 'Failed to generate reply.' });
  }
});

module.exports = router;
