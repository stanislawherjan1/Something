# Team Mode

Team mode turns a single-user workspace into a **collaborative** one: several
people sign in with their Google accounts, each gets a private space alongside
the shared one, and the assistant can route reminders, tasks, and messages to
specific teammates. This document covers the whole system — modes, roster,
files, memory, reminders, tasks, cross-surface relay, Telegram group mode, and
the privacy model.

> Solo workspaces are unaffected: with team mode **off** there are no roles, no
> Workspace/Personal split, and reminders/tasks keep their single-user shape.

---

## 1. Solo vs Collaborative

A workspace is in one of two modes, stored in `.team-config.json` at the project
root and toggled by an admin:

| Mode | What it means |
|------|---------------|
| **Solo** | One operator. Clean single-user workspace — no roles, no file split, no per-recipient routing. |
| **Collaborative** | Multiple teammates sign in. Unlocks the roster, the Workspace/Personal file split, per-user memory, and per-recipient reminders/tasks/relay. |

Toggle: `PUT /api/team/mode { enabled: boolean, mergePersonal?: boolean }`
(admin-only). Enabling is the deliberate gate that surfaces every collaborative
affordance. Turning it **off** while teammates have personal files prompts a
decision (the UI's "disable" modal):

- **Merge** — move the **caller's own** `users/<slug>/` files up into the shared
  workspace (collision-renamed). Never touches anyone else's files.
- **Hide** — leave personal files in place but stop surfacing the split.

The Team dashboard renders the mode card (the "Collaborative workspace"
toggle); `/api/me` and `/api/team` echo the current flag so the sidebar,
role badges, and recipient pickers react live.

---

## 2. Roster & roles

The whitelist lives in `.allowed-emails.json` (array of
`{ email, role, addedAt, addedBy, slug, displayName, telegramChatId, preferredSurface }`)
with an append-only `.allowed-emails.audit.log`. Anyone on the list can sign in
with that Google account; everyone else is refused at auth.

**Roles:**

| Role | Capability |
|------|------------|
| `admin` | Full control — invite, promote/demote, remove, toggle mode, manage every teammate's contact. Sees all files including the `users/` tree. |
| `member` | Signs in and works in the shared space + their own personal space. |
| `observer` | Read-only participant. |

**Endpoints** (all writes are admin-only and rate-limited):

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/team` | Roster + `me: { email, role, isAdmin }` + `teamMode` + `personalFileCount`. |
| `POST` | `/api/team` | Invite `{ email, role? }`. |
| `PATCH` | `/api/team/:email` | Change `role`, or set a teammate's `telegramChatId` / `preferredSurface`. |
| `DELETE` | `/api/team/:email` | Remove a member. |
| `PUT` | `/api/team/mode` | Toggle solo ↔ collaborative. |

**Safeguards:** the first allowed email is auto-bootstrapped as `admin`; the
**last admin** can't be demoted or removed (lockout protection); you can't
change your own role; writes are throttled (5/min/actor) so a stolen session
can't mass-invite.

A private **Telegram chat id** is only readable by an admin or the owner of that
row — it's redacted server-side for everyone else (the `preferredSurface` stays
visible, since it's roster-level info, not a handle).

---

## 3. Identity — slug, name, avatar

Each teammate gets a path-safe **slug** (derived from their email, e.g.
`users/<slug>/`) plus a `displayName` and an avatar. The slug is the stable key
used everywhere a person is referenced: file scope, reminder recipients, task
owners, relay routing. `GET /api/me` returns the caller's
`{ email, slug, role, isAdmin, displayName, teamMode, personalRoot, telegramChatId, preferredSurface }`.

`personalRoot` is `users/<slug>` in team mode (null in solo) — the root of the
caller's private space.

---

## 4. Files — Shared vs Personal

In collaborative mode the file tree splits in two:

- **Shared Files** — everything in the project root (e.g. `Reports/`, shared
  memory, the task board). Everyone sees and edits these. It's the default,
  collaborative space.
- **Personal ("Your") Files** — each teammate's own `users/<slug>/` subtree,
  surfaced as a dedicated sidebar section.

**Actor scoping** (`lib/file-scope.js`) gates every file API call:

- **admin** → everything, including the `users/` tree (system-files toggle).
- **member / observer** → the shared space (anything *not* under `users/`) **plus
  their own** `users/<slug>/...`. Any other `users/<other>/...` path is 403.

The `users/` tree is hidden from the normal file listing (structural) and
revealed to admins only via the system-files toggle. Scoping is enforced
server-side on read, write, move, and delete — the UI just mirrors it.

---

## 5. Memory — Shared vs Yours

Memory splits the same way: `memory/<card>.md` is **shared** (team-wide, in
everyone's prompt); `memory/users/<slug>/<card>.md` is one person's **private**
memory. Solo workspaces are flat — everything in `memory/`, no split.

**Baseline cards, by tier:**

| Card | Tier | Why |
|------|------|-----|
| `AGENT_IDENTITY`, `AGENT_TOOLS`, `RULES`, `INDEX` | **Shared** | The assistant's voice, tool gotchas, hard rules, nav root — same for everyone. |
| `TEAM` (generated) | **Shared** | The roster: who's on the team + how to reach them (see §12). |
| `USER_PROFILE`, `USER_PREFERENCES`, `USER_RELATIONSHIPS`, `USER_REFLECTIONS` | **Private** | About one person — who they are, how *they* like the bot to work, their people, their reflections. |
| `RECENT_WEB`, `RECENT_TELEGRAM` | **Private** | Each person's own rolling conversation snapshot. |

Topic pages (`memory/topics/<slug>.md`) are shared; a private card's overflow
promotes to a **private** topic page under `memory/users/<slug>/topics/`.

**What's loaded into the prompt:** the cached system-prefix loads the shared
`AGENT_*` + `RULES` + `INDEX`, then the **current user's** `USER_PROFILE` +
`USER_PREFERENCES` + recent snapshots from `memory/users/<slug>/` (team mode).
`USER_RELATIONSHIPS` / `USER_REFLECTIONS` are stored private but recalled
on demand, not in the prefix.

**Deciding where a new fact goes** (the `memory-router` skill): ask **"would
this be useful to a DIFFERENT teammate?"**

- **Yes** → Shared (`memory/…`): company facts, project structure, shared
  decisions, conventions, the agent's behaviour.
- **No — it's about this person or their taste** → their private
  `memory/users/<their-slug>/…`: personal preferences, individual working style,
  private context.

**The subtle case — contact/relay metadata is SHARED even though it feels
personal.** A person's **preferred language**, **preferred channel**, and
**Telegram link** are *how others reach them* — another teammate's bot needs
them and can't read private memory — so they live in the shared **roster**
(`memory/TEAM.md`, managed via `/api/team` + `/api/me`), NOT in private
`USER_PREFERENCES`. The "useful to a different teammate?" test classifies them
correctly; the trap is assuming "about one person ⇒ private."

Never fold private memory into a shared card (it would surface in everyone's
prompt), and never write into another teammate's private subtree (actor-scoped
server-side). The Memory dashboard's graph mirrors all this — a **Shared /
Yours** filter, a loop around each cluster, and a teammate's private memory
typically its own island.

---

## 6. Reminders — per-recipient

A reminder is a **timed action the bot performs**, tied to a person. In team
mode the AI infers the recipient from the request (exactly like a relay):

- **Default = the asker** → no recipient arg (a normal self-reminder).
- **Named teammates** → their roster **slugs** (`["jan", "kasia"]`).
- **Everyone** → the `"everyone"` sentinel (a team-wide reminder).

**Permissions:** only an admin can target `"everyone"` or other people; a member
can only remind themselves. If the tool refuses, the bot says an admin is needed
and offers to remind just the asker.

**Delivery routing** when a reminder fires (the monitor expands `"everyone"` to
the live roster):

- The **operator** in the recipient set → fired into their assistant session
  (the brain-frame), so the bot can act on it.
- **Teammates** → `POST /internal/reminder-deliver`, which fans out a web
  notification to each teammate's workspace and a Telegram message if they've
  linked it (operator excluded from this leg). Best-effort per leg.

The board shows each reminder's recipients as avatars; a team-wide reminder
shows everyone's profile pictures.

---

## 7. Tasks — assignment

The task board (`Backlog / In Progress / Done`) is **shared team work** — every
member sees and edits the same board. A task's `owner` records **who's
responsible**, set to a teammate's roster **slug** (the board renders their
profile picture). The AI resolves a name to a slug the same way it resolves a
reminder recipient; the asker is the default owner.

**Assigning a task does NOT notify the teammate** — it only records ownership.
If they should be pinged, that's a relay or a `set_reminder` with `recipient`,
separate from the board. (See [the task board section in ARCHITECTURE](ARCHITECTURE.md) for the store + MCP.)

---

## 8. Cross-surface relay

A teammate can talk *through* the assistant to another teammate. The bot is the
courier:

- From a workspace, the assistant uses `web_send_message` with
  `recipient: <slug>` to deliver into that teammate's workspace (notification +
  chat). By default it routes to the recipient's **preferred surface** (their
  workspace always; their Telegram too if that's their preference and they've
  linked it). The sender can override with `channel: "web" | "telegram"`.
- On **Telegram**, a relay reaches the operator's assistant as an injected
  `[RELAY …]` frame (out-of-band, like a fired reminder): the bot presents it to
  the operator naming the person, and relays the operator's answer back in the
  teammate's language.

The relay always composes a natural, verbatim message — never a robotic
"X asked me to forward this" — and uses the recipient's preferred language.

---

## 9. Telegram linking (per user)

Each teammate can be reached on Telegram once linked:

- `telegramChatId` — the DM chat with the bot. An **admin** can set it from the
  Team card's edit modal; a **teammate** links their own via the "Connect your
  Telegram" prompt (which PATCHes `/api/me`).
- `preferredSurface` — `web` / `telegram` / `both` — the teammate's own choice of
  where they want to be reached. It drives relay + reminder delivery routing.

The chat id is private (redacted to non-admins/non-owners); the preferred
surface is roster-level and visible.

---

## 10. Telegram group mode

Beyond per-user DM linking (§9), the assistant can live **inside a team's Telegram
group** and take part like a teammate — reading every message and **deciding for
itself** when to chime in. No `@mention` is required; it judges relevance from the
conversation, in any language.

### Admission — registered groups

The bot only acts in a **registered** group: an entry under `groups` in
`.team-config.json`, keyed by the group's chat id.

```json
"groups": { "-100…": { "title": "…", "requireMention": false, "beat": "", "members": { "<tg_id>": "<name>" } } }
```

Being *added* to a Telegram group ≠ being *registered*. Telegram lets anyone add
the bot to any group; registration is the explicit "this group is ours, take part
here" record. In an **unregistered** group the bot is a silent member — the watcher
bails on the first message (`isAllowedGroup` is false) and only notes the chat id
to the operator (throttled). Two ways a group gets registered:

- **Auto** — when a **roster member** creates the group or adds the bot, the
  `my_chat_member` update → `POST /internal/group-joined` checks the creator/adder
  against the roster and, on a match, calls `addGroup` (+ re-seeds the bot's reply
  allow-list + notifies the operator). If neither creator nor adder is on the
  roster, it does **not** register.
- **Manual** — an admin via `POST /api/team/telegram-groups { chatId, title }`.

Admission keys on **who added the bot**, not who is in the group. Corollary: if a
teammate adds the bot to a group of outsiders, it registers and becomes active
there — so registering a group is a deliberate "these people are us" decision (the
admin's responsibility, §11).

### The two-stage decision

Every message in a registered group runs a cheap gate, then (maybe) the full brain:

1. **Relevance gate** (Haiku, `group-watcher.js`) — a liberal, language-agnostic
   pre-filter that judges *in context* (the recent thread, including the bot's own
   prior replies), never the last line alone. It drops only obvious noise (a bare
   reaction, two people clearly talking to each other); when unsure, it passes. A
   direct address — `@mention`, a reply to the bot, or the bot's **name** (incl.
   inflected forms) — bypasses the gate outright.
2. **The brain** — on a pass, the **full assistant** answers via the same engine as
   web/1:1 (`runClaudeTurn`), as `actor='team'`. It has the complete 1:1 toolset —
   shared files, shared memory, skills, integrations, reminders — and may act. It
   is the real judge: if it has nothing useful to add it stays **silent** (no
   message, no "typing…"). The cheap gate is deliberately permissive precisely
   because the brain makes the final call.

### Behaviour

- **Per-member identity** — the sender is resolved by their Telegram id against the
  roster, so the bot talks to the actual person (their name, their scope), not a
  generic "team" labelled with a raw Telegram handle. An unknown sender falls back
  to a shared, non-admin `team` actor.
- **Typing & pacing** — Telegram's native "typing…" appears only once the brain
  commits to replying (a silent verdict stays invisible). For a turn that needs
  real work the brain can fire a short, natural heads-up first and its full answer
  after — two messages — instead of leaving the group on "typing…" for minutes.
- **Cross-surface awareness** — every group turn (the incoming message **and** the
  bot's own reply) is injected into the operator's assistant session as a
  `[GROUP …]` frame — the same primitive as a fired reminder — so the operator, in
  their DM, stays aware of group activity and can even reply **into** the group.
  Group sends never pollute the operator's private `RECENT_TELEGRAM`.

### Scope & privacy

The group brain runs as `actor='team'` — **shared scope only**. Scope-guard fences
it out of every member's private `memory/users/<slug>/` tree, so a group reply can
never surface one person's private memory. Its own working notes live under
`memory/groups/<id>/` (admin-only via the file API). Replies are public to the
whole group, so the brain offers a DM for anything that needs private/personal
data. Security rests on **admission** (registration), not on filtering message
content: once a group is registered, messages from anyone in it are treated as the
team's.

### Tuning

`GROUP_WATCHER_OBSERVE_ONLY=1` flips the watcher to **observe-only** (logs every
decision, sends nothing) — useful on a fresh deployment to watch the gate before it
speaks. Default is off: the bot replies. The threshold, debounce, context size,
per-turn timeout, and message-parts cap are env-overridable and documented inline
in `group-watcher.js`.

---

## 11. Privacy model

**Default to the shared space — collaboration, not secrecy.** Most questions
about a teammate ("did X finish the analysis?", "where's the report?") are really
about the **shared** work — the assistant looks there first and answers from
there, rather than reaching for a privacy refusal on a work question.

The privacy boundary is the **exception**: a teammate's `users/<slug>/` files and
`memory/users/<slug>/` cards are theirs. A non-admin can't read another
teammate's private subtree (enforced by actor scoping, not just UI), and the
assistant won't rummage in someone's private space on another person's behalf —
though it can **relay** a question straight to that teammate.

---

## 12. Reference

### Data files (project root)

| File | Contents |
|------|----------|
| `.allowed-emails.json` | Roster: email, role, slug, displayName, telegram contact. |
| `.allowed-emails.audit.log` | Append-only roster change log. |
| `.team-config.json` | Solo vs collaborative flag **+ registered Telegram groups** (`groups`). |
| `users/<slug>/…` | Each teammate's personal files. |
| `memory/users/<slug>/…` | Each teammate's private memory cards. |
| `memory/groups/<id>/…` | A registered group's brain working notes (admin-only via the file API). |
| `memory/CHANNELS.md` | Generated shared card: the registered groups + their members (see §10). |

All of the above are workspace-managed state: hidden from the normal file tree
and excluded from Drive sync.

### HTTP endpoints

| Path | Notes |
|------|-------|
| `GET /api/me` | Caller identity + mode. |
| `GET/POST/PATCH/DELETE /api/team`, `PUT /api/team/mode` | Roster + mode (admin-gated writes). |
| `GET/POST/DELETE /api/team/telegram-groups` | Registered Telegram groups (admin-gated). |
| `GET /api/reminders`, `POST /api/reminders/cancel` | Actor-scoped reminder board. |
| `GET/POST/PATCH /api/tasks` | Shared task board. |
| `GET /internal/roster` | Loopback — roster for the reminder/tasks MCP name→slug resolution. |
| `POST /internal/reminder-deliver` | Loopback — fan-out of a fired reminder to teammates. |
| `POST /internal/group-message` | Loopback — a diverted group message into the relevance watcher. |
| `POST /internal/group-joined` | Loopback — bot added to a group → roster-gated auto-register. |

### Related skills

- `task-management` — drives the shared board via the tasks MCP.
- `reminders` — per-recipient reminders + delivery model.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how these pieces sit in the overall
system, and [SECURITY.md](SECURITY.md) for the actor-scoping threat model.
