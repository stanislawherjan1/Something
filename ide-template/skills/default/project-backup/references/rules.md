# Project-backup — safety rules, excludes, report template

## Safety rules (non-negotiable)

- **NEVER** delete, move, or modify any files inside `~/project` during backup.
- **NEVER** create the archive inside the project directory — always `/tmp/`.
- **ALWAYS** verify archive integrity (`tar -tzf | head`) before sending.
- **ALWAYS** clean up `/tmp/project-backup-*.tar.gz` after sending.

## Excludes (always applied)

| Path | Reason |
|---|---|
| `node_modules/` | Recoverable via `npm install` — would make archive huge |
| `.git/` | Git history not needed in a backup snapshot |
| `.playwright-mcp/` | Temporary browser session data |
| `generated/` | AI-generated outputs — ephemeral |

If extra excludes are needed (archive >50 MB), ask the user which folders to skip. Don't silently exclude content they care about.

## Size limit

Telegram caps file uploads at **50 MB**. If the archive exceeds that:

- Ask the user which directories to additionally exclude, or
- Split into multiple archives by subfolder (one per top-level folder, sent in sequence).

Report the size to the user **before** sending — gives them a chance to cancel a 49 MB send if they only wanted a quick snapshot.

## After-sending report template

```
Backup created and sent.
File: project-backup-YYYYMMDD-HHMMSS.tar.gz
Size: X.X MB
Sent to: [chat name / user]
Cleaned up from /tmp.
```
