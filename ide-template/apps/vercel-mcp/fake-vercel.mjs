// Test preload: stands in for api.vercel.com so the server can be driven without a network.
const seen = (globalThis.__calls = []);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : (input.href ?? input.url));
  if (u.hostname !== 'api.vercel.com') return realFetch(input, init);
  process.stderr.write(`CALL ${u.pathname}${u.search} auth=${init.headers?.Authorization?.slice(0, 12)}\n`);
  const p = u.pathname;
  if (p === '/v10/projects') return json({ projects: [{ id: 'prj_1', name: 'shop-site', framework: 'astro', link: { org: 'acme', repo: 'shop' }, updatedAt: 1760600000000, latestDeployments: [{ readyState: 'READY', target: 'production', url: 'shop-site-abc.vercel.app' }] }], pagination: { count: 1 } });
  if (p === '/v9/projects/shop-site') return json({ id: 'prj_1', name: 'shop-site', framework: 'astro', link: { type: 'github', org: 'acme', repo: 'shop', productionBranch: 'main' }, alias: [{ domain: 'shop.example.com', target: 'PRODUCTION' }], latestDeployments: [] });
  if (p === '/v7/deployments') return json({ deployments: [{ uid: 'dpl_1', name: 'shop-site', projectId: 'prj_1', readyState: 'ERROR', target: 'production', url: 'shop-site-xyz.vercel.app', created: 1760600000000, errorCode: 'BUILD_FAILED', errorMessage: 'Command "npm run build" exited with 1', meta: { githubCommitSha: 'abcdef0123456789', githubCommitRef: 'main', githubCommitMessage: 'Fix plates\n\nbody', githubCommitAuthorLogin: 'stan' } }], pagination: { count: 1 } });
  if (p.startsWith('/v13/deployments/')) { if (p.endsWith('missing')) return json({ error: { message: 'Deployment not found' } }, 404); return json({ uid: 'dpl_1', name: 'shop-site', readyState: 'READY', url: 'a.vercel.app' }); }
  if (p === '/v3/deployments/dpl_1/events') {
    const evs = [{ type: 'stderr', created: 3, text: 'Error: Unexpected token' }, { type: 'stdout', created: 2, text: 'DATABASE_URL=postgres://user:hunter2pass@db.example.com/app' }, { type: 'command', created: 1, text: 'npm run build' }, { type: 'deployment-state', created: 0, payload: {} }];
    return json(u.searchParams.get('direction') === 'backward' ? evs : [...evs].reverse());
  }
  if (p.endsWith('/runtime-logs')) {
    const enc = new TextEncoder(); let n = 0;
    return new Response(new ReadableStream({
      async pull(c) {
        n++; await new Promise((r) => setTimeout(r, 40));
        const lines = [{ level: 'info', message: 'hello', requestMethod: 'GET', requestPath: '/', responseStatusCode: 200, timestampInMs: 1760600000000 }, { level: 'error', message: 'boom Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', requestMethod: 'POST', requestPath: '/api', responseStatusCode: 500, timestampInMs: 1760600001000 }];
        c.enqueue(enc.encode(JSON.stringify(lines[n % 2]) + '\n'));   // never ends: the server must stop listening itself
      },
    }), { status: 200, headers: { 'content-type': 'application/stream+json' } });
  }
  if (p === '/v9/projects/shop-site/domains') return json({ domains: [{ name: 'shop.example.com', verified: true }, { name: 'new.example.com', verified: false, verification: [{ type: 'TXT', domain: '_vercel.example.com', value: 'vc-domain-verify=x' }] }], pagination: { count: 2 } });
  if (p === '/v6/domains/shop.example.com/config') return json({ misconfigured: true, configuredBy: null, recommendedCNAME: [{ rank: 1, value: 'cname.vercel-dns.com' }] });
  return json({ error: { message: 'unexpected ' + p } }, 500);
};
