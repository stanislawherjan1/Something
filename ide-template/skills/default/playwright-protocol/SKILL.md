---
name: playwright-protocol
description: Rules for browser automation with Playwright — screenshots, navigation, mobile views
allowed-tools: mcp__playwright__*
---

# Playwright Protocol

This skill defines the rules for using Playwright for browser automation, interactions, and screenshots.

## Use the configured MCP only — never reinstall

Browser automation goes **exclusively** through the `mcp__playwright__*` tools. The Playwright MCP is wired up in `.claude.json` at container build time with Chromium pre-installed in the image.

You **must not**:
- Run `npx playwright install` (any variant)
- Run `npx @playwright/mcp@latest` or any other `npx` invocation of Playwright
- Shell out to `chrome`, `chromium`, `chrome-for-testing`, `google-chrome`, or any browser binary
- Try to download a browser from `cdn.playwright.dev`, `googleapis.com`, or any other source

Container egress only allows the explicit integration hostnames. Browser CDNs are **not** on the allow-list and never will be — downloads at runtime are a prompt-injection escape hatch. Any "let me try to install Chromium" reasoning is wrong; the binary is already baked into the image.

If `mcp__playwright__browser_navigate` (or any playwright tool) returns "browser not available" or a launch error:
1. **Do not improvise.** Don't try `npx`, don't try to install, don't try to find the binary yourself.
2. Tell the operator: "Playwright is misconfigured — Chromium isn't reachable from my uid. Need a container fix; using comment-based workarounds for now."
3. Continue the task without Playwright if possible (e.g. ask the user for a screenshot, work from QA comments, use Grok web search as a substitute for browse-style lookups).

## Screenshots — default: `/tmp/`, delete after use
Always save screenshots to `/tmp/`, never into the project directory.

**Filename:** `/tmp/sc_name.jpeg`

After sending or using the screenshot, delete it:
```bash
rm -f /tmp/sc_name.jpeg
```

**Exception:** If the user explicitly asks to keep or save a screenshot, save it into a sensible folder within the project (e.g. `Research/Inspirations/` or `Marketing/Website/`) and explain where it went. Never leave files in the project root.

## .playwright-mcp folder
The Playwright MCP server automatically creates a `.playwright-mcp/` folder in the working directory with log and snapshot files. This is unavoidable. It is listed in `.gitignore`. Clean it up periodically:
```bash
rm -rf /home/coder/project/.playwright-mcp
```

## General rules
- Navigate, interact, screenshot — then **always call `browser_close`** when done. Leaving Chrome running risks stale `SingletonLock` files in the profile directory, which makes the next launch fail with `browser is already in use` even though no Chrome process is alive.
- Take viewport screenshots by default (not full-page) unless the full page is needed.
- **For mobile views:** Resize to 390×844, take the screenshot, then reset to desktop (1280×800).

## When you see "browser is already in use"
This is almost always a stale `SingletonLock` symlink left behind by a Chrome that crashed or got killed mid-session. It is **not** another instance of Claude blocking you — each Claude session (the Telegram tmux bot, and each per-turn `claude -p` subprocess in the web chat) spawns its **own** playwright-mcp subprocess over stdio with its own user-data-dir. They do not share Chrome state.

To recover, ask the operator (or do it yourself if you have shell access):
```bash
find /home/coder -name 'Singleton*' -type l -delete
```

Then retry. The container `entrypoint.sh` already clears these locks at startup, so a bot restart also fixes it. Do not invent explanations involving "shared MCP server" or "another instance opened the browser" — that's not how this stack works.
