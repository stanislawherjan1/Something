---
name: gcalendar
description: How to use the Google Calendar MCP — list calendars, list events in a range, get/create/update/delete events. Triggers on "calendar", "kalendarz", "umów spotkanie", "schedule a meeting", "check my schedule", "what's on Tuesday", "anuluj spotkanie". Reads always available; create/update/delete need the workspace write toggle.
requires: google-workspace
allowed-tools: mcp__gcalendar__list_calendars, mcp__gcalendar__list_events, mcp__gcalendar__get_event, mcp__gcalendar__create_event, mcp__gcalendar__update_event, mcp__gcalendar__delete_event
---

# Google Calendar Protocol

Calendar is the source of truth for what's planned. When the user says "what's on Tuesday", "schedule a call with Anna", or "move the standup to 10" — go to the API, don't guess.

## Pre-flight

If `mcp__gcalendar__*` aren't available, the integration isn't active. Tell the user to open **Integrations → Google Workspace**. If the refresh token is from before the Workspace bundle expansion, calls return 403 — they need to **Remove → Activate** Google Workspace and re-grant the full scope set.

Default `calendar_id` is `"primary"` (the user's main calendar). Most calls don't need it explicitly.

## Reading events

`list_events { time_min, time_max, q?, calendar_id? }` — RFC 3339 timestamps with offset (`2026-05-09T00:00:00+02:00` or `...Z`). The MCP defaults to "now → +7 days" if you omit the range.

For "what's on Tuesday" / "next week" / "this Friday" — compute the date in the user's timezone (you can read it from `list_calendars` if not sure) and call with explicit `time_min` / `time_max`.

Recurring events come back already expanded into individual instances (`singleEvents=true`).

## Creating events

`create_event` body shape:

```json
{
  "summary": "1:1 with Anna",
  "start": { "dateTime": "2026-05-09T14:00:00+02:00", "timeZone": "Europe/Warsaw" },
  "end":   { "dateTime": "2026-05-09T14:30:00+02:00", "timeZone": "Europe/Warsaw" },
  "description": "Weekly check-in",
  "location": "Google Meet",
  "attendees": [{ "email": "anna@acme.com", "display_name": "Anna" }]
}
```

For all-day events use `start.date` / `end.date` (YYYY-MM-DD) — and **end is exclusive** (a one-day event on May 9 has `end.date = "2026-05-10"`).

**Confirm before creating.** Show the user what's about to land:

> Going to add to **primary**:
> - **1:1 with Anna** · Tue 9 May 14:00–14:30 (Europe/Warsaw)
> - Description: Weekly check-in
> - Attendees: anna@acme.com (will be notified)
> Confirm?

`send_updates` defaults to `"none"` — bot doesn't email anyone unless you explicitly set `"all"`. If the user wants invitees notified, pass `send_updates: "all"`.

## Updating

`update_event` is a **patch** — only the fields you specify change, the rest stay. To move a meeting, send `{ start, end }`. To change attendees, send a complete `attendees` array (not a delta).

Confirm changes too — especially when moving meetings other people are on.

## Deleting

`delete_event` moves the event to Trash (recoverable for ~30 days from Google's UI). Returns `{ deleted: true }`.

Always confirm before delete. For attendee meetings, ask whether to notify invitees (`send_updates`).

## Defensive defaults

- **Always confirm writes** with the resolved date + time + attendees. Date math is where humans hallucinate; `Europe/Warsaw` ≠ `Europe/Berlin` in some weeks of the year.
- **Use timeZone** in start/end for recurring events (the API requires it). For one-off events the offset in `dateTime` is enough.
- **All-day end is exclusive** — the most common bug. A "May 9 holiday" event ends `2026-05-10`.
- **Wrong scope?** Symptom is 403 with "ACCESS_TOKEN_SCOPE_INSUFFICIENT" — tell the user to re-activate Google Workspace.
- **`send_updates` defaults to "none"** — if the user expects attendees to get an email, you must pass `"all"` explicitly.
