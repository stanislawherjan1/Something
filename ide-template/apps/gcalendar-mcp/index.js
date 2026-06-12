/**
 * Google Calendar MCP Server
 *
 * Reuses Google Docs OAuth credentials (catalog `credentialsFrom: "gdocs"`),
 * so all auth env vars share the GDOCS_ prefix. Refresh token must include
 * `https://www.googleapis.com/auth/calendar` scope.
 *
 * Env vars (set by workspace-api at spawn time):
 *   GDOCS_CLIENT_ID
 *   GDOCS_CLIENT_SECRET
 *   GDOCS_REFRESH_TOKEN
 *   GWORKSPACE_ALLOW_WRITE  — gates create_event / update_event / delete_event.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   list_calendars   — every calendar in the user's CalendarList
 *   list_events      — events in a date range, single-event expansion of recurring
 *   get_event        — one event by id
 *   create_event     — events.insert (sendUpdates configurable)
 *   update_event     — events.patch (sparse, never nulls unspecified fields)
 *   delete_event     — events.delete (HTTP 204, no body)
 * ─────────────────────────────────────────────
 */

import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGoogleApiClient } from '../_shared/google-oauth.js';
import { loadCredentials } from '../_shared/broker-client.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GDOCS_CLIENT_ID;
const CLIENT_SECRET = process.env.GDOCS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GDOCS_REFRESH_TOKEN;
const WRITES_OK     = String(process.env.GWORKSPACE_ALLOW_WRITE || '').toLowerCase() === 'yes';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gcalendar-mcp] Missing OAuth config. Activate Google Workspace first.\n');
  process.exit(1);
}

const api = createGoogleApiClient({
  clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN,
});

function requireWrite() {
  if (!WRITES_OK) {
    throw new Error(
      'Calendar write access is disabled in this workspace. ' +
      'Open Integrations → Google Workspace → Settings (gear) and set ' +
      '"Allow bot to modify your Google Workspace data" to Yes.',
    );
  }
}

function calPath(calendarId = 'primary') {
  return `${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}`;
}

// Strip the noisy fields from an event before returning to the model so the
// chat doesn't drown in raw API response.
function compactEvent(ev) {
  if (!ev) return null;
  return {
    id:           ev.id,
    status:       ev.status,
    summary:      ev.summary,
    description:  ev.description,
    location:     ev.location,
    start:        ev.start,    // { dateTime, timeZone } or { date }
    end:          ev.end,
    all_day:      Boolean(ev.start?.date),
    attendees:    (ev.attendees || []).map(a => ({
      email:           a.email,
      display_name:    a.displayName,
      response_status: a.responseStatus,
      organizer:       Boolean(a.organizer),
      optional:        Boolean(a.optional),
    })),
    recurrence:   ev.recurrence,
    organizer:    ev.organizer?.email,
    creator:      ev.creator?.email,
    html_link:    ev.htmlLink,
    hangout_link: ev.hangoutLink,
    updated:      ev.updated,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_calendars',
    description: 'List every calendar in the user\'s Calendar list (including subscribed and shared). Returns id (use as calendar_id), summary, timezone, primary flag, accessRole.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_events',
    description:
      'List events from a calendar in a date range. Recurring events are expanded into individual instances. ' +
      'Defaults: calendar_id="primary", time range covers the next 7 days from now.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', default: 'primary', description: 'From list_calendars; "primary" for the user\'s main calendar.' },
        time_min:    { type: 'string', description: 'RFC 3339 timestamp, e.g. "2026-05-08T00:00:00+02:00" or "2026-05-08T00:00:00Z". Default: now.' },
        time_max:    { type: 'string', description: 'RFC 3339 timestamp. Default: 7 days after time_min.' },
        q:           { type: 'string', description: 'Free-text search across summary, description, location, attendees.' },
        max_results: { type: 'number', default: 50, description: 'Max events (max 2500).' },
      },
    },
  },
  {
    name: 'get_event',
    description: 'Fetch a single event by id. Returns full event details.',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: {
        calendar_id: { type: 'string', default: 'primary' },
        event_id:    { type: 'string' },
      },
    },
  },
  {
    name: 'create_event',
    description:
      'Create a new event. For timed events provide both `start.dateTime` and `end.dateTime` as RFC 3339 with offset (e.g. "2026-05-09T09:00:00+02:00"). ' +
      'For all-day events use `start.date` / `end.date` (YYYY-MM-DD; end is exclusive — a single-day event has end one day after start). ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['summary', 'start', 'end'],
      properties: {
        calendar_id: { type: 'string', default: 'primary' },
        summary:     { type: 'string', description: 'Event title.' },
        description: { type: 'string' },
        location:    { type: 'string' },
        start: {
          type: 'object',
          description: 'Either { dateTime, timeZone? } for timed events or { date } for all-day.',
          properties: {
            dateTime: { type: 'string' },
            date:     { type: 'string' },
            timeZone: { type: 'string', description: 'IANA name like "Europe/Warsaw". Required for recurring events.' },
          },
        },
        end: {
          type: 'object',
          properties: {
            dateTime: { type: 'string' },
            date:     { type: 'string' },
            timeZone: { type: 'string' },
          },
        },
        attendees: {
          type: 'array',
          items: {
            type: 'object',
            required: ['email'],
            properties: {
              email:        { type: 'string' },
              display_name: { type: 'string' },
              optional:     { type: 'boolean' },
            },
          },
        },
        recurrence: {
          type: 'array',
          items: { type: 'string' },
          description: 'RRULE/EXRULE/RDATE/EXDATE strings, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. timeZone required in start/end.',
        },
        send_updates: {
          type: 'string',
          enum: ['all', 'externalOnly', 'none'],
          default: 'none',
          description: 'Whether to email invitees. "none" stays quiet (default), "all" notifies everyone.',
        },
      },
    },
  },
  {
    name: 'update_event',
    description:
      'Patch an existing event. Only the fields you specify are updated; everything else is preserved. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: {
        calendar_id: { type: 'string', default: 'primary' },
        event_id:    { type: 'string' },
        summary:     { type: 'string' },
        description: { type: 'string' },
        location:    { type: 'string' },
        start:       { type: 'object' },
        end:         { type: 'object' },
        attendees:   { type: 'array' },
        recurrence:  { type: 'array' },
        send_updates: {
          type: 'string',
          enum: ['all', 'externalOnly', 'none'],
          default: 'none',
        },
      },
    },
  },
  {
    name: 'delete_event',
    description:
      'Delete an event. The event is moved to the calendar\'s Trash and recoverable for ~30 days. ' +
      'Requires write permission (workspace-level toggle).',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: {
        calendar_id: { type: 'string', default: 'primary' },
        event_id:    { type: 'string' },
        send_updates: {
          type: 'string',
          enum: ['all', 'externalOnly', 'none'],
          default: 'none',
        },
      },
    },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

async function handleListCalendars() {
  const data = await api.get(`${CAL_BASE}/users/me/calendarList`);
  return (data.items || []).map(c => ({
    id:           c.id,
    summary:      c.summary,
    description:  c.description,
    timezone:     c.timeZone,
    primary:      Boolean(c.primary),
    access_role:  c.accessRole,
    color:        c.backgroundColor,
  }));
}

async function handleListEvents({ calendar_id = 'primary', time_min, time_max, q, max_results = 50 } = {}) {
  // Default window: now → +7d. Calendar API requires offset/Z on these fields.
  const now = new Date();
  const defaultMin = now.toISOString();
  const defaultMax = new Date(now.getTime() + 7 * 86_400_000).toISOString();

  const data = await api.get(`${calPath(calendar_id)}/events`, {
    query: {
      timeMin:      time_min || defaultMin,
      timeMax:      time_max || defaultMax,
      q,
      singleEvents: 'true',         // expand recurrences — almost always desired
      orderBy:      'startTime',
      maxResults:   Math.min(Number(max_results) || 50, 2500),
    },
  });
  return {
    calendar:   data.summary,
    timezone:   data.timeZone,
    events:     (data.items || []).map(compactEvent),
  };
}

async function handleGetEvent({ calendar_id = 'primary', event_id }) {
  const ev = await api.get(`${calPath(calendar_id)}/events/${encodeURIComponent(event_id)}`);
  return compactEvent(ev);
}

// Translate caller-friendly attendee shape → API shape.
function mapAttendees(arr) {
  return (arr || []).map(a => ({
    email:        a.email,
    displayName:  a.display_name,
    optional:     a.optional,
  })).filter(a => a.email);
}

async function handleCreateEvent({ calendar_id = 'primary', send_updates = 'none', attendees, ...rest }) {
  requireWrite();
  const body = { ...rest };
  if (attendees) body.attendees = mapAttendees(attendees);
  const ev = await api.post(`${calPath(calendar_id)}/events`, body, {
    query: { sendUpdates: send_updates, conferenceDataVersion: '1' },
  });
  return compactEvent(ev);
}

async function handleUpdateEvent({ calendar_id = 'primary', event_id, send_updates = 'none', attendees, ...rest }) {
  requireWrite();
  const body = { ...rest };
  if (attendees) body.attendees = mapAttendees(attendees);
  const ev = await api.patch(`${calPath(calendar_id)}/events/${encodeURIComponent(event_id)}`, body, {
    query: { sendUpdates: send_updates },
  });
  return compactEvent(ev);
}

async function handleDeleteEvent({ calendar_id = 'primary', event_id, send_updates = 'none' }) {
  requireWrite();
  // 204 No Content — helper returns null. Surface a stable success shape.
  await api.delete(`${calPath(calendar_id)}/events/${encodeURIComponent(event_id)}`, {
    query: { sendUpdates: send_updates },
  });
  return { id: event_id, deleted: true };
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gcalendar-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    switch (name) {
      case 'list_calendars': result = await handleListCalendars();           break;
      case 'list_events':    result = await handleListEvents(args || {});    break;
      case 'get_event':      result = await handleGetEvent(args);            break;
      case 'create_event':   result = await handleCreateEvent(args);         break;
      case 'update_event':   result = await handleUpdateEvent(args);         break;
      case 'delete_event':   result = await handleDeleteEvent(args);         break;
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[gcalendar-mcp] Ready\n');
