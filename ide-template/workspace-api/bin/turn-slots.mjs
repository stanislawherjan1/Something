#!/usr/bin/env node
/**
 * turn-slots — give every person on the roster their turn slot and their
 * private trees (lib/team.js reconcileSlots). The entrypoint runs it as root
 * at every boot, before workspace-api starts, so the trees are owned and the
 * primary admin's group is open to the brain and the editor from the first
 * turn; workspace-api runs the same reconcile itself when it starts.
 *
 *   node bin/turn-slots.mjs reconcile
 *
 * Run as root it leaves the roster file as it found it ownership-wise:
 * workspace-api (uid 1001, group workspace) must keep writing it.
 */
import { chownSync, statSync, lstatSync, symlinkSync, unlinkSync, lchownSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';
const FILE = join(PROJECT_DIR, '.allowed-emails.json');
const cmd = process.argv[2];
if (cmd !== 'reconcile') {
  console.error('usage: turn-slots.mjs reconcile');
  process.exit(2);
}

let before = null;
try { before = statSync(FILE); } catch { /* no roster: nothing to do */ }
if (!before) { console.log('turn-slots: no roster'); process.exit(0); }

const { reconcileSlots } = await import('../lib/team.js');
const out = reconcileSlots();
// The operator's brain (the bot, its own home) loads the primary admin's own
// skills, as their web turns do: ~/.claude/skills → users/<admin>/.skills, in
// team mode only (solo has no personal skills — the team's are the owner's).
try {
  const { primaryAdminSlug, getTeamMode } = await import('../lib/team.js');
  const BOT_HOME = process.env.BOT_HOME || '/home/bot';
  const link = join(BOT_HOME, '.claude', 'skills');
  const admin = primaryAdminSlug();
  let cur = null; try { cur = lstatSync(link); } catch { /* none */ }
  if (cur && cur.isSymbolicLink()) unlinkSync(link);
  // A folder left from before that holds nothing but links (the old index
  // link) gives way; one with real content is left alone.
  if (cur && cur.isDirectory() && readdirSync(link).every(n => lstatSync(join(link, n)).isSymbolicLink())) { rmSync(link, { recursive: true, force: true }); cur = null; }
  if (getTeamMode() && admin && admin !== 'default' && existsSync(join(BOT_HOME, '.claude')) && (!cur || cur.isSymbolicLink())) {
    symlinkSync(join(PROJECT_DIR, 'users', admin, '.skills'), link);
    const home = statSync(BOT_HOME);
    try { lchownSync(link, home.uid, home.gid); } catch { /* not root */ }
    console.log(`turn-slots: the brain loads ${admin}'s own skills`);
  }
} catch (err) { console.log(`turn-slots: brain skills link not made: ${err.message}`); }
// A root write (rename) leaves the file root's; hand it back.
try { chownSync(FILE, before.uid, before.gid); } catch { /* not root: nothing changed hands */ }
console.log(`turn-slots: assigned ${out.assigned.length} (${out.assigned.map(a => `${a.email}→${a.slot}`).join(', ') || '–'}), owned ${out.owned.length} tree set(s), admin slot ${out.granted ? `${out.granted} opened to bot and coder` : 'not opened'}`);
