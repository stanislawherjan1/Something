# Contributing

## Contributor License Agreement

Before your first pull request can be merged, you'll be asked to sign our
[Contributor License Agreement](CLA.md). It's a one-click confirmation via
[CLA Assistant](https://cla-assistant.io) using your GitHub account — the bot
prompts you automatically on your first PR. It lets the project stay open source
(AGPL-3.0) while keeping relicensing options open for the maintainers.

## Two rules above all others

1. **Everything committed is in English** — code, comments, prompt strings, docs,
   commit messages, branch names. The only exception is i18n tables.
2. **This repository is public — never leak a client.** No client names, codenames,
   bot names, domains, IPs or business details anywhere you commit or push, including
   commit messages and branch names. Use neutral terms ("the canary", "a production
   client").

`scripts/check-public-safety.sh origin/main HEAD` checks both before you push; it builds
its list of names from your local `clients/` directory and an optional gitignored
`.public-denylist`, so the list itself never enters the repo.

## Key rule: client directories are local-only

Never commit a client directory. The `clients/.gitignore` enforces this automatically — only `clients/example-client/` is tracked as a template.

If you need a new client, copy `example-client` locally:
```bash
cp -r clients/example-client clients/your-client
```

It stays on your machine only.

## Shared code (`ide-template/`)

Changes here affect every client on their next deploy. Keep that in mind:

- **Small fixes, docs, new MCP tools** → a focused PR is fine
- **Bigger changes (auth, entrypoint, deploy logic)** → open a PR so a maintainer can review before it reaches all deployments

When in doubt, open a PR.

## After changing `ide-template/`

Redeploy only the clients you're responsible for. Other clients pick up the change on their next scheduled deploy — you don't need to coordinate every deployment.

```bash
cd clients/your-client
./deploy.sh              # full redeploy
./deploy.sh frontend     # only login page / branding
./deploy.sh code-server  # bot, MCP, entrypoint changes
```

## Tests and CI

CI (`.github/workflows/ci.yml`) runs on every push and pull request:

- `ide-template/workspace-api`: `npm test`, plus the reminder recurrence tests
- `ide-template/frontend`: `npm run build`
- on changes reaching `main`: the docs gate below

Run the same commands locally before opening a PR.

## Docs

**Nothing reaches `main` without a docs decision.** A change to shipped code
(`ide-template/`, `install.sh`, `bin/`, `scripts/`) must either update the docs it
affects — `CLAUDE.md` has a map of which doc covers what — or carry a commit trailer:

```
Docs-Impact: none — <one-line reason>
```

`scripts/check-docs-impact.sh origin/main HEAD` runs the same check CI does.

Changes that touch only `docs/` can go directly to `main` — no PR needed.

## Setup

See [docs/NEW_CLIENT.md](docs/NEW_CLIENT.md) for the full guide to setting up a new client.
