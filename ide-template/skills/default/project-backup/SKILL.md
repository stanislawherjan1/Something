---
name: project-backup
description: Use this when the user asks to back up the project, create a project archive, or send a project snapshot via Telegram. Creates a compressed tar.gz of the project directory and sends it via Telegram.
allowed-tools: Bash
---

# Project Backup Protocol

Creates a compressed `.tar.gz` of `~/project`, checks size against Telegram's limit, sends, then cleans up.

Safety rules, the always-on exclude list, the 50 MB Telegram limit, and the after-sending report template all live in `references/rules.md` — read it before running.

## Steps — always in this order

### 1. Create the archive

```bash
tar -czf /tmp/project-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./.playwright-mcp' \
  --exclude='./generated' \
  -C /home/coder/project .
```

Archive goes in `/tmp/` — **never inside the project directory**.

### 2. Check file size

```bash
du -sh /tmp/project-backup-*.tar.gz
```

Telegram limit is **50 MB** (handling for oversize → `references/rules.md`). Report size to the user before sending.

### 3. Verify archive integrity

```bash
tar -tzf /tmp/project-backup-*.tar.gz | head -20
```

Confirm readable + contains expected files. If corrupt or empty, **do not send** — recreate.

### 4. Send via Telegram

Send to whoever requested it. If the request came via Telegram, send back to that chat. If unclear, ask before sending.

### 5. Clean up

```bash
rm /tmp/project-backup-*.tar.gz
```

Always remove after sending — `/tmp/` is not a long-term store.

### 6. Report

Use the template in `references/rules.md`.
