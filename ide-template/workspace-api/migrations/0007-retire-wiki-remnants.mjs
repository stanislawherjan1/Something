/**
 * 0007 — what the old wiki left behind is archived and removed.
 *
 * The move (0005) emptied the topics/, concepts/ and patterns/ trees and left
 * the INDEX maps and the engine's undo snapshots (every old version of every
 * card) in place. Nothing loads them any more, but they are still files: asked
 * "why don't you remember X?", the bot read the empty trees as damage, dug
 * old card versions out of _engine/undo and offered to restore them.
 *
 * Structural, automatic at boot once the workspace has moved: each remnant
 * goes into one tar.gz in the migrations store (kept 30 days like the other
 * backups) and is deleted from memory/. Nothing that v4 reads is touched.
 */
import { existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const SHARED = ['_engine/undo', 'topics', 'concepts', 'patterns', 'INDEX.md'];
const PER_USER = ['topics', 'concepts', 'patterns', 'INDEX.md'];

function remnants(ctx) {
  const out = [];
  for (const r of SHARED) if (existsSync(join(ctx.memoryDir, r))) out.push(r);
  const users = join(ctx.memoryDir, 'users');
  if (existsSync(users)) {
    for (const e of readdirSync(users, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^[a-z0-9-]+$/.test(e.name)) continue;
      for (const r of PER_USER) if (existsSync(join(users, e.name, r))) out.push(`users/${e.name}/${r}`);
    }
  }
  return out;
}

function storeDir() { return join(process.env.WSAPI_STORE_DIR || '/var/wsapi-store', 'migrations'); }

export default {
  id: '0007-retire-wiki-remnants',
  title: 'The old wiki\'s leftovers are archived and removed from memory',
  kind: 'structural',
  enabled: (ctx) => ctx.flag !== 'off' && existsSync(join(ctx.memoryDir, '_engine', '.v4-migrated')),
  paths: (ctx) => remnants(ctx).map(r => relative(ctx.projectDir, join(ctx.memoryDir, r))),
  check: (ctx) => {
    const r = remnants(ctx);
    return { needed: r.length > 0, summary: r.length ? `${r.length} leftover(s): ${r.join(', ')}` : 'nothing left of the old wiki' };
  },
  plan: (ctx) => ({
    summary: 'archive each leftover into the migrations store, then remove it from memory/',
    actions: remnants(ctx).map(r => ({ op: 'archive+remove', path: `memory/${r}`, detail: 'kept 30 days in the store' })),
  }),
  apply: (ctx) => {
    const list = remnants(ctx);
    if (!list.length) return { changed: 0 };
    mkdirSync(storeDir(), { recursive: true });
    const archive = join(storeDir(), `0007-wiki-remnants-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
    execFileSync('tar', ['czf', archive, '-C', ctx.memoryDir, ...list], { stdio: 'ignore' });
    for (const r of list) rmSync(join(ctx.memoryDir, r), { recursive: true, force: true });
    ctx.log(`0007: ${list.length} leftover(s) archived to ${archive}`);
    return { changed: list.length, archive };
  },
  verify: (ctx) => {
    const left = remnants(ctx);
    return { ok: left.length === 0, problems: left.map(r => `${r} still there`) };
  },
};
