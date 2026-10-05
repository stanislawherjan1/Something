---
name: project-backup
description: Use this when the user asks to back up the project, create a project archive, or send a project snapshot, and on the weekly `[BACKUP_TRIGGER]`. Creates a compressed tar.gz of the shared project (never memory, team state or other people's private folders) and hands it over — on Telegram as a file, on the web as a workspace path.
allowed-tools: Bash
---

# Project Backup Protocol

> Durable/disaster-recovery backups run server-side (daily restic → B2, see `scripts/restic-backup.sh`). This skill is the on-demand "send me a snapshot now" path.

Creates a compressed `.tar.gz` of `~/project`, checks size against Telegram's limit, sends, then cleans up.

**What never goes in.** `./memory` (memory is backed up server-side and is private per person), `./.team`, `./.group-watcher`, and every `./users/<slug>/` private folder except the requester's own. The requester is the person in the `[ACTOR]` line (`$IDE_ACTOR_SLUG` on Telegram); with no identifiable requester, exclude all of `./users`.

Safety rules, the always-on exclude list, the 50 MB Telegram limit, and the after-sending report template all live in `references/rules.md` — read it before running.

## Steps — always in this order

### 1. Create the archive

```bash
tar -czf /tmp/project-backup-$(date +%Y%m%d-%H%M%S).tar.gz \
  --exclude='./node_modules' \
  --exclude='./.git' \
  --exclude='./.playwright-mcp' \
  --exclude='./generated' \
  --exclude='./memory' \
  --exclude='./.team' \
  --exclude='./.group-watcher' \
  --exclude='project-backup-*.tar.gz' \
  $(for d in /home/coder/project/users/*/; do s=$(basename "$d"); [ "$s" = "$REQUESTER_SLUG" ] || echo "--exclude=./users/$s"; done) \
  -C /home/coder/project .
```

Set `REQUESTER_SLUG` to the requester's slug first (leave it empty for the unattended trigger — then every private folder is excluded).

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

### 4. Hand it over

- **Telegram:** send the file back to the chat the request came from. If unclear, ask before sending.
- **Web:** don't send anything — move the archive to `~/project/users/<requester>/backups/` (or `~/project/backups/` with no team mode) and reply with that workspace path in backticks. Skip step 5 for this copy.
- **Unattended `[BACKUP_TRIGGER]`:** nobody asked in the moment, so keep it safe — the archive holds only the shared project (no memory, no `./users`), goes only to the operator's Telegram chat, and if it is over 50 MB, skip the send and say so in one line instead of splitting or asking.

### 5. Clean up

```bash
rm /tmp/project-backup-*.tar.gz
```

Always remove after sending — `/tmp/` is not a long-term store.

### 6. Report

Use the template in `references/rules.md`.
