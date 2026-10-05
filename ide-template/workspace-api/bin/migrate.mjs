#!/usr/bin/env node
/**
 * Data migrations for this deployment (lib/migrate.js). Run inside the container
 * as the workspace-api user:
 *
 *   node bin/migrate.mjs status
 *   node bin/migrate.mjs plan <id>        dry run; writes the plan to the store for review
 *   node bin/migrate.mjs apply <id>       content migrations need a fresh plan first
 *   node bin/migrate.mjs verify [id]
 *   node bin/migrate.mjs rollback <id>    restore the backup taken before apply
 */
import * as migrate from '../lib/migrate.js';

const [cmd, id] = process.argv.slice(2);
const out = (x) => process.stdout.write(`${typeof x === 'string' ? x : JSON.stringify(x, null, 2)}\n`);

try {
  switch (cmd) {
    case 'status': {
      for (const m of await migrate.status()) {
        const state = m.applied ? `applied ${m.appliedAt}` : !m.enabled ? 'not enabled' : m.needed ? `PENDING — ${m.summary}` : 'not needed';
        out(`${m.id.padEnd(28)} ${m.kind.padEnd(10)} ${state}`);
      }
      break;
    }
    case 'plan': {
      const p = await migrate.plan(id);
      out(`${p.id}: ${p.plan.summary}`);
      for (const a of p.plan.actions) out(`  ${a.op.padEnd(6)} ${a.path}${a.detail ? `  (${a.detail})` : ''}`);
      out(`inputs ${p.inputsSha.slice(0, 12)} — review, then: node bin/migrate.mjs apply ${p.id}`);
      break;
    }
    case 'apply': out(await migrate.apply(id)); break;
    case 'verify': {
      const ids = id ? [id] : (await migrate.status()).filter(m => m.applied).map(m => m.id);
      for (const x of ids) out({ id: x, ...(await migrate.verify(x)) });
      break;
    }
    case 'rollback': out(await migrate.rollback(id)); break;
    default:
      out('usage: migrate.mjs status | plan <id> | apply <id> | verify [id] | rollback <id>');
      process.exit(2);
  }
} catch (err) {
  process.stderr.write(`migrate: ${err.message}\n`);
  process.exit(1);
}
