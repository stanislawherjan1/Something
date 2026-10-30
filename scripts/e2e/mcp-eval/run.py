#!/usr/bin/env python3
"""
Context MCP, judged from the agent's side: real headless Claude Code sessions
(`claude -p`) connected to a live deployment as different people with
different consents, each given a task, graded on which tools it reached for
and what its answer (and the tool results) contain or must not contain.

  E2E_CLIENT=<client> python3 scripts/e2e/mcp-eval/run.py [scenario ids…]

Scenarios are per deployment (they name its people and its data), so they
live with the client config, never in this repo: clients/<client>/mcp-eval.json
(see scenarios.example.json for the shape). Each run is a real model turn on
the plan of whoever is signed in to Claude Code on this machine — run it after
a change to the endpoint, not in a loop. Grants are revoked at the end.
"""
import json, os, re, shutil, subprocess, sys, tempfile, concurrent.futures as cf

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
CLIENT = os.environ.get('E2E_CLIENT')
if not CLIENT: sys.exit('set E2E_CLIENT')
path = os.environ.get('MCP_EVAL_SCENARIOS') or os.path.join(REPO, 'clients', CLIENT, 'mcp-eval.json')
if not os.path.exists(path): sys.exit(f'no scenarios at {path} (see scenarios.example.json)')
sc = json.load(open(path))
only = set(sys.argv[1:])
if only: sc = [x for x in sc if x['id'] in only]
env = {**os.environ, 'E2E_CLIENT': CLIENT}
mint = os.path.join(HERE, 'mint.sh')
base, bot = subprocess.run(['bash', mint, '--info'], capture_output=True, text=True, env=env).stdout.split()[:2]
server = re.sub(r'[^A-Za-z0-9]+', '', bot) or 'Something'
runs = os.path.join(HERE, '.runs'); os.makedirs(runs, exist_ok=True)
# Every grant minted up front, one at a time: the sign-in endpoints are rate
# limited, and a session given an empty token runs without the server and
# improvises with whatever else it has — a failure that reads like the model's.
tokens = {}
for k in sorted({(x['who'], x['scopes']) for x in sc}):
    out = subprocess.run(['bash', mint, k[0], *k[1].split()], capture_output=True, text=True, env=env).stdout.split()
    if not out: sys.exit(f'could not mint a token for {k[0]} with {k[1]}')
    tokens[k] = out[0]
def subst(s): return s.replace('{bot}', bot)
def run(x):
    at = tokens[(x['who'], x['scopes'])]
    cfg = os.path.join(runs, f"{x['id']}.mcp.json")
    with open(cfg, 'w') as f: json.dump({'mcpServers': {server: {'type': 'http', 'url': f'{base}/mcp', 'headers': {'Authorization': f'Bearer {at}'}}}}, f)
    os.chmod(cfg, 0o600)
    cmd = ['claude', '-p', subst(x['prompt']), '--mcp-config', cfg, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--max-turns', '15',
           '--allowedTools', f'mcp__{server},Read,Glob,Grep', '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Task']
    # The agent works in a copy of the fixture outside this repository: inside
    # it, Claude Code would load the repo's own CLAUDE.md and hooks (meant for
    # agents changing this code), and the run would not be a user's project.
    work = tempfile.mkdtemp(prefix='mcp-eval-')
    shutil.copytree(os.path.join(HERE, 'fixtures', x.get('dir', 'plain')), work, dirs_exist_ok=True)
    try:
        # Headless Claude Code connects MCP servers in the background and lets
        # the model start before they are up; told to wait, every session
        # starts with the server's tools in hand, as a person's session would
        # after its first few seconds.
        raw = subprocess.run(cmd, capture_output=True, text=True, cwd=work, timeout=300, env={**os.environ, 'MCP_CONNECTION_NONBLOCKING': '0'}).stdout
    except subprocess.TimeoutExpired as e:
        raw = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or '')
    finally:
        os.remove(cfg)
        shutil.rmtree(work, ignore_errors=True)
    calls, results, final, status = [], [], '', None
    for line in raw.splitlines():
        try: ev = json.loads(line)
        except Exception: continue
        if ev.get('type') == 'system' and ev.get('subtype') == 'init':
            status = next((m.get('status') for m in ev.get('mcp_servers', []) if m.get('name') == server), 'absent')
        content = ev.get('message', {}).get('content') if isinstance(ev.get('message'), dict) else None
        if ev.get('type') == 'assistant' and isinstance(content, list):
            for b in content:
                if b.get('type') == 'tool_use': calls.append((b['name'].split('__')[-1], json.dumps(b.get('input', {}), ensure_ascii=False)[:160]))
        if ev.get('type') == 'user' and isinstance(content, list):
            for b in content:
                if b.get('type') == 'tool_result':
                    c = b.get('content'); results.append(c if isinstance(c, str) else json.dumps(c, ensure_ascii=False))
        if ev.get('type') == 'result': final = ev.get('result') or ''
    names = [c[0] for c in calls]
    fails = [] if status == 'connected' else [f'SERVER NOT CONNECTED ({status})']
    for alt in x.get('must_call', []):
        if not any(re.fullmatch(alt, n) for n in names): fails.append(f'did not call {alt}')
    for r in x.get('must', []):
        if not re.search(r, final): fails.append(f'answer lacks /{r}/')
    for r in x.get('must_not', []):
        if re.search(r, final): fails.append(f'ANSWER CONTAINS /{r}/')
        if any(re.search(r, t) for t in results): fails.append(f'TOOL RESULT CONTAINS /{r}/')
    return x, calls, final, fails
try:
    with cf.ThreadPoolExecutor(int(os.environ.get('MCP_EVAL_PARALLEL', '4'))) as ex:
        res = list(ex.map(run, sc))
finally:
    subprocess.run(['bash', mint, '--cleanup', *sorted({x['who'] for x in sc})], capture_output=True, env=env)
ok = 0
for x, calls, final, fails in res:
    ok += not fails
    print(f"{'PASS' if not fails else 'FAIL'}  {x['id']}  [{x['who']} · {x['scopes']}]")
    for n, a in calls: print(f"        → {n} {a}")
    print('        answer:', re.sub(r'\s+', ' ', final)[:300])
    for f in fails: print('        ✗', f)
print(f"\n{ok}/{len(res)} passed")
sys.exit(0 if ok == len(res) else 1)
