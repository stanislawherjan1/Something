/**
 * The runner's retry: a failed call is tried once more, a timed-out one is
 * not (it would take the whole budget again — a note saved mid-turn once ran
 * for five minutes and the tool gave up), and what failed is said on stderr
 * with how long it took. The transport is a fake.
 *
 * Run: node lib/memory-llm.test.mjs   (wired into `npm test`)
 */
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

const LLM = await import('./memory-llm.js');
const logged = [];
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (s) => { logged.push(String(s)); return true; };

let n = 0;
LLM.configureRunner(async () => { n++; if (n === 1) throw new Error('model call failed: boom'); return { fine: true }; });
let r = await LLM.runStructured({ system: 's', user: 'u', schema: {} });
ok('a failed call is retried once and the retry answers', r?.fine === true && n === 2, { r, n });
ok('...the failure is logged with its duration and the retry', logged.some(l => /\[memory-llm\] .* failed after \d+ s: model call failed: boom — retrying once/.test(l)), logged);

n = 0; logged.length = 0;
LLM.configureRunner(async () => { n++; throw new Error('timeout'); });
let threw = null;
try { await LLM.runStructured({ system: 's', user: 'u', schema: {} }); } catch (e) { threw = e; }
ok('a timeout is not retried', threw?.message === 'timeout' && n === 1, { threw: threw?.message, n });
ok('...and is logged once, without a retry', logged.filter(l => /failed after/.test(l)).length === 1 && !logged.some(l => /retrying/.test(l)), logged);

n = 0; logged.length = 0;
LLM.configureRunner(async () => { n++; throw new Error('model call failed: boom'); });
threw = null;
try { await LLM.runStructured({ system: 's', user: 'u', schema: {} }); } catch (e) { threw = e; }
ok('two failures throw the last one', threw?.message === 'model call failed: boom' && n === 2, { threw: threw?.message, n });

logged.length = 0;
LLM.configureRunner(async () => ({ quick: true }));
r = await LLM.runStructured({ system: 's', user: 'u', schema: {} });
ok('a quick answer is not logged', r?.quick === true && logged.length === 0, logged);

process.stderr.write = write;
LLM.configureRunner(null);

// Thinking is capped, never unbounded and never off.
const env = LLM.cliEnv({ base: { PATH: '/bin', MAX_THINKING_TOKENS: '31999' } });
ok('a memory call thinks within a cap (an unbounded one took 100 s for two lines)', env.MAX_THINKING_TOKENS === String(LLM.THINKING_TOKENS) && LLM.THINKING_TOKENS > 0 && LLM.THINKING_TOKENS <= 8000, env.MAX_THINKING_TOKENS);
ok('...whatever the process had set', env.MAX_THINKING_TOKENS !== '31999');
ok('...with no auto-memory and no updater', env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1' && env.DISABLE_AUTOUPDATER === '1' && env.PATH === '/bin');
ok('a call with no tools skips nonessential traffic', env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1');
ok('a call that may search keeps it (else WebSearch is refused)', !LLM.cliEnv({ tools: ['WebSearch'], base: {} }).CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC);
console.log(`memory-llm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
