// backend/scheduling.js
// ─────────────────────────────────────────────────────────────
//  Phase 1 scheduling engine: turns "AI wants a meeting" into a
//  concrete list of proposable time slots, respecting the user's
//  working hours, buffer time, daily limit, and real Calendar
//  free/busy data.
// ─────────────────────────────────────────────────────────────
const calendarHelper = require('./calendar');

const DEFAULT_SETTINGS = {
  timezone: 'UTC',
  working_days: [1, 2, 3, 4, 5], // Mon–Fri (0=Sun..6=Sat)
  work_start: '09:00',
  work_end: '18:00',
  buffer_minutes: 10,
  default_duration_minutes: 30,
  daily_meeting_limit: 8,
  booking_mode: 'approval',
  meeting_provider: 'google_meet', // 'google_meet' | 'zoom' | 'teams'
};

function parseSettingsRow(row) {
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    timezone: row.timezone || DEFAULT_SETTINGS.timezone,
    working_days: safeParseArray(row.working_days) || DEFAULT_SETTINGS.working_days,
    work_start: row.work_start || DEFAULT_SETTINGS.work_start,
    work_end: row.work_end || DEFAULT_SETTINGS.work_end,
    buffer_minutes: row.buffer_minutes ?? DEFAULT_SETTINGS.buffer_minutes,
    default_duration_minutes: row.default_duration_minutes ?? DEFAULT_SETTINGS.default_duration_minutes,
    daily_meeting_limit: row.daily_meeting_limit ?? DEFAULT_SETTINGS.daily_meeting_limit,
    booking_mode: row.booking_mode || DEFAULT_SETTINGS.booking_mode,
    meeting_provider: row.meeting_provider || DEFAULT_SETTINGS.meeting_provider,
  };
}

function safeParseArray(v) {
  try { return JSON.parse(v); } catch { return null; }
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// ── Very light natural-language date range resolver ───────────
// The AI (mistral.detectMeetingIntent) does the heavy lifting on
// interpreting phrases like "next Friday afternoon" — this just
// turns its structured guess into a search window. If the AI
// couldn't resolve a specific window, we default to the next 7
// days, which covers "this week", "soon", "whenever works", etc.
function resolveSearchWindow(requestedTimeText, now = new Date()) {
  const start = new Date(now);
  const end = new Date(now);
  end.setDate(end.getDate() + 7);
  return { start, end };
}

// ── Compute available slots within a search window ────────────
// Returns an array of { startISO, endISO } candidate slots, newest
// business-hours slots first, filtered against real Calendar
// free/busy data and the daily meeting limit.
async function computeAvailableSlots({ tokenRow, saveToken, settingsRow, durationMinutes, requestedTimeText, maxSlots = 5 }) {
  const settings = parseSettingsRow(settingsRow);
  const duration = durationMinutes || settings.default_duration_minutes;
  const { start, end } = resolveSearchWindow(requestedTimeText);

  const busy = await calendarHelper.getFreeBusy(
    tokenRow,
    start.toISOString(),
    end.toISOString(),
    saveToken
  );
  const busyRanges = busy.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));

  const slots = [];
  const dailyCounts = {};

  // Walk forward in 30-minute increments across the search window,
  // checking each candidate slot against working hours/days, buffer,
  // existing calendar busy blocks, and the daily meeting limit.
  const cursor = new Date(start);
  cursor.setMinutes(Math.ceil(cursor.getMinutes() / 30) * 30, 0, 0);

  while (cursor < end && slots.length < maxSlots) {
    const dayKey = cursor.toISOString().slice(0, 10);
    const dow = cursor.getDay();
    const [wsH, wsM] = settings.work_start.split(':').map(Number);
    const [weH, weM] = settings.work_end.split(':').map(Number);

    const dayStart = new Date(cursor); dayStart.setHours(wsH, wsM, 0, 0);
    const dayEnd = new Date(cursor); dayEnd.setHours(weH, weM, 0, 0);

    const slotStart = new Date(cursor);
    const slotEnd = new Date(slotStart.getTime() + duration * 60000);
    const bufferedStart = new Date(slotStart.getTime() - settings.buffer_minutes * 60000);
    const bufferedEnd = new Date(slotEnd.getTime() + settings.buffer_minutes * 60000);

    const withinWorkingDay = settings.working_days.includes(dow);
    const withinWorkingHours = slotStart >= dayStart && slotEnd <= dayEnd;
    const underDailyLimit = (dailyCounts[dayKey] || 0) < settings.daily_meeting_limit;
    const notInPast = slotStart > new Date();

    const conflictsWithBusy = busyRanges.some(b => overlaps(bufferedStart, bufferedEnd, b.start, b.end));
    const conflictsWithProposed = slots.some(s => overlaps(bufferedStart, bufferedEnd, new Date(s.startISO), new Date(s.endISO)));

    if (withinWorkingDay && withinWorkingHours && underDailyLimit && notInPast && !conflictsWithBusy && !conflictsWithProposed) {
      slots.push({ startISO: slotStart.toISOString(), endISO: slotEnd.toISOString() });
      dailyCounts[dayKey] = (dailyCounts[dayKey] || 0) + 1;
    }

    cursor.setMinutes(cursor.getMinutes() + 30);
  }

  return { slots, settings, duration };
}

// ── Format slots into a human-readable string for email replies ──
function formatSlotsForEmail(slots, timezone) {
  return slots.map(s => {
    const d = new Date(s.startISO);
    return d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: timezone,
    });
  });
}

module.exports = {
  DEFAULT_SETTINGS,
  parseSettingsRow,
  computeAvailableSlots,
  formatSlotsForEmail,
};
