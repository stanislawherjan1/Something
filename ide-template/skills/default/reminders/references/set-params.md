# `set_reminder` — params reference

## Preferred (structured)

```json
{
  "title": "Check Meta ads",
  "description": "CPA was high yesterday — pull yesterday's performance and flag campaigns above the threshold.",
  "due": "in 3 hours",
  "repeat": "none"
}
```

## Legacy (single message)

Still works. UI auto-splits on `\n`, ` — `, or `: `.

```json
{
  "message": "Check Meta ads — CPA was high yesterday",
  "due": "in 3 hours"
}
```

## Writing a good title + description

**Title (≤ ~60 chars).** Imperative and self-contained — user should know what to do from the title alone.

- ✅ "Send Q3 report to acme"
- ✅ "Call John about the contract"
- ✅ "Pay invoice INV-1042"
- ❌ "Q3" (too vague)
- ❌ "I should remember to send the Q3 report to acme by EOW because the board meeting" (cram everything into title — this is description territory)

**Description (optional).** The "why now" / "what to include" / "who is waiting". One or two sentences. Skip if title is self-explanatory.

**When in doubt, title only.** Easy to add description later by re-creating; cluttered descriptions hurt the dashboard.

## `due` formats accepted

- `"in 30 minutes"` / `"in 2 hours"` / `"in 3 days"`
- `"tomorrow at 10:00"` / `"tomorrow at 9am"`
- ISO 8601: `"2026-04-17T15:00:00Z"` (always UTC)

## Recurrence

Pick the simplest form that fits.

**Shortcut — `repeat`:** `"none"` (default) · `"hourly"` · `"daily"` · `"weekly"` · `"monthly"`.
Time-of-day and day-of-month come from `due`. E.g. daily at 9am → `{ "due": "tomorrow at 9am", "repeat": "daily" }`.

**Advanced — `recur` object** (overrides `repeat`). All times **UTC**.

| You want | `recur` |
|---|---|
| every hour | `{ "type":"interval", "every":1, "unit":"hours" }` |
| every 30 minutes | `{ "type":"interval", "every":30, "unit":"minutes" }` |
| every 2 days | `{ "type":"interval", "every":2, "unit":"days" }` |
| Mon/Wed/Fri at 09:00 | `{ "type":"weekly", "days":["mon","wed","fri"], "at":"09:00" }` |
| every weekday at 08:00 | `{ "type":"weekly", "days":["mon","tue","wed","thu","fri"], "at":"08:00" }` |
| 1st of each month at 08:00 | `{ "type":"monthly", "day":1, "at":"08:00" }` |
| last day of month at 17:00 | `{ "type":"monthly", "day":"last", "at":"17:00" }` |

`unit` ∈ `minutes` `hours` `days` `weeks`. Weekdays are 3-letter (`mon`…`sun`). `at` is `"HH:MM"` UTC.

**Bounds** (optional — add to any `recur`): `"until":"<ISO>"` and/or `"count":N` (max total fires).
- every hour until 6pm today → `{ "type":"interval", "every":1, "unit":"hours", "until":"2026-06-15T18:00:00Z" }`
- ping me 3×, every 10 min → `{ "type":"interval", "every":10, "unit":"minutes", "count":3 }`

**How `due` interacts with recurrence:**
- **interval** → `due` is the FIRST fire, and sets the time-of-day for day/week intervals. "every 2 hours starting now" → `"due":"in 2 hours"`. "every day at 9am" → `"due":"tomorrow at 9am"` + `repeat:"daily"`.
- **weekly / monthly** → the first fire **snaps automatically** to the next matching slot. Just pass a near-future `due` (e.g. `"in 1 minute"`) plus the `recur` — don't hand-compute the first occurrence.

**Floor:** the monitor ticks ~every 60s, so intervals below ~1 minute aren't meaningful.

## Timezone

All times are UTC. **Tell the user this.** If they say "9am", clarify: "9am UTC, which is 11am Warsaw time — is that right?" When you confirm a *recurring* reminder, state **both** the recurrence and the next concrete fire in their local zone — e.g. "every Mon/Wed/Fri at 09:00 UTC (11:00 Warsaw), next this Friday."

## Other tools

```json
// list_reminders — no params, returns pending sorted by due, relative time (+2h, -30m)
{}

// cancel_reminder — get id from list_reminders first
{ "id": "r_a1b2c3d4" }
```
