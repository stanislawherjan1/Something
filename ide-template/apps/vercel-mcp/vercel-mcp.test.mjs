/**
 * vercel-mcp, end to end through a real MCP client: the server runs as a child
 * process with api.vercel.com replaced by fake-vercel.mjs. Checks what the model
 * gets back, that nothing is writable, that secrets are masked, that a runtime
 * log stream that never ends is cut off, and that errors say what to do.
 *
 * Run: node apps/vercel-mcp/vercel-mcp.test.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${String(extra).slice(0, 500)}` : ''}`); } };

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', join(here, 'fake-vercel.mjs'), join(here, 'index.js')],
    env: { PATH: process.env.PATH, ...env },
    stderr: 'pipe',
  });
  const stderr = []; transport.stderr?.on('data', (b) => stderr.push(String(b)));
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const text = r.content[0].text;
  const body = text.replace(/^[\s\S]*?<untrusted-content[^>]*>\s*/, '').replace(/\s*<\/untrusted-content>\s*$/, '');
  let data = null; try { data = JSON.parse(body); } catch { /* not JSON */ }
  return { text, data, isError: !!r.isError };
};

// 1. no token: the server refuses to start rather than run unauthenticated
{
  let failed = false;
  try { const x = await connect({}); await x.close(); } catch { failed = true; }
  ok('refuses to start without a token', failed);
}

const { client, stderr, close } = await connect({ VERCEL_ACCESS_TOKEN: 'tok_test_123456', VERCEL_TEAM_ID: 'team_abc' });

const tools = (await client.listTools()).tools.map((t) => t.name);
ok('exposes the eight read tools', tools.length === 8 && ['list_projects', 'get_project', 'list_deployments', 'get_deployment', 'get_build_logs', 'get_runtime_logs', 'list_domains', 'get_domain_config'].every((n) => tools.includes(n)), tools);
ok('nothing that writes', !tools.some((n) => /^(create|update|delete|remove|redeploy|set|add|cancel|promote|rollback)/.test(n)), tools);

const projects = await call(client, 'list_projects', { search: 'shop' });
ok('projects are trimmed to what matters', projects.data?.projects?.[0]?.name === 'shop-site' && projects.data.projects[0].repo === 'acme/shop' && projects.data.projects[0].latestDeployment.state === 'READY', projects.text);
ok('every call carries the token and the team', stderr.join('').includes('auth=Bearer tok_t') && stderr.join('').includes('teamId=team_abc'), stderr.join(''));

const proj = await call(client, 'get_project', { project: 'shop-site' });
ok('project detail has repo, branch and domains', proj.data?.repo?.productionBranch === 'main' && proj.data.domains[0].domain === 'shop.example.com', proj.text);

const deps = await call(client, 'list_deployments', { project: 'prj_1', state: 'ERROR' });
const d0 = deps.data?.deployments?.[0];
ok('a failed deployment shows its error and commit', d0?.state === 'ERROR' && d0.error.code === 'BUILD_FAILED' && d0.commit.sha === 'abcdef0123' && d0.commit.message === 'Fix plates', deps.text);
ok('the url carries https', d0?.url === 'https://shop-site-xyz.vercel.app', d0?.url);

const dep = await call(client, 'get_deployment', { deployment: 'dpl_1' });
ok('one deployment by id', dep.data?.state === 'READY', dep.text);
const missing = await call(client, 'get_deployment', { deployment: 'missing' });
ok('a 404 says what to check', missing.isError && /not found.*name\/ID.*team/i.test(missing.text), missing.text);

const build = await call(client, 'get_build_logs', { deployment: 'dpl_1', lines: 10 });
ok('build log reads in order, errors marked', build.data?.log.split('\n')[0] === 'npm run build' && /\[err\] Error: Unexpected token/.test(build.data.log), build.text);
ok('a connection string in the log is masked', !build.text.includes('hunter2pass') && build.data.log.includes('postgres://[masked]@'), build.text);

const t0 = Date.now();
const rt = await call(client, 'get_runtime_logs', { project: 'prj_1', deployment: 'dpl_1', seconds: 1, lines: 50 });
ok('a stream that never ends is cut off', Date.now() - t0 < 4000 && rt.data?.lines > 0, `${Date.now() - t0} ms ${rt.text}`);
ok('a token in a runtime log is masked', !rt.text.includes('abcdefghijklmnopqrstuvwxyz0123'), rt.text);
const rtErr = await call(client, 'get_runtime_logs', { project: 'prj_1', deployment: 'dpl_1', seconds: 1, level: 'error' });
ok('level=error keeps only errors', rtErr.data?.log && rtErr.data.log.split('\n').every((l) => l.includes('ERROR')), rtErr.text);
const capped = await call(client, 'get_runtime_logs', { project: 'prj_1', deployment: 'dpl_1', seconds: 10, lines: 3 });
ok('the line cap ends it early', capped.data?.lines === 3, capped.text);

const doms = await call(client, 'list_domains', { project: 'shop-site' });
ok('an unverified domain says how to verify it', doms.data?.domains?.[1]?.verified === false && doms.data.domains[1].verification[0].type === 'TXT', doms.text);
const cfg = await call(client, 'get_domain_config', { domain: 'shop.example.com' });
ok('a misconfigured domain says what to point it at', cfg.data?.misconfigured === true && cfg.data.recommendedCNAME[0].value === 'cname.vercel-dns.com', cfg.text);

// a path-looking argument cannot climb out of its place in the URL
stderr.length = 0;
await call(client, 'get_project', { project: '../../v2/teams' });
ok('an argument cannot rewrite the path', !stderr.join('').includes('/v2/teams') && stderr.join('').includes('%2F'), stderr.join(''));

const wrapped = projects.text.includes('<untrusted-content');
ok('results are wrapped as untrusted content', wrapped, projects.text.slice(0, 120));

await close();
console.log(`vercel-mcp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
