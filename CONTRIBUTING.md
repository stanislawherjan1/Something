# Contributing

## Contributor License Agreement

Before your first pull request can be merged, you'll be asked to sign our
[Contributor License Agreement](CLA.md). It's a one-click confirmation via
[CLA Assistant](https://cla-assistant.io) using your GitHub account — the bot
prompts you automatically on your first PR. It lets the project stay open source
(AGPL-3.0) while keeping relicensing options open for the maintainers.

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

## Docs

`docs/` changes go directly to `main` — no PR needed.

## Setup

See [docs/NEW_CLIENT.md](docs/NEW_CLIENT.md) for the full guide to setting up a new client.
