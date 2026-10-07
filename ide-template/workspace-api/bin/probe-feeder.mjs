#!/usr/bin/env node
/**
 * Check a connected notetaker against its reader, before a night depends on it:
 *   node bin/probe-feeder.mjs <integration-id> [days]      (as wsapi, in the container)
 *
 * Prints the tools the live server declares (names and argument names), which
 * tool the reader picks for each role, how many meetings of the last [days]
 * (default 14) the reader parses, and for the newest one which fields came
 * back and how long they are. Never prints what was said: field names and
 * lengths only — this output may land in a terminal log.
 */
import { withRemote } from '../lib/integrations/mcp-client.js';
import { FEEDERS } from '../lib/memory-sources.js';

const id = process.argv[2];
const days = Number(process.argv[3]) || 14;
const feeder = FEEDERS[id];
if (!feeder) { console.error(`no reader for "${id}" — readers: ${Object.keys(FEEDERS).join(', ')}`); process.exit(2); }
const W = { since: new Date(Date.now() - days * 86400_000).toISOString(), until: new Date(Date.now() + 86400_000).toISOString() };
let code = 0;
try {
  await withRemote(id, async (c) => {
    const { tools } = await c.listTools();
    console.log(`${id}: ${tools.length} tools`);
    for (const t of tools) console.log(`  ${t.name}(${Object.keys(t.inputSchema?.properties || {}).join(', ')})${t.inputSchema?.required?.length ? ` required: ${t.inputSchema.required.join(', ')}` : ''}`);
    let list = [];
    try { list = await feeder.list(c, W); console.log(`\nlist: ${list.length} meeting(s) in the last ${days} days`); }
    catch (e) { code = 1; console.log(`\nlist: CANNOT READ — ${e.message}\n  (that night its notes are read through the assistant instead)`); return; }
    if (!list.length) { console.log('  nothing to read yet — record a meeting and run this again'); return; }
    const newest = list.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    console.log(`  newest: at=${newest.at || '?'} title=${newest.title ? `${newest.title.length} chars` : 'none'} participants=${newest.participants.length}`);
    try {
      const m = await feeder.get(c, newest.id);
      console.log(`get: summary ${m.summary.length} chars, transcript ${m.transcript.length} chars (${m.transcript.split('\n').filter(Boolean).length} lines), participants ${m.participants.length}, link ${m.url ? 'yes' : 'no'}`);
      if (!m.transcript) console.log('  no transcript — the meeting will be read from its notes alone');
    } catch (e) { code = 1; console.log(`get: CANNOT READ — ${e.message}`); }
  });
} catch (e) { code = 1; console.log(`${id}: cannot connect — ${e.message}`); }
process.exit(code);
