/**
 * One-shot repair for memory cards that drifted out of their declared shape.
 *
 * Two failures seen live, both silent: a card carrying the same heading twice
 * (so a reader of "the Never section" saw one of two sets of rules), and duties
 * on a flat-list card parked under headings of their own, invisible to the
 * Routines panel and to the planner.
 *
 * Content is moved, never dropped, and each file is written through the normal
 * event path — so every change has an undo snapshot and a log line, and
 * `memory_write op:"revert"` can undo it like any other write.
 *
 * Run:  node lib/memory-repair.mjs --dry-run    (report only)
 *       node lib/memory-repair.mjs              (apply)
 */
const dryRun = process.argv.includes('--dry-run');
const engine = await import('./memory-engine.js');

const report = engine.repairCards({ actor: 'operator', dryRun });

if (!report.length) {
  console.log('Every card already matches its declared shape. Nothing to do.');
  process.exit(0);
}

console.log(`${dryRun ? 'Would repair' : 'Repaired'} ${report.length} card(s):`);
for (const r of report) {
  console.log(`  ${r.file}${r.card ? ` (${r.card})` : ''} — ${r.moved} line(s)/heading(s) folded`);
}
if (dryRun) console.log('\nDry run: nothing written. Re-run without --dry-run to apply.');
