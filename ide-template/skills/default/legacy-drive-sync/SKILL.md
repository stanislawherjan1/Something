---
name: legacy-drive-sync
description: Reliability rules for workspaces using the legacy Google Drive sync (rclone-backed file mirroring). Load ONLY when `LEGACY_DRIVE_SYNC=true` is active in the workspace env. Covers silent write failures, stale reads, verification-after-write protocol. New deploys do NOT use this — they store files in the workspace volume only, no Drive round-trip.
allowed-tools: Read, Bash(rclone:*)
---

# Legacy Google Drive sync

## When this skill applies

The workspace's `AGENT_TOOLS.md` lists `LEGACY_DRIVE_SYNC: true` OR the operator has explicitly mentioned rclone-backed Drive sync is active.

If the workspace is on the new model (volume-only storage), **skip this skill entirely**. The reliability problems below don't exist in the new model.

## The problem

rclone-backed Drive sync can silently fail in two ways:

1. **Silent write failure.** File appears written locally but never syncs to Drive (or syncs partially). Reads later get stale or empty content.
2. **Stale reads.** A file you wrote 30 seconds ago reads back as the OLD content because the rclone cache hasn't refreshed.

Both fail **without raising an error**. The default file APIs return success; the divergence shows up minutes/hours later.

## Protocol

For every file edit when this skill is active:

1. Write the file.
2. **Immediately Read it back** to verify content matches what you wrote.
3. If mismatched: re-apply the edit, verify again.
4. Never assume an edit succeeded — always read back before reporting "done" to the user.

For deletes / moves: same protocol — verify the source is gone and the destination exists.

## Recovery from drift

If you detect a stale read mid-conversation:
- Inform the user: "Wykryłem rozjazd Drive sync — re-aplikuję."
- Re-apply the most recent edit.
- Verify both locally AND via `rclone ls` against the Drive mount path.

## What this skill is NOT

- Not a general file-IO skill — pure `file-placement` covers the where-to-save decision.
- Not a Drive integration skill — that's `gdrive` (different, for Drive API access not rclone sync).
- Not active by default — only on workspaces explicitly opted into legacy mode.
