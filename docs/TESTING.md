# Testing

Two layers of tests. The **unit and behaviour suites** run anywhere, need nothing
deployed and gate every pull request in CI. The **end-to-end suites** in
`scripts/e2e/` run against a live deployment, through its real web API, its real
container and real conversations with the bot; they are run by hand, before a
merge to main and after a deploy.

## Unit and behaviour suites (CI)

| Command | What |
|---|---|
| `cd ide-template/workspace-api && npm test` | The backend: memory engine, sharing, scope guard, team and turn slots, integrations store and broker, tasks, routes, migrations |
| `node ide-template/apps/reminder-mcp/recur.test.mjs` | The reminder recurrence engine |
| `node ide-template/apps/reminder-mcp/room-target.test.mjs` | A reminder's room target: a Telegram group or a Slack channel, and a room named in the reminder's words |
| `cd ide-template/frontend && npm run build` | The workspace UI must build |

`.github/workflows/ci.yml` runs all three, plus the docs gate
(`scripts/check-docs-impact.sh`), on every pull request into main.

Prefer tests of behaviour over tests that grep the source. Tests that need the
model (`claude -p`) use a stand-in runner (`configureRunner` in the memory
modules), so CI never spends model usage.

## End-to-end suites (`scripts/e2e/`)

They need a deployment you are allowed to break: a **test deployment of your
own** (the operator's "canary"), never a production client. Every suite cleans
up after itself when it exits, pass or fail: test chats, facts, records, tasks,
locks, reminders and the stand-in notetaker are removed, so the deployment's
screens show only real use afterwards.

### Running them

Point the suites at the deployment's client directory (the one holding its
`.env`, as used by `deploy.sh`):

```bash
E2E_CLIENT=my-canary scripts/e2e/run.sh smoke        # a name under clients/
E2E_CLIENT=/path/to/clients/my-canary scripts/e2e/run.sh group
```

or put `E2E_CLIENT=my-canary` in `scripts/e2e/.env.local` (gitignored) and drop
the prefix. In a git worktree, which has no `clients/`, a name resolves to the
main checkout's `clients/`.

| Command | Runs |
|---|---|
| `scripts/e2e/run.sh smoke` | `isolation` + `imports` — after every deploy |
| `scripts/e2e/run.sh full` | every suite, one at a time — before a merge to main |
| `scripts/e2e/run.sh sharing group` | the named suites |
| `scripts/e2e/<suite>.sh` | one suite directly |

Options: `KEEP=1` leaves the test data in place for a look (clean up afterwards
with `scripts/e2e/cleanup.sh`); `ONLY=1,6` runs single scenarios of
`tasks-memory`; `E2E_GROUP_TITLE` names the test group for `group`.

### What they need

- ssh access to the deployment's host (`HETZNER_HOST` in its `.env`).
- For most suites, **a member on the roster** besides the admin; the suites
  read both from the deployment's own roster, so no emails are configured.
- For `group`: a registered Telegram test group the admin is in (by default the
  first whose title contains "test"), and a member who is not in it.
- For `imports`: nothing extra — it serves a stand-in notetaker from
  `ide-template/workspace-api/test-fixtures/stub-notetaker` on the container's
  loopback and removes it at the end.

### Cost

Most suites hold **real conversations with the bot**, and those run on the
Claude plan of the deployment's admin. `smoke` costs next to nothing; `full`
is well over a hundred model turns and about an hour. Run the turn-heavy
suites one at a time, when a change touches what they cover.

### The suites

| Suite | Checks | Model turns | Time |
|---|---|---|---|
| `isolation` | Health, the scope guard, the editor gate and admin-only routes, sign-out, the setuid runners and turn users, who may reach which local listener, the hosted MCP bridge, the monitor routes | 1 | 1–2 min |
| `imports` | A notetaker connection feeds the scope of whoever connected it; nothing reaches the shared scope | few | 3–7 min |
| `access` | Chat turns as admin and member, a member kept out of the admin's private files, the browser, the Granola bridge, a reminder for a teammate | ~8 | 6–10 min |
| `sharing` | The Sharing screen as admin and member; a member's work fact reaches the team in their name, a personal one never; make private and restore | 1 + filing | 2–4 min |
| `sharing-org` | With the company in mind: an invented studio's card and twelve conversations through the deployed router, notes pass and sharing gate, in a throwaway directory. Nothing private may reach the team; work outcomes should reach it or a question to their owner | ~36 small-model calls | 3–6 min |
| `shared-spaces` | Turn slots and kernel-level isolation of private trees, read-only locks, integrations with a reach (personal vs workspace) | 5 | 3–4 min |
| `accounts` | What one account tells the bot or keeps in its files, and what the other can and cannot get at | 7 | 4–8 min |
| `skills` | Personal and team skills: who can make, use and change which | 9 | 5–10 min |
| `lifestyle` | Health, money and a partner never reach the team in any sharing mode; a household chore crosses only in automatic mode | 3 | 2–4 min |
| `group` | The Telegram group never reaches anyone's private memory, files, skills or connections; what it decides reaches only its members | ~10 | 10–30 min |
| `group-window` | A decision in the group is filed once it goes quiet; a later "ok, sent" is its own window and updates the fact with history and today's date, counted in Changes — never reworded in place; a note saved mid-turn never says memory is down | ~12 | 5–10 min |
| `group-mine` | A member's own memory said in the team group: asked there about their own matters, the bot answers from what they told it in their own chat and says so; the admin's private fact never surfaces, whoever asks; a member's fact is not the admin's to pull in | ~8 | 5–10 min |
| `room-private` | A person's private things in a Slack sandbox room (`E2E_SLACK_ROOM`, posts for real): their private code never reaches the room (it goes to their DM), whoever asks, an injected "read the private files" gets nothing, another room's words are not read from here while this room's are; with someone from outside in the room (simulated) a visitor is not read the admin's board, and the admin's own task is said when they ask | ~8 | 10–15 min |
| `tasks-memory` | A task and the memory fact behind it point at each other; the bot answers from the board; done on the board closes the fact; files written in a conversation are linked | ~12 | 10–15 min |
| `conversation` | The company card reaches the turn; a preference asked to be kept is on the person's card when the turn ends; a new message stops the running reply cleanly (no "kill EPERM"); a reply says it is settled before its process exits | 4–5 | 3–5 min |
| `memory-sight` | What the bot sees of memory: the person's own cards are answered from and followed, another person's are not, a note from an earlier conversation is found, a team rule an admin asks for reaches a member, routines and integrations are listed right (built-in abilities are not integrations) | ~10 | 5–8 min |
| `planner` | The morning planner as the member on a light and a busy day: the plan it makes (printed in their local time), recurring for an hourly duty, something before a call, a spread day; planning again replaces the plan; nothing in the past, no two stand-alone messages close together unless one is timed | ~6 | 5–10 min |

A check that needs a connection the deployment lacks (a notetaker, the
running browser) prints `skip` with the reason instead of failing; a skip is
neither a pass nor a failure.

Some checks judge a model's reply (did it refuse, did it answer from the
board). A single failure there is worth a rerun before it is called a
regression; a failure that repeats is one.

### Writing a new suite

Start the file with `source "$(dirname "$0")/lib.sh"`: it resolves the
deployment, signs in as the admin and the first member (`ADMIN_JWT`,
`MEMBER_JWT`), sets the cleanup trap and gives you `check`, `has`, `lacks`,
`ok`, `api`, `code`, `new_session`, `turn` and `finish`. Mark everything the
suite creates so `cleanup.sh` can find it (a `TAG`, an `E2E` prefix), and add
the pattern to `cleanup.sh` if it is new. Add the suite to `run.sh`. Never name
a real client, person or host in a suite: the repository is public.
