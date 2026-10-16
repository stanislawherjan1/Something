/**
 * Vercel REST API MCP Server — read-only
 *
 * Auth: a Vercel access token (Bearer). Env vars: VERCEL_ACCESS_TOKEN, and
 * VERCEL_TEAM_ID (optional: the team the token acts on; every call carries it
 * as ?teamId=). Vercel's own hosted MCP (mcp.vercel.com) only accepts OAuth
 * from clients Vercel approved, so this one talks to the REST API directly.
 *
 * ─────────────────────────────────────────────
 * READ tools:
 *   list_projects        — projects, optionally searched by name
 *   get_project          — one project: framework, repo, production branch, latest deployments
 *   list_deployments     — recent deployments, filter by project / state / target / branch
 *   get_deployment       — one deployment: state, error, commit, aliases
 *   get_build_logs       — build output of a deployment (why a build failed)
 *   get_runtime_logs     — what the running deployment logged, a short live window
 *   list_domains         — a project's domains and whether each is verified
 *   get_domain_config    — DNS state of a domain: misconfigured or not
 * ─────────────────────────────────────────────
 *
 * Nothing here changes anything on the account. Logs are untrusted text (wrapped
 * by wrapResult) and have secret-looking values masked before they are returned.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadCredentials } from '../_shared/broker-client.js';
import { wrapResult } from '../_shared/wrap-untrusted.js';

// Fetch credentials from the broker at startup (no-op when run standalone).
await loadCredentials();

// ─── Config ────────────────────────────────────────────────────────────────

const TOKEN   = (process.env.VERCEL_ACCESS_TOKEN ?? '').trim();
const TEAM_ID = (process.env.VERCEL_TEAM_ID ?? '').trim();
const API     = 'https://api.vercel.com';

if (!TOKEN) {
  console.error('[vercel-mcp] Missing VERCEL_ACCESS_TOKEN');
  process.exit(1);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const clamp = (n, lo, hi, dflt) => Math.min(Math.max(Number.isFinite(+n) ? +n : dflt, lo), hi);
// Path segments come from the model: never let one escape its place in the URL.
const seg = (v) => encodeURIComponent(String(v ?? '').trim());
const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : null);

function url(path, query = {}) {
  const u = new URL(API + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
  if (TEAM_ID) u.searchParams.set('teamId', TEAM_ID);
  return u;
}

async function api(path, query, { signal } = {}) {
  const res = await fetch(url(path, query), { headers: { Authorization: `Bearer ${TOKEN}` }, signal });
  if (!res.ok) {
    const hint = res.status === 401 ? ' (token invalid or expired)'
      : res.status === 403 ? ' (the token cannot see this: wrong team, or no access to the project)'
      : res.status === 404 ? ' (not found: check the name/ID, and the team)'
      : res.status === 429 ? ' (rate limited: wait a moment)' : '';
    let detail = '';
    try { detail = (await res.json())?.error?.message ?? ''; } catch { /* not JSON */ }
    throw new Error(`Vercel API error: ${res.status} ${res.statusText}${hint}${detail ? ` — ${detail}` : ''}`);
  }
  return res;
}

// Log lines can carry secrets (env dumps, auth headers, connection strings).
// Mask what looks like one before it reaches the model.
const SECRET_PATTERNS = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{12,}/gi, '$1 [masked]'],
  [/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[masked jwt]'],
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}\b/g, '[masked key]'],
  [/\b(ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[masked token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[masked key]'],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@\/]+:[^\s@\/]+@/gi, '$1://[masked]@'],
  [/((?:secret|token|password|passwd|api[_-]?key|private[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;&]{6,}/gi, '$1[masked]'],
];
function mask(text) {
  let out = String(text ?? '');
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

// A deployment, trimmed to what answers "what is this and did it work".
function slimDeployment(d) {
  return {
    id: d.uid ?? d.id,
    project: d.name,
    projectId: d.projectId,
    state: d.readyState ?? d.state,
    target: d.target ?? 'preview',
    url: d.url ? `https://${d.url}` : null,
    inspect: d.inspectorUrl ?? null,
    created: iso(d.created ?? d.createdAt),
    ready: iso(d.ready ?? d.readyAt),
    source: d.source ?? null,
    error: d.errorCode || d.errorMessage ? { code: d.errorCode ?? null, message: d.errorMessage ?? null } : null,
    commit: d.meta?.githubCommitSha || d.meta?.gitlabCommitSha || d.meta?.bitbucketCommitSha
      ? {
          sha: (d.meta.githubCommitSha || d.meta.gitlabCommitSha || d.meta.bitbucketCommitSha).slice(0, 10),
          branch: d.meta.githubCommitRef || d.meta.gitlabCommitRef || d.meta.bitbucketCommitRef || null,
          message: (d.meta.githubCommitMessage || d.meta.gitlabCommitMessage || d.meta.bitbucketCommitMessage || '').split('\n')[0].slice(0, 160),
          author: d.meta.githubCommitAuthorLogin || d.meta.githubCommitAuthorName || null,
        }
      : null,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_projects',
    description: 'List Vercel projects, newest activity first. Search by name to find one.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Part of the project name' },
        limit:  { type: 'number', description: 'How many to return (default 20, max 50)' },
      },
    },
  },
  {
    name: 'get_project',
    description: 'Details of one project: framework, connected repository, production branch, domains and its latest deployments.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project name or ID' } },
      required: ['project'],
    },
  },
  {
    name: 'list_deployments',
    description: 'Recent deployments, newest first. Filter by project, state (ERROR, BUILDING, READY, QUEUED, CANCELED), target (production or preview) or branch.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID (all projects if omitted)' },
        state:   { type: 'string', enum: ['BUILDING', 'ERROR', 'INITIALIZING', 'QUEUED', 'READY', 'CANCELED'], description: 'Only deployments in this state' },
        target:  { type: 'string', enum: ['production', 'staging'], description: 'production or staging (preview deployments have no target)' },
        branch:  { type: 'string', description: 'Only this git branch' },
        limit:   { type: 'number', description: 'How many to return (default 10, max 30)' },
      },
    },
  },
  {
    name: 'get_deployment',
    description: 'One deployment by its ID (dpl_...) or its URL: state, error, commit, link to the Vercel dashboard.',
    inputSchema: {
      type: 'object',
      properties: { deployment: { type: 'string', description: 'Deployment ID (dpl_...) or hostname (my-app-abc123.vercel.app)' } },
      required: ['deployment'],
    },
  },
  {
    name: 'get_build_logs',
    description: 'Build output of a deployment: the commands that ran and what they printed. By default the end of the log, which is where a failed build explains itself.',
    inputSchema: {
      type: 'object',
      properties: {
        deployment: { type: 'string', description: 'Deployment ID (dpl_...) or hostname' },
        lines:      { type: 'number', description: 'How many lines (default 150, max 400)' },
        from:       { type: 'string', enum: ['end', 'start'], description: '"end" (default) for the last lines, "start" for the first' },
      },
      required: ['deployment'],
    },
  },
  {
    name: 'get_runtime_logs',
    description: 'What a running deployment logged: requests, errors, function output. Vercel streams these live, so this listens for a few seconds and returns what arrived. Only recent activity shows up.',
    inputSchema: {
      type: 'object',
      properties: {
        project:    { type: 'string', description: 'Project name or ID' },
        deployment: { type: 'string', description: 'Deployment ID (dpl_...)' },
        seconds:    { type: 'number', description: 'How long to listen (default 8, max 20)' },
        lines:      { type: 'number', description: 'Stop after this many lines (default 100, max 300)' },
        level:      { type: 'string', enum: ['error', 'warning', 'info'], description: 'Only this level and worse (error = errors and fatals)' },
      },
      required: ['project', 'deployment'],
    },
  },
  {
    name: 'list_domains',
    description: 'Domains attached to a project, and whether each is verified.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Project name or ID' } },
      required: ['project'],
    },
  },
  {
    name: 'get_domain_config',
    description: 'DNS state of a domain: whether it points at Vercel correctly. Use it when a site is not reachable on its own domain.',
    inputSchema: {
      type: 'object',
      properties: { domain: { type: 'string', description: 'The domain, e.g. example.com' } },
      required: ['domain'],
    },
  },
];

// ─── Tool handlers ─────────────────────────────────────────────────────────

const LEVEL_RANK = { trace: 0, debug: 0, info: 1, warning: 2, error: 3, fatal: 3 };

async function handleTool(name, args) {
  switch (name) {

    case 'list_projects': {
      const limit = clamp(args.limit, 1, 50, 20);
      const data = await (await api('/v10/projects', { search: args.search, limit })).json();
      const list = Array.isArray(data) ? data : data.projects ?? [];
      return {
        count: list.length,
        projects: list.map((p) => ({
          id: p.id,
          name: p.name,
          framework: p.framework ?? null,
          repo: p.link?.repo ? `${p.link.org ?? ''}/${p.link.repo}` : null,
          updated: iso(p.updatedAt),
          latestDeployment: p.latestDeployments?.[0]
            ? { state: p.latestDeployments[0].readyState, target: p.latestDeployments[0].target ?? 'preview', url: p.latestDeployments[0].url ? `https://${p.latestDeployments[0].url}` : null }
            : null,
        })),
      };
    }

    case 'get_project': {
      const p = await (await api(`/v9/projects/${seg(args.project)}`)).json();
      return {
        id: p.id,
        name: p.name,
        framework: p.framework ?? null,
        nodeVersion: p.nodeVersion ?? null,
        repo: p.link?.repo ? { type: p.link.type, name: `${p.link.org ?? ''}/${p.link.repo}`, productionBranch: p.link.productionBranch ?? null } : null,
        buildCommand: p.buildCommand ?? null,
        outputDirectory: p.outputDirectory ?? null,
        rootDirectory: p.rootDirectory ?? null,
        domains: (p.alias ?? []).map((a) => ({ domain: a.domain, target: a.target ?? a.environment ?? null })),
        paused: !!p.paused,
        updated: iso(p.updatedAt),
        latestDeployments: (p.latestDeployments ?? []).slice(0, 5).map((d) => ({
          id: d.id, state: d.readyState, target: d.target ?? 'preview', url: d.url ? `https://${d.url}` : null, created: iso(d.createdAt),
        })),
      };
    }

    case 'list_deployments': {
      const limit = clamp(args.limit, 1, 30, 10);
      const data = await (await api('/v7/deployments', {
        projectId: args.project, state: args.state, target: args.target, branch: args.branch, limit,
      })).json();
      return { count: (data.deployments ?? []).length, deployments: (data.deployments ?? []).map(slimDeployment) };
    }

    case 'get_deployment': {
      return slimDeployment(await (await api(`/v13/deployments/${seg(args.deployment)}`)).json());
    }

    case 'get_build_logs': {
      const lines = clamp(args.lines, 1, 400, 150);
      const fromStart = args.from === 'start';
      const events = await (await api(`/v3/deployments/${seg(args.deployment)}/events`, {
        direction: fromStart ? 'forward' : 'backward', limit: lines, follow: 0,
      })).json();
      let out = (Array.isArray(events) ? events : [])
        .filter((e) => ['stdout', 'stderr', 'command', 'fatal', 'exit'].includes(e.type))
        .map((e) => ({ at: e.created ?? e.payload?.created, type: e.type, text: e.text ?? e.payload?.text ?? '' }))
        .filter((e) => e.text);
      if (!fromStart) out = out.reverse();           // "backward" arrives newest first
      return {
        lines: out.length,
        from: fromStart ? 'start' : 'end',
        log: out.map((e) => `${e.type === 'stderr' || e.type === 'fatal' ? '[err] ' : ''}${mask(e.text)}`).join('\n'),
      };
    }

    case 'get_runtime_logs': {
      const seconds = clamp(args.seconds, 1, 20, 8);
      const maxLines = clamp(args.lines, 1, 300, 100);
      const minRank = args.level === 'error' ? 3 : args.level === 'warning' ? 2 : args.level === 'info' ? 1 : 0;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), seconds * 1000);
      const rows = [];
      try {
        const res = await api(`/v1/projects/${seg(args.project)}/deployments/${seg(args.deployment)}/runtime-logs`, {}, { signal: ctl.signal });
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body) {
          if (ctl.signal.aborted) break;               // time is up or the line cap was hit: stop reading, whatever the transport does
          buf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let r; try { r = JSON.parse(line); } catch { continue; }
            if ((LEVEL_RANK[r.level] ?? 1) < minRank) continue;
            rows.push(r);
            if (rows.length >= maxLines) ctl.abort();
          }
        }
      } catch (err) {
        if (err.name !== 'AbortError') throw err;     // our own timeout or line cap is the normal way out
      } finally {
        clearTimeout(timer);
      }
      return {
        listenedSeconds: seconds,
        lines: rows.length,
        note: rows.length ? undefined : 'Nothing arrived in this window: the deployment may have had no traffic just now. Visit the site and try again.',
        log: rows.map((r) => `${iso(r.timestampInMs)} ${String(r.level).toUpperCase()} ${r.requestMethod ?? ''} ${r.requestPath ?? ''} ${r.responseStatusCode || ''} ${mask(r.message)}`.replace(/\s+/g, ' ').trim()).join('\n'),
      };
    }

    case 'list_domains': {
      const data = await (await api(`/v9/projects/${seg(args.project)}/domains`, { limit: 100 })).json();
      return {
        count: (data.domains ?? []).length,
        domains: (data.domains ?? []).map((d) => ({
          name: d.name, verified: !!d.verified,
          redirect: d.redirect ?? null, branch: d.gitBranch ?? null,
          verification: d.verified ? undefined : (d.verification ?? []).map((v) => ({ type: v.type, domain: v.domain, value: v.value })),
        })),
      };
    }

    case 'get_domain_config': {
      const c = await (await api(`/v6/domains/${seg(args.domain)}/config`)).json();
      return {
        domain: args.domain,
        misconfigured: !!c.misconfigured,
        configuredBy: c.configuredBy ?? null,
        recommendedCNAME: c.recommendedCNAME ?? undefined,
        recommendedIPv4: c.recommendedIPv4 ?? undefined,
        nameservers: c.nameservers ?? undefined,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── Server ────────────────────────────────────────────────────────────────

const server = new Server({ name: 'vercel-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    return wrapResult(await handleTool(name, args ?? {}), 'vercel');
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
