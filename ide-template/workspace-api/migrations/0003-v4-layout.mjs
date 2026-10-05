/**
 * 0003 — memory v4 layout: the ledger directories and the bot's working-state
 * directory, next to the legacy tree (nothing legacy is touched).
 *
 *   memory/ledger/                    shared
 *   memory/users/<slug>/ledger/       each teammate's private ledger (team mode)
 *   memory/groups/<chatId>/ledger/    each registered group (path-fenced like today)
 *   .bot-state/                       planner briefs, markers, logs — not memory
 *
 * Runs only when MEMORY_V4 is enabled on the deployment. Group ownership is the
 * workspace group with setgid dirs, the same rule as the rest of memory/ (never
 * chown to coder: workspace-api writes here).
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function dirs(ctx) {
  const out = [join('memory', 'ledger'), '.bot-state'];
  for (const slug of ctx.roster) out.push(join('memory', 'users', slug, 'ledger'));
  for (const gid of ctx.groups) out.push(join('memory', 'groups', gid, 'ledger'));
  return out;
}

const missing = (ctx) => dirs(ctx).filter(d => !existsSync(join(ctx.projectDir, d)));

export default {
  id: '0003-v4-layout',
  title: 'Memory v4: ledger directories',
  kind: 'structural',
  enabled: (ctx) => ctx.flag !== 'off',
  paths: (ctx) => dirs(ctx),
  check: (ctx) => {
    const m = missing(ctx);
    return { needed: m.length > 0, summary: m.length ? `create ${m.length} director${m.length === 1 ? 'y' : 'ies'}` : 'layout present' };
  },
  plan: (ctx) => ({ summary: 'create the v4 ledger directories', actions: missing(ctx).map(d => ({ op: 'mkdir', path: d })) }),
  apply: (ctx) => {
    const made = missing(ctx);
    for (const d of made) {
      const abs = join(ctx.projectDir, d);
      mkdirSync(abs, { recursive: true });
      // Best effort outside the container (tests, dev machines): the group may not exist.
      spawnSync('chgrp', ['workspace', abs], { stdio: 'ignore' });
      spawnSync('chmod', ['2775', abs], { stdio: 'ignore' });
    }
    return { changed: made.length };
  },
  verify: (ctx) => {
    const problems = dirs(ctx).filter(d => { try { return !statSync(join(ctx.projectDir, d)).isDirectory(); } catch { return true; } });
    return { ok: problems.length === 0, problems: problems.map(d => `missing ${d}`) };
  },
};
