/**
 * 0001 — memory v3: the one-engine cleanup (archive the reflect/drafts pipeline,
 * strip retired-claim furniture from cards, reindex).
 *
 * This ran as a boot one-off with a stamp file (memory/_engine/.migrated-v3)
 * before the migration framework existed. Deployments that have the stamp record
 * it as applied without running anything.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { migrateToEngine } from '../lib/memory-migrate.js';

const stamp = (ctx) => join(ctx.memoryDir, '_engine', '.migrated-v3');

export default {
  id: '0001-engine-v3',
  title: 'Memory v3: one write engine (legacy cleanup)',
  kind: 'structural',
  paths: () => ['memory'],
  recognize: (ctx) => existsSync(stamp(ctx)),
  check: (ctx) => ({ needed: !existsSync(stamp(ctx)), summary: 'archive the v2 pipeline, clean cards, reindex' }),
  plan: () => ({ summary: 'archive the v2 reflect pipeline, clean cards, reindex', actions: [{ op: 'run', path: 'memory', detail: 'migrateToEngine()' }] }),
  apply: () => ({ changed: migrateToEngine().migrated ? 1 : 0 }),
  verify: (ctx) => ({ ok: existsSync(stamp(ctx)), problems: existsSync(stamp(ctx)) ? [] : ['stamp missing after apply'] }),
};
