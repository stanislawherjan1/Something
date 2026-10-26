#!/usr/bin/env node
/**
 * PreToolUse path-guard hook (team mode B2a).
 *
 * Denies the web claude from reading/listing/touching ANOTHER teammate's
 * private space when the current turn belongs to a non-admin: their files
 * (project/users/<slug>/) AND their private memory (memory/users/<slug>/). This
 * is what stops "a member asks the bot about someone else's files/profile and
 * the bot — which has full FS access — reveals them."
 *
 * Reuses the SAME scope rule as the web file API
 * (workspace-api/lib/scope-rule.js) so enforcement can't drift.
 *
 * Per-turn actor comes from env, set per-spawn by workspace-api/lib/claude.js:
 *   IDE_ACTOR_SLUG       — the current user's slug
 *   IDE_ACTOR_IS_ADMIN   — "1" | "0" (not consulted by the path rule: privacy is by path, never by role)
 *
 * Fail-OPEN: any error (bad input, missing env, import fail) → allow. This is
 * defence-in-depth on a trusted team, NOT the hard guarantee (that's the v2
 * per-uid split) — it must never break a turn over its own bug. It blocks only
 * a *confirmed* out-of-scope path.
 *
 * Block protocol: exit code 2 with a reason on stderr — Claude Code feeds
 * stderr back to the model and skips the tool.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';
// A search that would walk the whole project (see pathsFromTool).
const WHOLE_PROJECT = Symbol('whole-project');
const PROJECT_ROOTS = [...new Set([PROJECT_DIR, '/home/coder/project'].map(r => posix.resolve(r)))];

// Normalise an absolute-or-relative path to a project-relative POSIX path.
// Returns null for paths outside the project (we don't guard those). The path
// is resolved first (relative ones against the project, where every turn
// runs), so '//', '/./' and '..' segments land where the file system would put
// them, and a leading dot that belongs to a name ('.team/…') is kept.
function relInProject(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const abs = posix.resolve(PROJECT_DIR, p.trim());
  for (const root of PROJECT_ROOTS) {
    if (abs === root) return '';
    if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  }
  return null;
}

// The literal directory prefix of a glob/pattern, up to the first wildcard
// segment: 'memory/users/bob/**' → 'memory/users/bob'; 'users/bob/*.md' →
// 'users/bob'; '**/*.md' → ''. Lets us catch a search whose PATTERN (not just
// its --path root) targets another user's private tree.
function literalPrefix(glob) {
  if (typeof glob !== 'string' || !glob) return '';
  const out = [];
  for (const seg of glob.split('/')) {
    if (/[*?[\]{}]/.test(seg)) break;
    out.push(seg);
  }
  return out.join('/');
}

// Candidate paths referenced by a tool call.
function pathsFromTool(toolName, input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  const push = (v) => { if (typeof v === 'string' && v) out.push(v); };
  // Join a search root with a pattern's literal prefix into one candidate path.
  const joinRoot = (root, pref) => (root && pref ? `${root}/${pref}` : (pref || root));
  switch (toolName) {
    case 'Read': case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      push(input.file_path); push(input.path); push(input.notebook_path);
      break;
    case 'Glob': {
      // The pattern itself is path-like and can name another user's tree
      // ('memory/users/bob/**'). Validate the root AND the pattern's literal
      // prefix resolved under it — not input.path alone.
      const root = typeof input.path === 'string' ? input.path : '';
      push(input.path);
      push(joinRoot(root, literalPrefix(input.pattern)));
      // No root and no literal prefix: the search starts at the project root
      // and recurses every tree, the private ones included. Marked as a
      // whole-project search; the fence below decides what to do with it.
      if (!root && !literalPrefix(input.pattern)) out.push(WHOLE_PROJECT);
      break;
    }
    case 'Grep': {
      // Grep recurses from --path, optionally filtered by --glob; either can
      // point into a private tree.
      const root = typeof input.path === 'string' ? input.path : '';
      push(input.path);
      push(joinRoot(root, literalPrefix(input.glob)));
      if (!root && !literalPrefix(input.glob)) out.push(WHOLE_PROJECT);
      break;
    }
    case 'LS': case 'List':
      push(input.path);
      break;
    case 'Bash': {
      // Best-effort ONLY — this does NOT make Bash isolation a hard guarantee
      // (tilde, $VAR, command substitution all slip through; v2 per-uid is the
      // real close). Pull users/<slug>, memory/users/<slug> and
      // .team/users/<slug> references at a shell word boundary (incl.
      // redirects/operators < > ; & | : `) — not embedded in a URL like
      // example.com/users/1.
      const cmd = typeof input.command === 'string' ? input.command : '';
      // A slug position may also hold a wildcard ('users/*/notes.md'): the
      // rule then sees a slug that is nobody's and denies it.
      const re = /(?:^|[\s'"=(<>;&|:`])((?:\/home\/coder\/project\/|\.?\/)?(?:memory\/|\.team\/)?users\/[A-Za-z0-9._*?{}-]+)/g;
      let m; while ((m = re.exec(cmd))) out.push(m[1]);
      // The tree itself, named without a slug ('ls users', 'cd users',
      // 'grep -r x memory/users'): the whole tree, which is nobody's.
      const bare = /(?:^|[\s'"=(<>;&|:`])((?:\/home\/coder\/project\/|\.?\/)?(?:memory\/|\.team\/)?users)\/?(?=$|[\s'"<>;&|`)])/g;
      while ((m = bare.exec(cmd))) out.push(`${m[1]}/`);
      // Any reference to memory/ itself (ls memory, cat memory/RULES.md), for
      // the post-move fence below.
      const mem = /(?:^|[\s'"=(<>;&|:`])((?:\/home\/coder\/project\/|\.?\/)?memory)(?:\/[^\s'"<>;&|`]*)?(?=$|[\s'"<>;&|`)])/g;
      while ((m = mem.exec(cmd))) out.push(`${m[1]}/`);
      // A room's transcript or the directory ('cat .group-watcher/-1-history.jsonl',
      // 'ls .group-watcher'): the membership rule below decides.
      const room = /(?:^|[\s'"=(<>;&|:`])((?:[^\s'"<>;&|`]*\/)?\.group-watcher(?:\/[^\s'"<>;&|`]*)?)(?=$|[\s'"<>;&|`)])/g;
      while ((m = room.exec(cmd))) out.push(m[1]);
      // A word that climbs ('Reports/../users/bob/x', '../x'): the rule
      // refuses any '..' — a detour is never a legitimate way to name a path
      // inside the project, and from its root it leaves the project.
      const climb = /(?:^|[\s'"=(<>;&|:`])((?:[^\s'"<>;&|`]*\/)?\.\.\/[^\s'"<>;&|`]*)/g;
      while ((m = climb.exec(cmd))) out.push(m[1]);
      break;
    }
    default: break;
  }
  return out;
}

// Tools that WRITE. Memory is now behind a single engine, so a direct file
// write into memory/ bypasses every guard that makes memory trustworthy:
// the credential kill-list, the scope check, the undo snapshot, the audit log,
// the INDEX rebuild — and, most importantly, the correction path. A hand-written
// markdown edit is how a "correction" used to land BESIDE the claim it was
// meant to replace. Blocked with a message that names the tool to use instead.
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// After the move to memory v4, memory/ is not a directory the bot reads at
// all: the cards it needs are in its prefix, everything else is reached with
// the memory tools. Listing the tree led it to narrate "structure" (folders of
// people who were never users, an empty wiki) instead of answering.
const LEGACY_MEMORY_RE = /^memory(\/|$)/;
const LEGACY_MEMORY_DENIAL =
  'Blocked: this workspace has moved to the new memory, and memory/ is not a directory to read or list. '
  + 'Your cards are already in your prefix; everything remembered is reached with memory_search and '
  + 'memory_timeline, or handed to you in the <<<MEMORY>>> block and WHAT_IS_GOING_ON; the person sees '
  + 'and edits it on the Memory screen. Questions about how memory is organised are answered from the '
  + 'rules (private by default; shared only what was shared or judged team-relevant; the person decides '
  + 'on the Sharing tab), never from folders. Nothing here is damage to report or restore.';
const MEMORY_WRITE_DENIAL =
  'Blocked: memory/ is written through the memory_write tool, not by editing files. '
  + 'Use memory_write with op "remember" for a new fact, "supersede" when a fact CHANGED '
  + '(it replaces the old claim everywhere it appears), or "retire" when it was never true. '
  + 'That path keeps the credential check, the undo snapshot and the audit log — an edit here keeps none of them. '
  + 'Do not mention this mechanism to the user; just make the write with the tool.';
// The same block in v4's words: there a fact someone asks to keep is a note,
// and memory_write only corrects a card.
const MEMORY_WRITE_DENIAL_V4 =
  'Blocked: memory/ is not written as files. Something a person asked you to remember → memory_note; '
  + 'a correction to a card (their profile or preferences, the company, the rules) → memory_write. '
  + 'Do not mention this mechanism to the user; just make the write with the tool.';

async function main() {
  // GROUP CONTEXT (group-mode v2, D2): a group turn's reply is public to the
  // whole group and its session is shared across turns run as different senders,
  // so NO private tree may enter it — not the sender's own, not an admin's. The
  // flag comes from env like the actor vars (set per-spawn by claude.js when
  // group-watcher passes groupContext: true). A group turn is NEVER exempt below.
  const groupCtx = process.env.IDE_GROUP_CONTEXT === '1';

  // Enforce for EVERY turn that carries a real actor slug — INCLUDING admins and
  // the operator brain. Through the bot + UI, no one reads one member's private
  // tree to serve another, even an admin: an admin's out-of-band escape is raw
  // DB/SSH on their own box, not the product surfaces. (Was admin-exempt; that
  // let two admins + the operator brain read each other's private memory.)
  // Exempt only a slug-less context (solo brain, or an internal non-web-chat
  // claude such as the reflect runs) and the legacy 'default' actor — and even
  // those only OUTSIDE group context.
  const ownSlug = process.env.IDE_ACTOR_SLUG;

  // The memory-write fence applies to EVERY turn, including a slug-less solo
  // brain — it is about which write PATH is used, not about whose data it is.
  // Read the payload first so both checks share it.
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }   // fail-open

  {
    const toolName = data.tool_name || data.toolName || '';
    const input = data.tool_input || data.toolInput || {};
    if (WRITE_TOOLS.has(toolName)) {
      const p = typeof input.file_path === 'string' ? input.file_path
        : typeof input.path === 'string' ? input.path
          : typeof input.notebook_path === 'string' ? input.notebook_path : '';
      const rel = relInProject(p);
      if (rel != null && (rel === 'memory' || rel.startsWith('memory/'))) {
        process.stderr.write(existsSync(join(PROJECT_DIR, 'memory', '_engine', '.v4-migrated')) ? MEMORY_WRITE_DENIAL_V4 : MEMORY_WRITE_DENIAL);
        process.exit(2);
      }
      // The team's skills and instructions are an admin's to change; a
      // member's own skills live in their private tree, loaded by their turns
      // only. A group turn changes neither.
      const teamConfig = rel != null && /^\.claude\/(skills(\/|$)|CLAUDE\.md$)/.test(rel.split('/').filter(x => x && x !== '.').join('/'));
      if (teamConfig && (groupCtx || process.env.IDE_ACTOR_IS_ADMIN === '0')) {
        process.stderr.write(groupCtx
          ? 'Blocked: a group conversation does not change the team\'s skills or instructions. Do it in a direct conversation.'
          : `Blocked: the team's skills and instructions are changed by an admin. Write this skill for this person only, at users/${ownSlug || '<slug>'}/.skills/<name>/SKILL.md — only their own conversations load it.`);
        process.exit(2);
      }
    }
  }

  // Once a workspace has moved to memory v4 (the stamp), what the old wiki
  // left behind is not the bot's to read: the engine's undo snapshots, the
  // ledger and views (reached through the memory tools, never as files), the
  // emptied topics/concepts/patterns trees, the INDEX maps. Asked "why don't
  // you remember X?", the bot dug through old card versions in _engine/undo
  // and offered to restore them — the move read as damage. Every turn, every
  // actor; the cards it needs are in its prefix, so nothing under memory/ is read as files.
  {
    const toolName = data.tool_name || data.toolName || '';
    const input = data.tool_input || data.toolInput || {};
    if (existsSync(join(PROJECT_DIR, 'memory', '_engine', '.v4-migrated'))) {
      for (const p of pathsFromTool(toolName, input)) {
        if (typeof p !== 'string') continue;
        const rel = relInProject(p);
        // One file under memory/ is not memory: the marker a group turn leaves
        // when a private answer to this person is on its way (group-watcher's
        // .pending-delegate.json). The Telegram brain checks it before answering
        // twice — their own only.
        if (ownSlug && rel === `memory/users/${ownSlug}/.pending-delegate.json`) continue;
        if (rel != null && LEGACY_MEMORY_RE.test(rel)) {
          process.stderr.write(LEGACY_MEMORY_DENIAL);
          process.exit(2);
        }
      }
    }
  }

  // Read-only integrations: an admin connected a service for the team as
  // read-only (.team/integration-access.json, written by workspace-api with
  // the bot's config). Its write tools are refused in every turn — a tool
  // whose name says it changes something, and any the catalog adds for the
  // service (`writeTools`: changes or spends behind a harmless name). Reading
  // is untouched.
  {
    const toolName = data.tool_name || data.toolName || '';
    const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(toolName);
    if (m) {
      let access = {};
      try { access = JSON.parse(readFileSync(join(PROJECT_DIR, '.team', 'integration-access.json'), 'utf8')) || {}; } catch { /* none read-only */ }
      const server = m[1], tool = m[2];
      if (access[server] === 'read') {
        let writeTools = null;
        try {
          const cat = JSON.parse(readFileSync(new URL('../workspace-api/integrations.catalog.json', import.meta.url), 'utf8')).integrations;
          const base = server.replace(/-mine$/, '');
          const entry = cat.find(e => e.mcp?.name === base || (e.mcp?.services || []).some(x => x.name === base));
          if (Array.isArray(entry?.writeTools)) writeTools = entry.writeTools;
        } catch { /* no catalog here: the name decides */ }
        const WRITE_RE = /(^|[_-])(create|update|delete|remove|send|post|write|move|rename|archive|add|set|put|patch|upload|publish|share|insert|edit|reply|invite|assign|complete|close|cancel|merge|trash|restore|import|sync|schedule|book|pay|refund|charge|transfer|mark)([_-]|$)/i;
        const isWrite = WRITE_RE.test(tool) || !!writeTools?.includes(tool);
        if (isWrite) {
          process.stderr.write(
            `Blocked: ${server.replace(/-mine$/, '')} is connected for the team as read-only, so "${tool}" (a change) is not available. ` +
            `Reading through it is fine. Tell the user plainly: "This connection is read-only for the team; an admin can allow changes on its page in Integrations." ` +
            `Do not work around it.`,
          );
          process.exit(2);
        }
      }
    }
  }

  // Locks: an admin marked shared paths read-only (.team/locks.json,
  // lib/locks.js) — for everyone, this turn's actor included, admin or the
  // operator's brain, until an admin unlocks it. A locked path may be read and
  // not changed: the write tools are refused outright, Bash when it names a
  // locked path next to something that writes. The sentence is the lock's
  // own, the same the file API gives. Checked before the per-actor fence: a
  // solo brain has no slug and still honours a lock.
  {
    const { lockCovering } = await import(new URL('../workspace-api/lib/scope-rule.js', import.meta.url));
    const toolName = data.tool_name || data.toolName || '';
    const input    = data.tool_input || data.toolInput || {};
    let locks = {};
    try { locks = JSON.parse(readFileSync(join(PROJECT_DIR, '.team', 'locks.json'), 'utf8')) || {}; } catch { /* no locks */ }
    const lockedPaths = Object.keys(locks).filter(k => existsSync(join(PROJECT_DIR, k)));
    if (lockedPaths.length) {
      const live = Object.fromEntries(lockedPaths.map(k => [k, locks[k]]));
      const refuse = (hit) => {
        process.stderr.write(
          `Blocked: "${hit.path}" is locked — read-only for everyone until an admin unlocks it. ` +
          `Tell the user plainly: "This is locked. I can read it; an admin has to unlock it before anything changes." ` +
          `Do not work around it (no copies elsewhere, no shell tricks).`,
        );
        process.exit(2);
      };
      if (WRITE_TOOLS.has(toolName)) {
        for (const p of pathsFromTool(toolName, input)) {
          const rel = relInProject(p);
          const hit = rel != null ? lockCovering(rel, live) : null;
          if (hit) refuse(hit);
        }
      } else if (toolName === 'Bash') {
        const cmd = typeof input.command === 'string' ? input.command : '';
        // Something in the command writes: a redirect, or a command that changes files.
        const writes = /(^|[\s;&|(])(>|>>|mv|cp|rm|rmdir|sed\s+-i|tee|touch|mkdir|truncate|dd|chmod|chown|ln|install|rsync|unzip|tar)\b|>\s*['"]?\S/.test(cmd);
        if (writes) {
          const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const root = escRe(PROJECT_DIR.replace(/\/+$/, ''));
          for (const key of lockedPaths) {
            const re = new RegExp(`(?:^|[\\s'"=(<>;&|:\`])(?:${root}/|\\./)?${escRe(key)}(?=$|[/\\s'"<>;&|\`)])`);
            if (re.test(cmd)) refuse({ path: key });
          }
        }
      }
    }
  }


  // Everything below is the per-actor privacy fence: it needs an actor, so a
  // slug-less context (solo brain, an internal headless run) skips it.
  if (!groupCtx && (!ownSlug || ownSlug === 'default')) process.exit(0);

  // Resolve relative to this hook's own location — hooks/ and workspace-api/
  // are siblings both in the repo and in the image (/opt/ide/*).
  const { pathInScope, pathInGroupScope, transcriptAllowed } = await import(new URL('../workspace-api/lib/scope-rule.js', import.meta.url));
  // Is this person in that room? The registry answers (the room's members by
  // their Telegram or Slack id, the person's ids on the roster); unreadable
  // registry → nobody is (fail closed: a transcript is never shown by mistake).
  const groupId = process.env.IDE_GROUP_ID || null;
  let roster = null, groups = null;
  const isMember = (roomId) => {
    if (roster == null) { try { roster = JSON.parse(readFileSync(join(PROJECT_DIR, '.allowed-emails.json'), 'utf8')); } catch { roster = []; } }
    if (groups == null) { try { groups = JSON.parse(readFileSync(join(PROJECT_DIR, '.team-config.json'), 'utf8')).groups || {}; } catch { groups = {}; } }
    const me = (Array.isArray(roster) ? roster : []).find(m => m && m.slug === ownSlug);
    const members = Object.keys(groups[roomId]?.members || {});
    return !!me && members.some(id => id === String(me.telegramChatId || '') || id === String(me.slackUserId || ''));
  };

  const toolName = data.tool_name || data.toolName || '';
  const input    = data.tool_input || data.toolInput || {};

  for (const p of pathsFromTool(toolName, input)) {
    if (p === WHOLE_PROJECT) {
      // Every tree at once, the other people's included. The shared space and
      // one's own are searched by naming them.
      process.stderr.write(
        `Blocked: a search over the whole workspace would include other people's private spaces. ` +
        `Search a folder instead: the shared files (name the folder), or your own files (users/${groupCtx ? '<slug>' : ownSlug}/).`,
      );
      process.exit(2);
    }
    const rel = relInProject(p);
    if (rel == null) continue;
    if (!transcriptAllowed(rel, { groupCtx, groupId, isMember })) {
      process.stderr.write(groupCtx
        ? `Blocked: "${p}" is another room's transcript. A room's conversation reads its own transcript only.`
        : `Blocked: "${p}" is a room's transcript, and this person is not in that room. What a room said is the room's; ` +
          `to the user, say that conversation is between the people in it — never that you cannot see it.`);
      process.exit(2);
    }
    const inScope = groupCtx
      ? pathInGroupScope(rel)
      : pathInScope(rel, { isAdmin: false, ownSlug });
    if (!inScope) {
      process.stderr.write(groupCtx
        ? `Blocked: "${p}" is a PRIVATE space and this is a GROUP conversation — nothing ` +
          `private may enter a group turn, not even the requester's own files (the group ` +
          `context is shared). Use only the shared workspace here. If the requester asked ` +
          `about THEIR OWN private data, emit a [[PRIVATE_TASK ...]] marker so it runs ` +
          `privately and lands in their DM; otherwise say each person's space is theirs.`
        : `Blocked: "${p}" is another teammate's private space (their "Your Files"). ` +
          `You may only access Shared Files and your own files. Don't reveal the path. ` +
          `To the user, frame this as PRIVACY, not a limitation — you're capable, you ` +
          `just keep everyone's space private (say something like "that's between you ` +
          `and them"); never say "I don't have access" or "I can't see it".`,
      );
      process.exit(2);   // block the tool call
    }
  }
  process.exit(0);       // allow
}

main().catch(() => process.exit(0));   // fail-open on any unexpected error
