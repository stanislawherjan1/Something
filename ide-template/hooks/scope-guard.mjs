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
 *   IDE_ACTOR_IS_ADMIN   — "1" (admin → everything) | "0"
 *
 * Fail-OPEN: any error (bad input, missing env, import fail) → allow. This is
 * defence-in-depth on a trusted team, NOT the hard guarantee (that's the v2
 * per-uid split) — it must never break a turn over its own bug. It blocks only
 * a *confirmed* out-of-scope path.
 *
 * Block protocol: exit code 2 with a reason on stderr — Claude Code feeds
 * stderr back to the model and skips the tool.
 */

const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';

// Normalise an absolute-or-relative path to a project-relative POSIX path.
// Returns null for paths clearly outside the project (we don't guard those).
function relInProject(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  let s = p.trim();
  if (s.startsWith(PROJECT_DIR)) s = s.slice(PROJECT_DIR.length);
  else if (s.startsWith('/home/coder/project')) s = s.slice('/home/coder/project'.length);
  else if (s.startsWith('/')) return null;     // some other absolute path — not ours
  return s.replace(/^[./]+/, '');              // strip leading ./ or /
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
      break;
    }
    case 'Grep': {
      // Grep recurses from --path, optionally filtered by --glob; either can
      // point into a private tree.
      const root = typeof input.path === 'string' ? input.path : '';
      push(input.path);
      push(joinRoot(root, literalPrefix(input.glob)));
      break;
    }
    case 'LS': case 'List':
      push(input.path);
      break;
    case 'Bash': {
      // Best-effort ONLY — this does NOT make Bash isolation a hard guarantee
      // (tilde, $VAR, command substitution all slip through; v2 per-uid is the
      // real close). Pull users/<slug> and memory/users/<slug> references at a
      // shell word boundary (incl. redirects/operators < > ; & | : `) — not
      // embedded in a URL like example.com/users/1.
      const cmd = typeof input.command === 'string' ? input.command : '';
      const re = /(?:^|[\s'"=(<>;&|:`])((?:\/home\/coder\/project\/|\.?\/)?(?:memory\/)?users\/[A-Za-z0-9._-]+)/g;
      let m; while ((m = re.exec(cmd))) out.push(m[1]);
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
const MEMORY_WRITE_DENIAL =
  'Blocked: memory/ is written through the memory_write tool, not by editing files. '
  + 'Use memory_write with op "remember" for a new fact, "supersede" when a fact CHANGED '
  + '(it replaces the old claim everywhere it appears), or "retire" when it was never true. '
  + 'That path keeps the credential check, the undo snapshot and the audit log — an edit here keeps none of them. '
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
        process.stderr.write(MEMORY_WRITE_DENIAL);
        process.exit(2);
      }
    }
  }

  // Everything below is the per-actor privacy fence: it needs an actor, so a
  // slug-less context (solo brain, an internal headless run) skips it.
  if (!groupCtx && (!ownSlug || ownSlug === 'default')) process.exit(0);

  // Resolve relative to this hook's own location — hooks/ and workspace-api/
  // are siblings both in the repo and in the image (/opt/ide/*).
  const { pathInScope, pathInGroupScope } = await import(new URL('../workspace-api/lib/scope-rule.js', import.meta.url));

  const toolName = data.tool_name || data.toolName || '';
  const input    = data.tool_input || data.toolInput || {};


  for (const p of pathsFromTool(toolName, input)) {
    const rel = relInProject(p);
    if (rel == null) continue;
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
