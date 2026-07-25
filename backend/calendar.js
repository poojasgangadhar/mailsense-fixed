// backend/calendar.js
// ─────────────────────────────────────────────────────────────
//  Google Calendar helpers — Phase 1 of the AI Appointment
//  Booking Module. Reuses the SAME OAuth token as Gmail (the
//  Calendar scopes below just need to be added to the existing
//  Google Cloud OAuth consent screen — no new credentials needed).
// ─────────────────────────────────────────────────────────────
const { google } = require('googleapis');
require('dotenv').config();

// Add these to backend/gmail.js's SCOPES array so a single Gmail
// connect/reconnect also grants Calendar access:
//   'https://www.googleapis.com/auth/calendar'
//   'https://www.googleapis.com/auth/calendar.events'
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Same pattern as gmail.js's buildAuthorizedClient — reuses the
// stored gmail_tokens row (access/refresh token), since it's the
// same Google OAuth session with the extra Calendar scopes granted.
function buildAuthorizedClient(tokenRow, saveToken) {
  const oAuth2Client = createOAuth2Client();
  oAuth2Client.setCredentials({
    access_token:  tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expiry_date:   tokenRow.token_expiry ? parseInt(tokenRow.token_expiry) : undefined,
  });
  oAuth2Client.on('tokens', (newTokens) => {
    tokenRow.access_token = newTokens.access_token;
    if (newTokens.refresh_token) tokenRow.refresh_token = newTokens.refresh_token;
    if (newTokens.expiry_date)   tokenRow.token_expiry  = newTokens.expiry_date.toString();
    if (saveToken) {
      saveToken({
        access_token:  tokenRow.access_token,
        refresh_token: tokenRow.refresh_token,
        token_expiry:  tokenRow.token_expiry,
        scope:         tokenRow.scope,
      }).catch(err => console.error('[Calendar] Failed to persist refreshed token:', err.message));
    }
  });
  return oAuth2Client;
}

// ── Check whether the connected account has actually granted Calendar scopes ──
// If a user connected Gmail before Calendar scopes were added to the app,
// their stored token won't include Calendar access until they reconnect.
function hasCalendarScope(tokenRow) {
  const scope = tokenRow.scope || '';
  return scope.includes('calendar');
}

// ── Free/busy check across a time range ───────────────────────
async function getFreeBusy(tokenRow, timeMinISO, timeMaxISO, saveToken) {
  const auth = buildAuthorizedClient(tokenRow, saveToken);
  const cal  = google.calendar({ version: 'v3', auth });
  const res = await cal.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: 'primary' }],
    },
  });
  return res.data.calendars?.primary?.busy || []; // [{start, end}, ...]
}

// ── Create a calendar event with a Google Meet link ───────────
async function createEvent(tokenRow, { summary, description, startISO, endISO, timezone, attendeeEmail }, saveToken) {
  const auth = buildAuthorizedClient(tokenRow, saveToken);
  const cal  = google.calendar({ version: 'v3', auth });

  const res = await cal.events.insert({
    calendarId: 'primary',
    conferenceDataVersion: 1, // required for Google Meet link generation
    sendUpdates: 'all',       // emails the attendee automatically
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: timezone },
      end:   { dateTime: endISO,   timeZone: timezone },
      attendees: attendeeEmail ? [{ email: attendeeEmail }] : [],
      conferenceData: {
        createRequest: {
          requestId: `mailsense-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });

  return {
    eventId: res.data.id,
    meetLink: res.data.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null,
    htmlLink: res.data.htmlLink,
  };
}

// ── Cancel/delete an event (used for cancellations) ───────────
async function deleteEvent(tokenRow, eventId, saveToken) {
  const auth = buildAuthorizedClient(tokenRow, saveToken);
  const cal  = google.calendar({ version: 'v3', auth });
  await cal.events.delete({ calendarId: 'primary', eventId, sendUpdates: 'all' }).catch(err => {
    // Treat "already deleted" as success, not a hard failure
    if (err.code !== 410 && err.code !== 404) throw err;
  });
}

// ── Reschedule an existing event to a new time ────────────────
async function updateEventTime(tokenRow, eventId, { startISO, endISO, timezone }, saveToken) {
  const auth = buildAuthorizedClient(tokenRow, saveToken);
  const cal  = google.calendar({ version: 'v3', auth });
  const res = await cal.events.patch({
    calendarId: 'primary',
    eventId,
    sendUpdates: 'all',
    requestBody: {
      start: { dateTime: startISO, timeZone: timezone },
      end:   { dateTime: endISO,   timeZone: timezone },
    },
  });
  return { eventId: res.data.id, htmlLink: res.data.htmlLink };
}

module.exports = {
  CALENDAR_SCOPES,
  hasCalendarScope,
  getFreeBusy,
  createEvent,
  deleteEvent,
  updateEventTime,
};
