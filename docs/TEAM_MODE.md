# Team Mode

Team mode turns a single-user workspace into a **collaborative** one: several
people sign in with their Google accounts, each gets a private space alongside
the shared one, and the assistant can route reminders, tasks, and messages to
specific teammates. This document covers the whole system — modes, roster,
files, memory, reminders, tasks, cross-surface relay, and the privacy model.

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
| `TEAM` (generated) | **Shared** | The roster: who's on the team + how to reach them (see §11). |
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

## 10. Privacy model

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

## 11. Reference

### Data files (project root)

| File | Contents |
|------|----------|
| `.allowed-emails.json` | Roster: email, role, slug, displayName, telegram contact. |
| `.allowed-emails.audit.log` | Append-only roster change log. |
| `.team-config.json` | Solo vs collaborative flag. |
| `users/<slug>/…` | Each teammate's personal files. |
| `memory/users/<slug>/…` | Each teammate's private memory cards. |

All of the above are workspace-managed state: hidden from the normal file tree
and excluded from Drive sync.

### HTTP endpoints

| Path | Notes |
|------|-------|
| `GET /api/me` | Caller identity + mode. |
| `GET/POST/PATCH/DELETE /api/team`, `PUT /api/team/mode` | Roster + mode (admin-gated writes). |
| `GET /api/reminders`, `POST /api/reminders/cancel` | Actor-scoped reminder board. |
| `GET/POST/PATCH /api/tasks` | Shared task board. |
| `GET /internal/roster` | Loopback — roster for the reminder/tasks MCP name→slug resolution. |
| `POST /internal/reminder-deliver` | Loopback — fan-out of a fired reminder to teammates. |

### Related skills

- `task-management` — drives the shared board via the tasks MCP.
- `reminders` — per-recipient reminders + delivery model.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how these pieces sit in the overall
system, and [SECURITY.md](SECURITY.md) for the actor-scoping threat model.
