/**
 * private-tree — whether a person's `.team/users/<slug>/` tree is theirs yet.
 *
 * A person's private app data (their chats, routines, their own task list)
 * lives under `.team/users/<slug>/`, which `priv-tree` (the root helper,
 * setuid-wrappers/priv-tree.c) gives to their turn user and private group:
 * dirs 2770 turn-NN:priv-NN, so the kernel keeps every other member's turn out
 * and workspace-api, in every priv-* group, keeps its access.
 *
 * Until that happened the tree is not private at all. `.team/users/` is the
 * workspace group's, 2775 with setgid, and every turn user is in `workspace`
 * (Dockerfile): a directory workspace-api made there itself inherits that
 * group, and a 0660 file inside it is readable by every member's turn. The
 * windows are real — a person just added, a boot race, the solo→team switch
 * before the slots exist, a person with no slot. So anything private is written
 * only into a tree whose group is already a priv-* group; otherwise the writer
 * refuses (PrivateTreeNotReady) and the caller says so, rather than making the
 * directory and leaking.
 *
 * Outside the container (dev, tests) the helper does not exist and no tree is
 * ever owned; then, as team.js already does for the helper itself, the check is
 * skipped — the model-facing hook is the only fence there, as before.
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SLUG_RE = /^[a-z0-9-]+$/;
const PRIV_GROUP_RE = /^priv-\d{2}$/;

export class PrivateTreeNotReady extends Error {
  constructor(slug) {
    super(`the private tree of ${slug} is not owned yet — nothing private is written there`);
    this.code = 'PRIVATE_TREE_NOT_READY';
    this.slug = slug;
  }
}

function projectDir() { return process.env.PROJECT_DIR || '/home/coder/project'; }
const PRIV_TREE_BIN = () => process.env.PRIV_TREE_BIN || '/usr/local/bin/priv-tree';

/** The group's name for a gid, from the group file; null when unknown. */
export function groupNameOf(gid, groupFile = '/etc/group') {
  let text;
  try { text = readFileSync(groupFile, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    const parts = line.split(':');
    if (parts.length >= 3 && Number(parts[2]) === gid) return parts[0];
  }
  return null;
}

/** The person's tree directory, or null for a slug nothing should be built from. */
export function privateTreeDir(slug) {
  if (!slug || slug === 'default' || !SLUG_RE.test(slug)) return null;
  return join(projectDir(), '.team', 'users', slug);
}

/**
 * True when `.team/users/<slug>/` exists and belongs to a priv-* group — or
 * when there is no priv-tree helper on this machine at all (nothing is ever
 * owned here; dev and tests). `helper`, `groupFile` and `statFn` are for tests.
 */
export function privateTreeReady(slug, { helper = existsSync(PRIV_TREE_BIN()), groupFile = '/etc/group', statFn = statSync } = {}) {
  const dir = privateTreeDir(slug);
  if (!dir) return false;
  if (!helper) return true;
  let st;
  try { st = statFn(dir); } catch { return false; }
  if (!st.isDirectory()) return false;
  return PRIV_GROUP_RE.test(groupNameOf(st.gid, groupFile) || '');
}

/** Throws PrivateTreeNotReady unless the tree is the person's. */
export function assertPrivateTree(slug, opts) {
  if (!privateTreeReady(slug, opts)) throw new PrivateTreeNotReady(slug);
}
