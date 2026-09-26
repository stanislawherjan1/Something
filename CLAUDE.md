# Working on Something — instructions for coding agents

Something is a self-hosted AI coworker: one Docker stack per business, a Claude Code
"brain" reachable over Telegram and a web workspace, tools via MCP servers. This file is
for agents **changing this repository**. It is not the bot's own prompt — that is
`ide-template/global-claude.md`.

Operator-specific context (which server is the canary, hosts, identities) lives in a
gitignored `CLAUDE.local.md` next to this file, when present.

## Two rules above all others

1. **Everything committed is in English** — code, comments, prompt strings, docs, commit
   messages, branch names, PR text. The only exception is i18n tables. Chat with the
   operator may be in any language; nothing that lands in git is.
2. **This repository is public — never leak a client.** No client names, codenames,
   their bots' names, domains, IPs, people or business details in anything committed or
   pushed: code, comments, docs, commit messages, branch names, PR text. Use neutral
   terms ("the canary", "a production client"). A push to *any* branch publishes it,
   and history is hard to take back.

Both are checked before every push by `scripts/check-public-safety.sh` (wired as a local
PreToolUse hook). The client list it checks against is derived from the local
`clients/` directory and a gitignored `.public-denylist`, so the list itself never
reaches the repo.

## Where things are

| Path | What |
|---|---|
| `ide-template/` | The product — everything that ships into a deployment |
| `ide-template/workspace-api/` | Express backend: files, chat (SSE over `claude -p`), integrations store + credential broker, memory engine, group watcher. `routes/` = HTTP, `lib/` = logic |
| `ide-template/frontend/` | React 19 + Vite workspace UI (`src/components/workspace/views/` = sidebar views) |
| `ide-template/apps/*-mcp/` | Our MCP servers (one dir each; `_shared/` = common code) |
| `ide-template/bot/` | Telegram brain: `bot.sh` (tmux session), `reminder-monitor.sh`, notify/relay helpers, PM2 `ecosystem.config.js` |
| `ide-template/skills/default/` | Skills shipped to every deployment (re-copied from the image on each boot) |
| `ide-template/hooks/` | Claude Code hooks for the bot (scope guard, reply checks) |
| `ide-template/bootstrap/` | First-boot seeds: memory card templates, system reminders, reconcile scripts |
| `ide-template/global-claude.md` | The bot's global instructions |
| `ide-template/entrypoint.sh`, `Dockerfile`, `docker-compose.yml`, `deploy.sh` | Container boot, image, stack, deploy |
| `ide-template/setuid-wrappers/` | C runners that drop each process to its own uid |
| `install.sh`, `bin/`, `scripts/` | Installer, server preflight/ensure, hardening, dev scripts, `check-docs-impact.sh` |
| `chrome-extension/` | The side-panel browser extension (no build step; `scripts/build-extension-zip.sh` packages it into the frontend's `public/downloads/`) |
| `clients/` | Per-client config — **local only**, never committed except `example-client/` |
| `docs/` | Product + operator documentation (map below) |
| `docs/future-plans/` | Designs not built yet — **gitignored**, local only |

## Docs map — what to update when you change something

| You changed… | Update |
|---|---|
| Components, data flow, processes, uids, broker | `docs/ARCHITECTURE.md` |
| Anything security-relevant (auth, isolation, egress, secrets, injection surface) | `docs/SECURITY.md` |
| Deploy, update, server setup, troubleshooting | `docs/DEPLOY.md`, `docs/NEW_CLIENT.md` |
| The installer / first-run path | `docs/QUICK_START.md`, `README.md` |
| An integration or MCP server (new, changed, removed) | `docs/INTEGRATIONS.md` |
| Memory: cards, engine, read/write paths | `docs/MEMORY.md` |
| Skills, `global-claude.md` behaviour, the skill catalog | `docs/SKILLS.md` |
| Team mode: roster, privacy, relay, reminders per user, group mode | `docs/TEAM_MODE.md` |
| Routines, the morning planner, reminders and their firing | `docs/ROUTINES.md` |
| The browser extension, its sign-in or `pageContext` | `docs/BROWSER_EXTENSION.md` |
| workspace-api endpoints or module layout | `ide-template/workspace-api/README.md` |
| User-visible features | `README.md` |

## Docs before main (required)

**Nothing reaches `main` without a docs decision.** Before merging or pushing to main,
update every doc the change affects (map above). If nothing user- or operator-visible
changed, put this trailer in a commit message instead:

```
Docs-Impact: none — <one-line reason>
```

This is enforced, not just asked: `scripts/check-docs-impact.sh` runs in CI on every pull
request into main and fails without one of the two. Run it yourself before proposing a
merge: `scripts/check-docs-impact.sh origin/main HEAD`.

When a plan in `docs/future-plans/` ships, move its content into the right doc and delete
the plan file.

## How to make changes

1. **Branch first.** Anything beyond a one-line fix goes on a branch
   (`fix/…`, `feat/…`), never a chain of commits on main.
2. **Never commit, push, merge, deploy or restart anything without the operator's
   explicit go-ahead** — a passing test is not a go-ahead.
3. **Test** (see below), then verify end to end on the **canary** deployment before
   merging to main. Production clients are never test targets.
4. **Commit messages** follow the existing style: `type(scope): what was wrong, in one
   sentence` (`fix(routines): …`, `feat(push): …`). Explain the *why* in the body.
5. Keep the change small and in the style of the surrounding code; match its comment
   density and idiom.

## Tests and CI

- `cd ide-template/workspace-api && npm test` — backend suites.
- `node ide-template/apps/reminder-mcp/recur.test.mjs` — recurrence engine.
- `cd ide-template/frontend && npm run build` — the UI must build.
- CI (`.github/workflows/ci.yml`) runs all three plus the docs gate.
- `npm run lint` in the frontend currently has a backlog of errors and is **not** gated
  yet; don't add new ones.
- Prefer tests of **behaviour** over tests that grep the source — source-grep tests
  break on harmless refactors and miss real regressions.

## Hard rules

- **Never hard-code phrases of any language to detect intent.** The bot replies in the
  user's language because the *model* does that; let the model judge intent (e.g. the
  `[[SILENT]]` marker pattern).
- **Privacy is enforced by path, never by role.** Private memory lives under
  `memory/users/<slug>/`; no admin bypass anywhere (scope rules, hooks, APIs). Group
  turns are fenced off every private tree.
- **Memory is written only through the memory engine** (`memory_write`), which keeps
  scope checks, undo and the log. No direct file writes under `memory/`.
- **The bot talks like a colleague.** Normal messages, normal replies; no buttons,
  pickers or forms in the conversation. Controls belong on settings screens.
- **Reminders placed by the planner are instructions for the bot to act**, never text
  to relay to a person.

## Gotchas that have bitten before

- **Permissions:** never `chown -R coder:coder` anything under `memory/` or config —
  workspace-api runs as its own uid and must keep write access. Use `chgrp workspace`
  + `chmod 2775` (dirs) / `664` (files).
- **A new always-on MCP** needs both a `COPY` in the `Dockerfile` and a force-write into
  the bot's `.claude.json` in `entrypoint.sh`; the catalog sync alone does not register
  it. Missing either = a dead tool with no error.
- **Deploy scripts:** never pipe `deploy.sh` through `tail`/`head` (the exit code is
  lost → false success). Never switch branches in the working tree while a deploy is
  uploading from it — use a `git worktree`. Check disk (`df -h`) before a build on a
  client server.
- **Reloading the backend:** a PM2 restart does not reload workspace-api's code on a
  running container; restart the container.
- **UTC:** reminder recurrence is UTC-only today — mind DST when touching schedules.

## Plans and bigger designs

Write designs to `docs/future-plans/<NAME>.md` (gitignored) and add a row to its
`README.md` index. Don't start a multi-phase change without the operator agreeing to the
plan.
