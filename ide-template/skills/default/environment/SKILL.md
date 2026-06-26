---
name: environment
description: Sealed-container constraints — never run install/setup commands, never edit system dotfiles, never download runtimes. Load on any tool error matching "not available", "browser not reachable", "ENETUNREACH", "not connected", "command not found", "module not found", "missing dependency", or whenever you're about to run install / npm install / pip install / apt install / playwright install / curl … | sh / wget … | sh / chrome / chromium / git clone for an environment fix. Container is curated at image build time — runtime install attempts fail with 403 or timeout. Operator is the only one who can change the image.
allowed-tools: Read
---

# Environment — sealed container, no runtime installs

## When to load this skill

A tool errored with one of:
- "not available" / "not connected" / "misconfigured"
- "browser not reachable" / "Chromium not found"
- "ENETUNREACH" / "ECONNREFUSED" / "DNS error"
- "command not found" / "module not found" / "missing dependency"
- npm / pip / playwright / apt complaining about an absent package

OR you're drafting a Bash command containing: `install`, `download`, `clone`, `wget`, `curl … | sh`, or any edit to `~/.claude/settings.json`, `~/.claude.json`, `~/.mcp.json`, `~/.bashrc`, `~/.profile`, or anything under `~/.config/`.

## The rule

**This environment is a sealed container.** Every MCP, every binary, every browser is pre-installed at image build time and wired up by `entrypoint.sh`. Network egress is filtered — arbitrary downloads (CDN, npm, pip, GitHub releases) will fail with 403 or timeout.

**You must not, ever, on any tool error:**

- Run `npx <anything> install`, `npm install`, `pip install`, `apt install`, `playwright install`, `curl … | sh`, or any equivalent install/setup invocation
- Edit `~/.claude/settings.json`, `~/.claude.json`, `~/.mcp.json`, or any system config trying to "fix" a missing tool
- Shell out to `chrome`, `chromium`, `chrome-for-testing`, or any browser binary by hand
- Try to download a browser, runtime, package, or model file from any CDN

## What to do instead

When an MCP tool returns "not available" / "browser not reachable" / "ENETUNREACH" / "not connected" / "misconfigured":

1. State the exact error to the operator on Telegram (verbatim — don't paraphrase as "needs permission").
2. **Do not improvise a fix.** The fix lives outside this session — the operator updates the image / config / allow-list.
3. **Continue the task without that tool if possible:** ask the user to paste the data, use a different MCP (Grok web search instead of Playwright browse, screenshots pasted manually, etc.).

## Your own workspace files vs system dotfiles

These ARE yours to edit freely (per File Operations in `~/.claude/CLAUDE.md`):
- `~/project/.claude/CLAUDE.md`
- `~/project/.claude/skills/`
- `~/project/memory/`

These are NOT yours — system dotfiles owned by the operator:
- `~/.claude/settings.json`
- `~/.claude.json`
- `~/.mcp.json`
- `~/.bashrc`, `~/.profile`, anything under `~/.config/`

If you find yourself drafting a Bash command that edits a system dotfile, **stop**. That belongs to the operator, not to a chat session.
