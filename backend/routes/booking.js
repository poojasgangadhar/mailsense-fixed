// backend/routes/booking.js
// ─────────────────────────────────────────────────────────────
//  Phase 1 of the AI Appointment Booking Module.
//  Wires together: mistral.detectMeetingIntent (called from
//  routes/gmail.js during fetch) → scheduling.computeAvailableSlots
//  → calendar.createEvent, behind an approval step that reuses the
//  same Safe Mode pattern as email auto-replies.
// ─────────────────────────────────────────────────────────────
const express = require('express');
const { stmts } = require('../db');
const { requireAuth } = require('../middleware/auth');
const calendarHelper = require('../calendar');
const schedulingHelper = require('../scheduling');
const gmailHelper = require('../gmail');

const router = express.Router();

// ── Get/update this user's availability settings ──────────────
router.get('/booking-settings', requireAuth, async (req, res) => {
  try {
    const row = await stmts.getAvailability.get(req.user.email);
    res.json({ settings: schedulingHelper.parseSettingsRow(row) });
  } catch (err) {
    console.error('[booking-settings:get]', err);
    res.status(500).json({ error: 'Failed to load booking settings' });
  }
});

router.post('/booking-settings', requireAuth, async (req, res) => {
  try {
    const s = { ...schedulingHelper.DEFAULT_SETTINGS, ...req.body };
    await stmts.upsertAvailability.run({
      user_email: req.user.email,
      timezone: s.timezone,
      working_days: JSON.stringify(s.working_days),
      work_start: s.work_start,
      work_end: s.work_end,
      buffer_minutes: s.buffer_minutes,
      default_duration_minutes: s.default_duration_minutes,
      daily_meeting_limit: s.daily_meeting_limit,
      booking_mode: s.booking_mode, // 'approval' | 'auto'
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[booking-settings:post]', err);
    res.status(500).json({ error: 'Failed to save booking settings' });
  }
});

// ── List appointments (default: pending, for the review queue) ──
router.get('/appointments', requireAuth, async (req, res) => {
  try {
    const status = req.query.status || 'pending';
    const rows = await stmts.listAppointments.all(req.user.email, status);
    res.json({
      appointments: rows.map(r => ({ ...r, proposed_slots: safeParse(r.proposed_slots) })),
    });
  } catch (err) {
    console.error('[appointments:list]', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

// ── Approve a pending appointment: books the real Calendar event
//    (with a Google Meet link) and emails the contact a confirmation ──
router.post('/appointments/:id/approve', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;
    const appt = await stmts.getAppointment.get(req.params.id, email);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (appt.status !== 'pending') return res.status(400).json({ error: `Appointment is already ${appt.status}` });

    const { startISO, endISO } = req.body; // the slot the user picked from proposed_slots
    if (!startISO || !endISO) return res.status(400).json({ error: 'startISO and endISO are required' });

    const tokenRow = await stmts.getToken.get(email);
    if (!tokenRow) return res.status(400).json({ error: 'Gmail/Calendar not connected' });
    if (!calendarHelper.hasCalendarScope(tokenRow)) {
      return res.status(400).json({ error: 'Calendar access not yet granted — please reconnect Gmail to enable appointment booking.' });
    }
    const saveToken = (t) => stmts.upsertToken.run({ user_email: email, ...t });

    const settingsRow = await stmts.getAvailability.get(email);
    const settings = schedulingHelper.parseSettingsRow(settingsRow);

    const { eventId, meetLink } = await calendarHelper.createEvent(tokenRow, {
      summary: appt.subject || `Meeting with ${appt.contact_name || appt.contact_email}`,
      description: appt.notes || 'Scheduled via Agentra MailSense',
      startISO, endISO,
      timezone: settings.timezone,
      attendeeEmail: appt.contact_email,
    }, saveToken);

    await stmts.updateAppointmentStatus.run({
      id: appt.id, user_email: email, status: 'confirmed',
      confirmed_start: startISO, confirmed_end: endISO,
      meet_link: meetLink, calendar_event_id: eventId,
    });

    // Send a confirmation reply in the same email thread
    const when = new Date(startISO).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: settings.timezone,
    });
    const body =
      `Hi ${appt.contact_name || ''},\n\n` +
      `You're confirmed for ${when} (${settings.timezone}).\n` +
      (meetLink ? `Google Meet link: ${meetLink}\n\n` : '\n') +
      `Looking forward to it!\n`;
    try {
      await gmailHelper.sendReply(tokenRow, {
        from: email, to: appt.contact_email, subject: `Re: ${appt.subject || 'Meeting'}`,
        messageId: appt.email_id, threadId: appt.thread_id, body,
      }, saveToken);
    } catch (mailErr) {
      console.error('[appointments:approve] confirmation email failed:', mailErr.message);
      // Booking itself already succeeded — don't fail the request over the email.
    }

    await stmts.insertLog.run(email, 'green', `Appointment confirmed with ${appt.contact_email}`);
    res.json({ success: true, meetLink, eventId });
  } catch (err) {
    console.error('[appointments:approve]', err);
    res.status(500).json({ error: 'Failed to approve appointment' });
  }
});

// ── Decline a pending appointment (no calendar event created) ──
router.post('/appointments/:id/decline', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;
    const appt = await stmts.getAppointment.get(req.params.id, email);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    await stmts.updateAppointmentStatus.run({
      id: appt.id, user_email: email, status: 'declined',
      confirmed_start: null, confirmed_end: null, meet_link: null, calendar_event_id: null,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[appointments:decline]', err);
    res.status(500).json({ error: 'Failed to decline appointment' });
  }
});

// ── Cancel a previously confirmed appointment ──────────────────
router.post('/appointments/:id/cancel', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;
    const appt = await stmts.getAppointment.get(req.params.id, email);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    const tokenRow = await stmts.getToken.get(email);
    if (appt.calendar_event_id && tokenRow) {
      await calendarHelper.deleteEvent(tokenRow, appt.calendar_event_id).catch(err =>
        console.error('[appointments:cancel] calendar delete failed:', err.message)
      );
    }
    await stmts.updateAppointmentStatus.run({
      id: appt.id, user_email: email, status: 'cancelled',
      confirmed_start: appt.confirmed_start, confirmed_end: appt.confirmed_end,
      meet_link: appt.meet_link, calendar_event_id: appt.calendar_event_id,
    });
    if (tokenRow && appt.confirmed_start) {
      const saveToken = (t) => stmts.upsertToken.run({ user_email: email, ...t });
      const settingsRow = await stmts.getAvailability.get(email);
      const settings = schedulingHelper.parseSettingsRow(settingsRow);
      const when = new Date(appt.confirmed_start).toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: settings.timezone,
      });
      const body = `Hi ${appt.contact_name || ''},\n\nYour meeting scheduled for ${when} (${settings.timezone}) has been cancelled.\n\nFeel free to reply if you'd like to find a new time.\n`;
      try {
        await gmailHelper.sendEmail(tokenRow, { from: email, to: appt.contact_email, subject: `Cancelled: ${appt.subject || 'Meeting'}`, body }, saveToken);
      } catch (mailErr) {
        console.error('[appointments:cancel] notification email failed:', mailErr.message);
      }
    }
    await stmts.insertLog.run(email, 'amber', `Appointment with ${appt.contact_email} cancelled`);
    res.json({ success: true });
  } catch (err) {
    console.error('[appointments:cancel]', err);
    res.status(500).json({ error: 'Failed to cancel appointment' });
  }
});

// ── Reschedule a previously confirmed appointment to a new time ──
router.post('/appointments/:id/reschedule', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;
    const { startISO, endISO } = req.body;
    if (!startISO || !endISO) return res.status(400).json({ error: 'startISO and endISO are required' });
    const appt = await stmts.getAppointment.get(req.params.id, email);
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (!appt.calendar_event_id) return res.status(400).json({ error: 'This appointment has no linked calendar event to reschedule' });

    const tokenRow = await stmts.getToken.get(email);
    if (!tokenRow) return res.status(400).json({ error: 'Gmail/Calendar not connected' });
    const saveToken = (t) => stmts.upsertToken.run({ user_email: email, ...t });
    const settingsRow = await stmts.getAvailability.get(email);
    const settings = schedulingHelper.parseSettingsRow(settingsRow);

    await calendarHelper.updateEventTime(tokenRow, appt.calendar_event_id, { startISO, endISO, timezone: settings.timezone }, saveToken);
    await stmts.updateAppointmentStatus.run({
      id: appt.id, user_email: email, status: 'confirmed',
      confirmed_start: startISO, confirmed_end: endISO,
      meet_link: appt.meet_link, calendar_event_id: appt.calendar_event_id,
    });

    const when = new Date(startISO).toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: settings.timezone,
    });
    const body = `Hi ${appt.contact_name || ''},\n\nYour meeting has been rescheduled to ${when} (${settings.timezone}).\n` +
      (appt.meet_link ? `Google Meet link (unchanged): ${appt.meet_link}\n` : '') +
      `\nLet me know if this doesn't work for you.\n`;
    try {
      await gmailHelper.sendEmail(tokenRow, { from: email, to: appt.contact_email, subject: `Rescheduled: ${appt.subject || 'Meeting'}`, body }, saveToken);
    } catch (mailErr) {
      console.error('[appointments:reschedule] notification email failed:', mailErr.message);
    }
    await stmts.insertLog.run(email, 'blue', `Appointment with ${appt.contact_email} rescheduled`);
    res.json({ success: true });
  } catch (err) {
    console.error('[appointments:reschedule]', err);
    res.status(500).json({ error: 'Failed to reschedule appointment' });
  }
});

function safeParse(v) { try { return JSON.parse(v); } catch { return []; } }

module.exports = router;
