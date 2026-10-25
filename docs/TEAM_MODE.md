# Team Mode

## User guide

Alone, the coworker is yours. Switch on **collaborative mode** in the Team
settings and it becomes the team's while still knowing each of you: invite
people by email, make them admins or members, and everyone signs in with
their own Google account.

From then on there are two spaces side by side. **Shared** holds the files,
the task board and the memory the whole team works from. **Yours** holds your
own files and your own memory, which no teammate can read, and which the
coworker never reads on someone else's behalf — on the server each person's
work even runs under a separate system account, so one person's commands
cannot touch another's files. Admins manage the roster; they cannot look
into what is yours. A workspace holds up to 24 people. Ask "did Mara finish the report?" and it
answers from the shared work, so collaboration is the default and privacy is
the exception that holds.

An admin can **lock** a shared file or folder: everyone still reads it, and
nobody changes it — not members, not admins, not the coworker — until an
admin unlocks it. Whoever tries hears "Locked by <name>. Read-only until an
admin unlocks it." A locked folder covers everything inside it. Locks live in
the row menu of the file list, and a locked row carries a keyhole.

A Markdown file can be **shared by link**: press **Share** in the editor's top
bar and the link is copied. Anyone with it reads the file as it is now, read
only, without signing in; a teammate who can open the file here goes straight
to it. A link works for 30 days unless you pick 7 days or no end in its menu,
and then stops by itself; share again for a new one. **Stop sharing** ends it
sooner, and so does moving or deleting the file. When the coworker edits a
shared file it is told the file is public, so it keeps private details out. Your private files are yours alone to share.
Settings lists your links, and an admin can switch sharing off for everyone.

The first time someone you invited signs in, they get a short setup of their
own: their name, their role and what they need help with (and, if they want,
a look at public pages about them, which they check before anything is kept).
The name they give is the name the team sees. Then comes a starter plan picked
for their role: tools they can connect with their own account, and routines.
They can connect their own account of most tools from the Marketplace too; only
the team's own services, like the email inbox, Telegram or Slack, need an admin.
Members see their own settings in AI Settings; the coworker's name, face and
instructions are an admin's to set.

Each person links their own Telegram, so a message from you is from you; on
Slack it knows you by the email you sign in with, so there is nothing to link.
An admin sets the coworker up once on Telegram and on Slack, and it is the
whole team's from then on. Add it to a team group on Telegram, or invite it to
a Slack channel (an admin approves each channel once), and it listens there as
the team's, remembering the room's own conversation and never anyone's private
memory. If someone from outside the team is in a Slack channel, it stays quiet
there until they leave. Ask it there about
yourself or your own matters — where you are, what you prefer, a supplier you
chose, a meeting you booked — and it looks it up in what you told it in your own
chat and answers for the room to hear, because you asked. Nobody else gets it: when
someone asks about you, your memory stays closed, whoever they are. Codes and
passwords are the exception: those never go into a group, they come to you
directly instead. The same goes for an account you connected for yourself (your own
Supabase, your own mailbox): ask about it in the group or channel, or ask for a
change there, and it does it as you, as in your own chat, and answers there; for
anyone else it is simply not connected there. Come
back to a group after a day and it re-reads where the conversation stopped
before it answers. In a group it knows what the team knows: what was said in that group,
and what reached the team's shared memory from anyone's own chats. Ask it, from your own chat, to post something in a group or channel you are in and it posts exactly the text you approved. Reminders and
tasks go to the person they are for.


To switch collaboration off, remove everyone else from the team first — the screen tells you who. When you switch it on, you choose for each service you had connected whether the team uses it or it stays yours alone, and what your coworker remembered from before stays yours — a new teammate starts without your history.

---

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
affordance. **Turning it off is refused (409, with `others`) while anyone but the
caller is on the roster** — solo is one person; the Team screen lists them with
Remove (removal archives their private trees and their own connections).
**Turning it on** asks, on the Team screen, who uses each connection the owner
had: the whole team (it stays a workspace connection) or just them
(`POST /api/integrations/:id/make-personal` re-encrypts it as `<id>@<slug>`,
its file and server name follow). Switching on also hands the owner what solo
left in shared memory — the migration's records, never shared on purpose — as
their private memory (`lib/memory-solo.js`), so a new member does not find the
owner's history there; facts shared on purpose and other people's stay shared.
In solo the Integrations screen is one list
with nothing to choose, and the Skills screen one list.

Turning it **off** while you have personal files prompts a
decision (the UI's "disable" modal):

- **Merge** — move the **caller's own** `users/<slug>/` files up into the shared
  workspace (collision-renamed). Never touches anyone else's files.
- **Hide** — leave personal files in place but stop surfacing the split.

The admin's **memory cards** follow the mode either way: enabling adopts the
flat `USER_*` cards under `memory/users/<admin>/` at the next boot
(`migrateDefaultMemory`); disabling moves them back flat at once
(`restoreDefaultMemory`), because solo mode reads the one person's cards from
`memory/` — without that the Preferences screen said "Nothing yet" and the bot
lost the profile from its prefix. A flat card that already exists is never
overwritten.

**Routines** follow the same switch: team mode keeps the admin's list under
`.team/users/<admin>/routines.json`, solo mode reads `.team/users/default/`. The
side not in use is folded into the current one the next time routines are read
(`moveRoutines`, merged by title, never overwritten), so flipping the switch —
either way — never leaves the Routines screen empty.

The Team dashboard renders the mode card (the "Collaborative workspace"
toggle); `/api/me` and `/api/team` echo the current flag so the sidebar,
role badges, and recipient pickers react live.

---

## 2. Roster & roles

The whitelist lives in `.allowed-emails.json` (array of
`{ email, role, addedAt, addedBy, slug, displayName, telegramChatId, preferredSurface }` — read back with `surfaces`, see §8)
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
`{ email, slug, role, isAdmin, displayName, teamMode, personalRoot, telegramChatId, preferredSurface, surfaces, preferredLanguage, languageLocked, timezone, timezoneLocked, timezoneFrom, timezoneSetAt, defaultTimezone, effectiveTimezone }`.

Each person edits their own profile on the **Settings** page (user menu →
Settings): picture, name, reply language and time zone, and their Telegram link
when Telegram is on. The bot changes the language or zone when that person asks
(`set_my_settings`, never from a group), unless they locked it with the padlock.
Their morning planning runs at 06:00 in their zone; admins set the workspace
default zone for people without one. See [ROUTINES.md](ROUTINES.md#time-zone-and-language).

**Onboarding.** A person added after the workspace got onboarding goes through
it at first sign-in (people already on a workspace when it was updated do not):
full name, role, what they need help with and an optional web look-up of
themselves, what was found to confirm, then a starter plan. The company step is
the first admin's alone, so a member's flow is shorter. The full name given
becomes their `displayName` (team list, menu, relays), not whatever the
sign-in provider carried. What they confirm goes to their own private
`USER_PROFILE` through the memory engine. In a member's plan the integrations
are ones a person may connect for themselves (their own account), and the
team's connections are listed above them. State lives in workspace-api's
store, never the project tree (`onboarding/people/<slug>.json`); see
[QUICK_START.md](QUICK_START.md#6-first-login) and
`ide-template/workspace-api/README.md`.

**AI Settings** shows a member their own settings; the bot tile (name, avatar)
and the Instructions tile are shown to admins only.

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

**Sharing by link** (`lib/shares.js`, `routes/shares.js`). A Markdown file a
person can open is shared under a random token (`/app/s/<token>`); the same
file always gets the same link while it works. A link ends by itself after its
span (`days`: 30 by default, 7, or 0 for no end; `PATCH /api/shares/:token`
changes it from now); an ended link reads like a revoked one and sharing again
makes a new token. After the assistant edits a Markdown file, the PostToolUse
hook `hooks/shared-file-note.mjs` asks `GET /api/internal/shared?path=` (the
turn's token; only a path that turn can open) and, when the file has a working
link, tells the model it is public. The public read (`GET /api/public/share/:token`,
the one `/api` path nginx serves without the sign-in check) returns the file's
name and **current** text, never its path, and nothing when the link was ended,
the file moved, deleted or became unshareable, or sharing is off. Never
shareable: another person's private tree (admins included), the memory tree,
hidden or dot folders, hard-hidden files, anything that is not `.md`. Links are
listed and ended by their maker; an admin also sees and ends links to team
files, never to someone's private file. `fileSharing: false` in
`.team-config.json` (Settings → Shared links, admin) stops every link at once.
Tokens live in the store dir, out of the file tree and the bot's reach.

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
on demand, not in the prefix. This table is the older memory; after the move to
memory v4 only `USER_PROFILE` / `USER_PREFERENCES` stay private cards, the
shared `MISSION` card says what the company does, and the rest is removed (see
MEMORY.md).

**Deciding where a new fact goes** (the `memory_write` tool's routing rules): ask **"would
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

### With memory v4

Memory v4 ([MEMORY.md](MEMORY.md#how-it-works)) keeps whole conversations instead
of cards, split the same way by path: `memory/ledger/` (shared),
`memory/users/<slug>/ledger/` (one person) and `memory/groups/<chatId>/ledger/`
(one registered group).

- A **1:1 conversation** is filed whole in its owner's scope — a Telegram DM
  under the roster person whose chat it is. A small model then picks lines the
  team may also read (word-for-word only) into shared memory; borderline
  business lines wait on the owner's **Privacy** screen ("Share with team?") and
  are shared only if they say yes. What was shared from someone's private chats
  in the last two weeks is listed for them, with **Make private**.
- A **group conversation** is filed in that group's scope. A member reads it
  from their own 1:1 turns; a group turn reads shared + its own group — never
  anyone's private scope, not even the sender's.
- **Solo is a team of one**: the owner's conversations are their own scope, so
  switching team mode on later exposes nothing they did not share.
- No admin reads another person's memory — not in the tools, the Memory screen,
  the backup download, or by file path.

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

When the bot lists or cancels reminders, each person — admins included — works
with the ones that concern them: their own, those they are a recipient of, and
team-wide ones. A teammate's personal reminders stay theirs.

**A teammate's own Telegram DMs.** When a non-admin teammate writes to the bot
on Telegram and the message is not a reply inside a relay thread, it is answered
by a turn that runs **as that teammate** — their identity, their private memory
and files, the tools a web turn of theirs has — never by the operator's
assistant session. One conversation is kept per teammate (the turn resumes it),
the reply goes back on Telegram, and the exchange is recorded in a "Telegram"
chat in their web history. (`lib/integrations/member-dm.js`.) A Slack direct
message takes the same path for everyone, the primary admin included — Slack
has no tmux brain — with its own resumed session (`slack-session.json`) and a
"Slack" chat in the web history; the sender is matched to the roster by the
email Slack holds for them, once, and kept as `slackUserId` on their entry
(`setSlack`, `userBySlackId`). Someone in the Slack workspace who is not on
the roster gets one fixed line asking to be added, and no turn.

**Locks.** An admin marks a shared path read-only (`.team/locks.json`,
`lib/locks.js`; `POST /api/files/lock|unlock` admin-only, `GET /api/files/locks`).
One rule decides a write — `pathWritable` in `lib/scope-rule.js`: in scope,
and not under a lock — for everyone, admins and the operator's brain
included; unlocking is the only way to change a locked path. The file API
refuses write, create, mkdir, move (either end) and delete with the lock's
sentence, and refuses moving or deleting a folder that holds a locked item;
the scope-guard hook refuses Write/Edit/MultiEdit/NotebookEdit under a lock
in every turn (checked before the per-actor fence, so a solo brain honours
it too) and, best-effort, a shell command that names a locked path next to
a redirect or a file-changing command (`mv`, `cp`, `rm`, `sed -i`, `tee`,
`touch`, …). Reads are untouched. A lock whose path is gone never blocks and
is dropped on the next write; private trees and the root cannot be locked.
The tree marks covered entries (`locked: { path, by, byName, inherited }`)
and the row menu offers Lock / Unlock to admins.

**One turn user per person.** Each person on the roster has a *slot* (1–24),
assigned when they are added: the Linux user their turns run as (`turn-NN`) and
the group (`priv-NN`) that owns their private trees — `users/<slug>`,
`memory/users/<slug>`, `.team/users/<slug>`. Another person's turn, shell
included, cannot open them; workspace-api (in every `priv-*` group) still can,
and the operator's brain and editor are let into the operator's own. The
operator is the **primary admin** — the first admin on the roster; the Telegram
brain runs as them, so only their Telegram DMs reach it. Every other person,
a second admin included, is answered on Telegram by a turn as themselves
(`routeTelegramInbound` → member-dm), never by the brain. A group's
turn runs as `turn-group`, in no private group at all. When a person is
removed their trees are archived out of the project (root-only) before the
slot is reused; a workspace holds up to 24 people (the pool is a build
constant — the Team screen says so on the 25th). Each slot has its own home
and sessions, so a turn cannot read another person's transcript either.
Details: `docs/ARCHITECTURE.md` "The uids", `docs/SECURITY.md`.

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

The owner only shows on the board in team mode; a solo workspace hides it (the
field is kept, and shows again when team mode is switched on).

**Deleting.** Finished work moves to Done. A task that should never have been on
the board — a mistake, a test, a duplicate — can be deleted for good: ask the
bot, or `DELETE /api/tasks/:id`. The workspace UI has no delete control.

---

## 8. Cross-surface relay

A teammate can talk *through* the assistant to another teammate. The bot is the
courier:

- From a workspace, the assistant uses `web_send_message` with
  `recipient: <slug>` to deliver into that teammate's workspace (notification +
  chat). By default it routes to the recipient's **preferred surface** (their
  workspace always; their Telegram and/or Slack too if that's their preference
  and they've linked it; with no preference saved, Slack for someone on it —
  Telegram stays opt-in). The sender can override with `channel: "web" |
  "telegram" | "slack"`; on Slack the message lands in the recipient's DM with
  the bot.
- On **Telegram**, a relay reaches the operator's assistant as an injected
  `[RELAY …]` frame (out-of-band, like a fired reminder): the bot presents it to
  the operator naming the person, and relays the operator's answer back in the
  teammate's language.

The relay always composes a natural, verbatim message — never a robotic
"X asked me to forward this" — and uses the recipient's preferred language.

**Posting into a group.** A relay reaches one person; a team Telegram group is
reached with `group_send_message` (web-channel-mcp), from a web turn, a
teammate's Telegram DM turn or the operator's brain alike. The assistant passes
the text the person approved and it is posted **word for word**
(`POST /api/internal/group-post` → `postToGroup`), unlike a reminder aimed at a
group, which the group's brain writes itself. Who is posting comes from the
turn's token, and only into a registered group that person has been seen in
(their linked Telegram id in the group's members); a person without a linked
Telegram, or a group turn, cannot post. The message joins the group's history as
the assistant's, so the group's brain knows it was said. Before teammates' DMs
had turns of their own (shared spaces), the operator's brain answered every DM
and could post anywhere through the Telegram plugin; this restores that for each
person, inside their own groups only.

---

## 9. Telegram linking (per user)

Each teammate can be reached on Telegram once linked:

- `telegramChatId` — the DM chat with the bot. An **admin** can set it from the
  Team card's edit modal; a **teammate** links their own via the "Connect your
  Telegram" prompt (which PATCHes `/api/me`).
- `preferredSurface` — `web` / `telegram` / `both` — the teammate's own choice of
  where they want to be reached. It drives relay + reminder delivery routing.
  Unset, a person linked to Slack is reached there too (a team on Slack lives
  there; "send it to him" once landed only in a workspace nobody looked at);
  Telegram is never assumed.
  Underneath it is a **set** of surfaces (`lib/surfaces.js`): the roster stores
  and the API also returns `surfaces` (for example `["web","telegram"]`), and a
  PATCH accepts either the word or an array. The word is what `both` always
  meant — web and Telegram — kept so older clients keep working; a surface the
  word cannot name shows up only in `surfaces`.

Telegram itself is **team-wide** (`teamWide` in the catalog): an admin connects
the bot once for everyone, with no read-only/read-and-write choice (it always
reads and sends). The "Add <bot> on Telegram" bar at the top of the workspace
shows for admins only and opens Telegram's connect modal in place. Every turn's
`MY_SETTINGS` card says where the person can be reached: the web always,
Telegram only when it is connected and they are linked.

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
   direct address — `@mention`, a reply to the bot, a message in a Slack thread the
   bot has posted in, or the bot's **name** (incl. inflected forms) — bypasses the
   gate outright, and so does a follow-up from **any** person the bot answered in
   the last three minutes (kept per person: with several people talking, answering
   one no longer closes another's window). Where the bot spoke is kept in the
   durable history (`thread_id` on each line), so a restart does not forget its
   threads. Nor does a restart lose a question: while a turn runs, the message it
   answers is marked on disk (`.group-watcher/<room>-inflight-<id>.json`), and the
   next process takes up a mark younger than 15 minutes once, without the gate
   (`GROUP_INFLIGHT_REPLAY_MS`). Each reply records which message it answered
   (`reply_to`), so a message read back after a restart — Slack's catch-up, below —
   is answered only if it never was. A gate that fails (a crash, a
   timeout, an unreadable answer) hands the message to the brain rather than
   dropping it — the brain is the real judge and stays silent on its own; only a
   spent plan ("You've hit your weekly limit", which the brain would hit too)
   keeps the message out, and the breaker tells the group so.
   The durable history each group keeps (`.group-watcher/<chatId>-history.jsonl`)
   names a sender as the roster names them when their Telegram id is on it, and
   by their Telegram profile otherwise — it is what memory files a group from,
   and a profile called "s" once filed the operator's own words under "s".
2. **The brain** — on a pass, the **full assistant** answers via the same engine as
   web/1:1 (`runClaudeTurn`), as `actor='team'`. It has the complete 1:1 toolset —
   shared files, shared memory, skills, integrations, reminders — and may act. It
   is the real judge: if it has nothing useful to add it stays **silent** (no
   message, no "typing…"). The cheap gate is deliberately permissive precisely
   because the brain makes the final call.
   Each group keeps **one resumable session** (`.group-watcher/<chatId>-session.json`);
   a turn on it gets the messages since its last turn — and, because the CLI
   summarises a session that grows long (it lost the thread after a gap), the
   last lines it already saw: 10 always, 30 after more than three hours
   (`GROUP_RECAP_LINES`, `GROUP_RECAP_LINES_AFTER_GAP`, `GROUP_RECAP_GAP_MS`).
   The room's rules (manners, privacy, files, markers) go in the turn's system
   prompt, which is sent with every turn and never stored in the session; the
   turn's message carries only the conversation, who is asking and what is theirs.
   Sent as the message, the rules piled up in the session — 1 MB in thirty turns
   — and the CLI stopped for a minute and a half to compact it, losing context.
   The turn is also told what the new message continues — the thread's opening
   message, the bot's last reply *to this sender* (in a busy room its last reply
   was often to someone else) and the sender's own previous message, from the
   last half hour only (`GROUP_CONTINUES_WINDOW_MS`) — so "but check the
   integration" is read as the follow-up it is, and "tell me more about it" is
   never read as yesterday's subject. It is told the team's integrations by name,
   to use before saying it has nothing. Declining is a manners rule: a few
   friendly words and who to ask, never whose it is or how memory works. And it gets the team's
   files by path and first line (shared files only: no private tree, no memory;
   at most 40, `GROUP_SHARED_FILES_MAX`), with the rule to open the one that
   covers a date, plan or pipeline before saying it is unknown. A room with
   outsiders in it gets no such list.
   Where those lines and the session's recollection differ, the lines win.

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
`memory/groups/<id>/` (admin-only via the file API). The room's transcript
(`.group-watcher/<room>-history.jsonl`) is the room's own: readable by the room's
turn and by a person who is in that room, by nobody else — on disk (the directory
is the room turn's group) and in the scope-guard hook (by membership from the
registry). Replies are public to the
whole group, so the brain offers a DM for anything that needs private/personal
data. Security rests on **admission** (registration), not on filtering message
content: once a group is registered, messages from anyone in it are treated as the
team's.

**The asker's own memory, said in the room** (`ask_my_memory`,
`lib/integrations/private-lookup.js`). A room's session holds nobody's profile,
preferences or private memory: it is shared by everyone who writes there, and
whatever it is handed a later sender could have recited. So a roster member who
asks about themselves or their own matters in the room — where they are, what they
prefer, their suppliers, meetings, decisions, their plans and numbers, or something
whose answer depends on who they are ("the weather for me") — wants what they told
the bot in their own chat, said here. Whether a question is "about their own
matters" is not left to the brain (it seldom saw "is X staying?" or "what is the
deal worth?" as the asker's own plans): for **every** message the bot answers from a
roster member, the watcher starts the lookup alongside the turn's start, with the
exchange around the message (what it follows: the thread's opening message, the
bot's last reply to them, their previous message — a bare "tell what I think" found
nothing alone), and the turn's first step is `ask_my_memory`, which receives that
lookup. The bot says something is not on record only after it has returned. A
bound (`GROUP_LOOKUP_PREFETCH_PER_HOUR`, default 120) keeps a chatty room from
spending the plan; past it the turn asks itself. The group brain does not read
anything itself: workspace-api (`POST /api/internal/memory/v4/mine`) checks in code that the
turn is a group turn whose token names a roster person (the watcher resolved the
sender from their Slack or Telegram identity) and that the room is registered — in
a solo workspace too — then runs a **one-shot private turn as that person** (their
own scopes, their profile and preferences, no group context, no session,
`memory_search`/`memory_timeline` and nothing else) that answers in at most three
sentences, only what the question needs. Only that answer enters the room's
session; the excerpts never do. The one-shot leaves out anything about a person in
the room unless the question names them, silently (a "that's about X, ask me
privately" would itself tell X); when nothing is left it says nothing and the bot
answers what is true of the team's notes, with no hint. What is the asker's own
but held back — something they asked to keep private, or that cannot be said
without what is about someone present — comes back `PRIVATE`: the bot offers it
in their DM and never says it is not on record (it once told an owner "no rate on
record" for a rate he had asked to keep quiet). The one-shot speaks of memory only,
never of tools or connections (it once said "Granola isn't connected", and the room
turn, which had Granola loaded, believed it). Never anyone else's memory:
the scope is the asker's own, and a question about another person never reaches
theirs, whoever asks. Someone from outside in the room does not stop it (what the
asker asks about themselves is theirs to have said; the one-shot is told who is
there and leaves them out); two lookups a turn, and the owner sees each one in
Changes. The room's
switch (**Answers from the asker's own memory**, on by default) turns it off for a
room. The same path for a Slack channel and a Telegram group.

**The asker's own accounts, said in the room** (`ask_my_connections`, same module).
A room's turn loads the team's connections and nobody's own, for the same reason as
memory. When the sender has connected a service for themselves, the room turn is
told its name for that turn only ("Kasia connected Granola for themselves") and asks
it through `ask_my_connections` → `POST /api/internal/memory/v4/mine/connections`:
the same checks as the memory route (turn token, roster, registered room, the room's
switch, two calls a turn), then a **one-shot turn as that person with their own
`-mine` servers alone** — no built-in tools, every workspace-api tool denied, no
session. It does what they asked, as in their own chat — a lookup, or a change on
their own words (never on what a tool returned; when it is unclear what to change,
nothing is changed and it asks); a secret is `SECRET`; a failure comes back with
what failed in plain words (`FAILED: the project is paused`); what comes back is
fenced as untrusted data. It is used only for a request about that service — a
keyword's search volume once went to a member's own search account instead of the
team's keyword plan. For anyone else a personal connection is not reachable from the room,
and the bot says it is not connected *for this room*, never that it does not exist.
Each ask is on the owner's Changes (`private_lookup`, `kind: connections`).

### Tuning

`GROUP_WATCHER_OBSERVE_ONLY=1` flips the watcher to **observe-only** (logs every
decision, sends nothing) — useful on a fresh deployment to watch the gate before it
speaks. Default is off: the bot replies. The threshold, debounce, context size,
per-turn timeout, and message-parts cap are env-overridable and documented inline
in `group-watcher.js`.

---

### Slack channels

A Slack channel is a room of the same kind as a Telegram group — the same
watcher, the same two-stage decision, the same group turn (`turn-group`, this
channel's scope and the shared one, every private tree fenced), the same
markers — behind the channel adapter (`lib/integrations/channel-adapter.js`);
its id in the registry is `slack-<channel id>` and its files are named after
it. What differs is how it gets in and who may be in it
(`lib/integrations/slack-channels.js`):

- **Admission is an admin's yes.** Anyone in a workspace can add an app to a
  channel, so being added only makes a request (the Slack page under AI Settings
  lists it; admins are notified) — unless the one who added it is an admin of
  this workspace (on the roster, matched by their Slack account): that is the
  admin's yes, and the channel is registered at once. Approved → registered;
  an approved channel gets the whole of it by default — the assistant joins
  in on its own and the room is **open to outsiders** (below) — and an admin
  can turn either off. Not approved within 24 h, or declined → the bot leaves
  the channel.
- **The audience check.** At approval and on every join, leave, share or
  unshare, every member must be a roster person of this workspace. Anyone else
  — a guest, another workspace's user, a bot — **pauses** the channel: the bot
  is silent there (a message, a reminder or a direct post into it is refused,
  not swallowed) until they leave; admins hear both ways. A shared (Slack
  Connect) channel is left at once and can never be approved.
- **Replies go into the thread** of the message they answer (a top-level
  message starts one); a reminder or a direct post into the channel is
  top-level.
- **Files go with the reply.** A file the assistant wrote for the room, or for
  a person in a direct message, is attached (`[[SEND_FILE …]]`, the system
  uploads it into the conversation and thread) — a path alone is no answer
  where nobody opens the workspace. The same on Telegram.
- **Memory**: the channel's history is filed into `memory/groups/slack-C…/`,
  that channel's own scope, as a Telegram group's is.
- **Open to outsiders** (per channel, on by default): the assistant stays in
  a room that holds people outside the team. While someone outside the team
  is actually in it, every turn there is **group-only** — it reads and writes
  that channel's own memory and nothing of the team's shared memory
  (`readableScopes({ groupOnly })`, carried on the turn token); the prompt
  tells the assistant it is among outside parties. What belongs to the person
  asking (a task they own, their own plans) stays theirs to disclose: asked
  for it in the room, the assistant says it, and if it thinks the room is the
  wrong place it says so once and gives way when asked again. That is
  ownership, not rank: it never covers another person's things, an admin's
  request included. One exception, in every room whoever is in it: a secret
  that opens something (a password, a PIN, a door or lock code, a key, a
  login) is never said there, even when its owner insists — it goes to their
  DM, and the lookup returns `SECRET` instead of the value. Only the asker's
  own: asked for another person's login or code, the bot says it does not have
  it for them and promises no DM. (Told it could say
  a code in a team-only room, the model would not, so the rule says what it
  does.) With everyone on the team it is an ordinary room.
  Nothing of the sender's own is put into the room's session, not even their
  time zone: "the weather for me" goes through their own lookup, which knows
  their settings. Turned off, the room is paused while an outsider is
  in it. A shared (Slack Connect) channel is paused whatever the setting.
- **Threads**: a message inside a thread is answered in that thread, which
  keeps its own session (`.group-watcher/<id>-thread-<ts>-session.json`). A
  channel message is answered in the channel when it is a quiet
  back-and-forth, and in a thread under it when the channel is busy (someone
  else posted since, or two or more others spoke in the last ten minutes) or
  the answer is long (`placeReply` in `group-watcher.js`); a thread the bot
  opened that way stays the channel's session. The channel's history ring is
  the context for all of them.
- **People**: a teammate is linked by the email their Slack account carries,
  the first time they write (`slackUserId`); someone who writes without being
  on the team appears as pending on the Slack page, to add with one click
  (their email joins the roster as a member and their Slack account is linked
  at once). An
  admin may also link an account by its member id (`PATCH /api/team/:email
  { slackUserId }`, the Link control on the Slack page) when the Slack email is
  not the roster one — never a self-service link by id, which would let a
  person claim another's account.

### Where a person meets their surfaces — team mode

One rule for every surface: the roster entry (email) is the person; each
surface hangs an id on it; proactive messages follow the person's own
**Reach me** set, except when a sender names a surface.

| | Telegram | Slack | Web |
|---|---|---|---|
| Connected by | an admin, once, for the whole team (`teamWide`) | an admin, once: the workspace's own app | — |
| A person is linked | by a chat id — an admin on the Telegram page, or the person in **Settings → Reach me** | by the email on their Slack account, the first time they write; an admin may link by member id | by signing in |
| Rooms | groups the bot was added to by a roster member (auto-registered) | channels an admin approved, with the audience check | — |
| Who sees the links | admins on the surface's page (People); everyone sees the marks on **Team** | the same | — |
| The person's own view | **Settings → Reach me**: one row per surface — linked or not, and whether to be reached there | the same row | always on |

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
| `.team-config.json` | Solo vs collaborative flag **+ registered rooms** (`groups`: Telegram groups by chat id, Slack channels as `slack-C…`, with `paused` / `audience` for the latter). |
| `.team/slack-pending-channels.json`, `.team/slack-pending.json` | Slack channels waiting for an admin's approval; people who wrote on Slack without being on the team. |
| `users/<slug>/…` | Each teammate's personal files. |
| `memory/users/<slug>/…` | Each teammate's private memory cards. |
| `memory/groups/<id>/…` | A registered group's brain working notes (admin-only via the file API). |
| `memory/CHANNELS.md` | Generated shared card: the registered groups and channels + their members (see §10). |

All of the above are workspace-managed state: hidden from the normal file tree
and excluded from Drive sync.

### HTTP endpoints

| Path | Notes |
|------|-------|
| `GET /api/me`, `PATCH /api/me` | Caller identity + mode; the caller's own name, language, time zone (+ locks), Telegram link. |
| `PUT /api/team/default-timezone` | Admin — the workspace default time zone. |
| `GET/POST/PATCH/DELETE /api/team`, `PUT /api/team/mode` | Roster + mode (admin-gated writes). |
| `GET/POST/DELETE /api/team/telegram-groups` | Registered Telegram groups (admin-gated). |
| `GET /api/team/channels[?kind=slack]`, `POST /api/team/channels`, `DELETE /api/team/channels/:id`, `POST …/:id/recheck`, `DELETE …/pending-people/:id` | Rooms of every kind: the registered ones, the Slack channels waiting for approval and the people pending; approve / edit (`requireMention`, `language`), decline or leave, re-run the audience check, forget a pending person (admin-gated). |
| `GET /api/reminders`, `POST /api/reminders/cancel` | Actor-scoped reminder board. |
| `GET/POST/PATCH/DELETE /api/tasks` | Shared task board (DELETE removes a task for good; finished work moves to Done). |
| `GET /internal/roster` | Loopback — roster for the reminder MCP's name→slug resolution. |
| `POST /internal/reminder-deliver` | Loopback — fan-out of a fired reminder to teammates. |
| `POST /internal/group-message` | Loopback — a diverted group message into the relevance watcher. |
| `POST /internal/group-joined` | Loopback — bot added to a group → roster-gated auto-register. |
| `POST /internal/group-post` | Loopback — `group_send_message`: post the approved text, word for word, into one of the turn's person's registered groups (turn token; group turns refused). |
| `GET /api/onboarding`, `POST /api/onboarding/me`, … | Each person's own setup (§3); the company step is admin-only. |
| `POST /internal/me/settings` | Loopback — the bot's `set_my_settings` (turn identity; refused in groups and on locked settings). |

### Related skills

- `task-management` — drives the shared board through the tasks API (`/api/tasks`).
- `reminders` — per-recipient reminders + delivery model.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how these pieces sit in the overall
system, and [SECURITY.md](SECURITY.md) for the actor-scoping threat model.
