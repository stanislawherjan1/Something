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

## `repeat`

`"none"` (default) / `"daily"` / `"weekly"`

## Timezone

All times are UTC. **Tell the user this.** If they say "9am", clarify: "9am UTC, which is 11am Warsaw time — is that right?"

## Other tools

```json
// list_reminders — no params, returns pending sorted by due, relative time (+2h, -30m)
{}

// cancel_reminder — get id from list_reminders first
{ "id": "r_a1b2c3d4" }
```
