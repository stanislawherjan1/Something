#!/usr/bin/env node
/**
 * miniapp-mcp — lets the assistant build persistent mini apps (sidebar tabs).
 *
 * save_as_tab writes an OpenUI Lang spec + data to
 *   <PROJECT_DIR>[/users/<slug>]/.claude/miniapps/<id>.json
 * and the workspace UI picks it up live (chokidar → SSE → sidebar refetch),
 * so the app appears under "Your Mini Apps" with no further step.
 *
 * Scoping: IDE_ACTOR_SLUG (injected per turn by the spawner) → personal tree
 * in team mode; unset → shared root (solo/legacy). This mirrors the
 * users/<slug>/ convention — enforcement here is the tool's job, the
 * PreToolUse scope-guard does not cover direct MCP writes.
 *
 * The spec may only use the whitelisted component tags (mirrors
 * frontend/src/lib/miniapp/library.jsx). Anything else is rejected at save
 * time so a broken tab never lands in the sidebar.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';

// Must stay in sync with MINIAPP_COMPONENT_NAMES in the frontend library.
const COMPONENTS = ['App', 'Tabs', 'Card', 'Grid', 'Text', 'Badge', 'Stat', 'DataTable', 'List', 'LineChart', 'BarChart'];
// OpenUI Lang builtin helper functions (lang-core BUILTINS + Each) — legal in
// specs but not UI components.
const BUILTINS = ['Count', 'First', 'Last', 'Sum', 'Avg', 'Min', 'Max', 'Abs', 'Ceil', 'Floor', 'Round', 'Sort', 'Filter', 'Each'];
// Sidebar icon choices — kebab-case lucide ids the UI knows how to render.
// Must stay in sync with ICONS in frontend MiniAppsList.jsx.
const ICONS = ['layout-grid', 'shopping-cart', 'trending-up', 'bar-chart', 'calendar', 'check-square', 'list-todo', 'mail', 'users', 'package', 'dollar-sign', 'cloud-sun', 'globe', 'zap', 'heart', 'star', 'clock'];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG_RE = /^[a-z0-9-]+$/;

function actorSlug() {
  const s = (process.env.IDE_ACTOR_SLUG || '').trim();
  return SLUG_RE.test(s) ? s : '';
}

function appsDir() {
  const slug = actorSlug();
  return slug
    ? path.join(PROJECT_DIR, 'users', slug, '.claude', 'miniapps')
    : path.join(PROJECT_DIR, '.claude', 'miniapps');
}

const ok   = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

// Pre-flight the spec without a full parse: every capitalized call must be a
// whitelisted component or an OpenUI Lang builtin, and the program must define
// root. The renderer's error boundary is the second net.
function specProblems(spec) {
  const problems = [];
  if (!/^\s*root\s*=/m.test(spec)) problems.push('missing "root = App([...])" statement');
  const seen = new Set();
  for (const m of spec.matchAll(/\b([A-Z][A-Za-z0-9]*)\s*\(/g)) seen.add(m[1]);
  const unknown = [...seen].filter(t => !COMPONENTS.includes(t) && !BUILTINS.includes(t));
  if (unknown.length) problems.push(`unknown components: ${unknown.join(', ')} (allowed: ${COMPONENTS.join(', ')})`);
  return problems;
}

const GRAMMAR = `The spec is an OpenUI Lang program (NOT JSX, NOT JSON):
- One statement per line: \`name = Component(arg1, arg2, ...)\`
- \`root = App([...])\` is the entry point and MUST be present (write it first).
- Arguments are POSITIONAL, in exactly the order shown below. No named args —
  \`Stat(label: "x")\` silently breaks. Skip optional args with null or omit
  trailing ones.
- Strings use double quotes; arrays [a, b]; reference other statements by name.

Component signatures (the ONLY allowed components — anything else is rejected):
  App(children: any[])                             app root, vertical stack
  Tabs(labels: string[], children: any[])          segmented switcher; labels[i] shows children[i] (2-6 tabs)
  Card(title?: string|null, children?: any[])      titled section container
  Grid(columns?: 1-4, children?: any[])            responsive grid (stat rows)
  Text(content: string, muted?: boolean)           paragraph
  Badge(label: string, tone?: "neutral"|"success"|"warning"|"danger")
  Stat(label: string, value: string, delta?: string, hint?: string)   KPI tile (value pre-formatted)
  DataTable(dataKey: string, columns?: {key,label?}[], empty?: string)
  List(dataKey: string, titleKey: string, subtitleKey?: string, badgeKey?: string, empty?: string)
  LineChart(dataKey: string, x: string, y: string, height?: 120-480)  trend over time
  BarChart(dataKey: string, x: string, y: string, height?: 120-480)   category comparison

Data binding: DataTable/List/charts read rows via their dataKey (first arg)
from the app's data sources — never inline rows into the spec. Provide rows in
"data" (snapshot you computed this turn) and/or declare live sources in
"dataSources":
  { "key": "orders", "source": "embedded" }                  snapshot only
  { "key": "reminders", "source": "api:/api/reminders" }     re-fetched from the workspace API on open/refresh
Only same-origin api:/api/... paths are allowed as live sources.

Example spec:
  root = App([stats, shipping])
  stats = Grid(2, [s1, s2])
  s1 = Stat("Orders today", "17", "+4")
  s2 = Stat("Revenue", "2 840", null, "vs 2 610 last week")
  shipping = Card("To ship", [orders])
  orders = List("orders", "customer", "items", "status", "Nothing to ship")

Tabs example (alternate views, e.g. two cities):
  root = App([switcher])
  switcher = Tabs(["Krakow", "Warsaw"], [kra, waw])
  kra = Card(null, [kraChart])
  kraChart = LineChart("krakow", "day", "tempMax", 200)
  waw = Card(null, [wawChart])
  wawChart = LineChart("warsaw", "day", "tempMax", 200)`;

const TOOLS = [
  {
    name: 'save_as_tab',
    description:
      'Save a mini app as a persistent sidebar tab ("Your Mini Apps"). The tab appears in the ' +
      'workspace sidebar automatically — tell the user it is there, do not paste the spec in chat. ' +
      'Rebuild an existing app by saving with the same id.\n\n' + GRAMMAR,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable slug, lowercase [a-z0-9-], e.g. "orders-today". Reuse to update.' },
        name: { type: 'string', description: 'Tab label shown in the sidebar, e.g. "Orders"' },
        icon: {
          type: 'string',
          enum: ['layout-grid', 'shopping-cart', 'trending-up', 'bar-chart', 'calendar', 'check-square', 'list-todo', 'mail', 'users', 'package', 'dollar-sign', 'cloud-sun', 'globe', 'zap', 'heart', 'star', 'clock'],
          description: 'Sidebar icon — pick the one matching the app\'s topic so tabs are visually distinct (weather → cloud-sun, orders → shopping-cart, KPI → trending-up, tasks → check-square…)',
        },
        spec: { type: 'string', description: 'OpenUI Lang component tree using ONLY the allowed tags' },
        data: {
          type: 'object',
          description: 'Snapshot rows per dataKey, e.g. {"orders": [{"customer": "...", "status": "paid"}]}',
          additionalProperties: true,
        },
        dataSources: {
          type: 'array',
          description: 'Declared sources per dataKey ("embedded" or "api:/api/...")',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              source: { type: 'string' },
            },
            required: ['key', 'source'],
          },
        },
      },
      required: ['id', 'name', 'spec'],
    },
  },
  {
    name: 'list_tabs',
    description: 'List the current user\'s mini apps (sidebar tabs): id, name, data sources.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_tab',
    description: 'Delete a mini app (sidebar tab) by id. The tab disappears from the sidebar.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The app id to delete' } },
      required: ['id'],
    },
  },
];

const server = new Server(
  { name: 'miniapp-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === 'save_as_tab') {
      const id = String(args.id || '').trim();
      const label = String(args.name || '').trim();
      const spec = String(args.spec || '');
      if (!ID_RE.test(id)) return fail(`Bad id "${id}" — use lowercase letters, digits and dashes (max 64 chars).`);
      if (!label || label.length > 80) return fail('Bad name — 1..80 characters.');
      if (!spec.trim()) return fail('Empty spec.');
      const problems = specProblems(spec);
      if (problems.length) return fail(`Spec rejected: ${problems.join('; ')}.`);

      const sources = Array.isArray(args.dataSources) ? args.dataSources : [];
      for (const s of sources) {
        const src = String(s?.source || '');
        if (src !== 'embedded' && !(src.startsWith('api:/api/') && !src.includes('//'))) {
          return fail(`Bad data source "${src}" for key "${s?.key}" — use "embedded" or "api:/api/...".`);
        }
      }

      const dir = appsDir();
      const file = path.join(dir, `${id}.json`);
      let created = null, order = 0;
      try {
        const prev = JSON.parse(await fs.readFile(file, 'utf8'));
        created = prev.created || null;
        order = prev.order ?? 0;
      } catch { /* new app */ }

      const icon = ICONS.includes(args.icon) ? args.icon : 'layout-grid';
      await writeJsonAtomic(file, {
        id,
        name: label,
        icon,
        spec,
        dataSources: sources,
        data: (args.data && typeof args.data === 'object') ? args.data : {},
        created: created || new Date().toISOString(),
        updated: new Date().toISOString(),
        order,
      });
      return ok(`Saved. "${label}" is now in the sidebar under Your Mini Apps${created ? ' (updated in place)' : ''}.`);
    }

    if (name === 'list_tabs') {
      const dir = appsDir();
      let files = [];
      try { files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')); } catch { /* no dir yet */ }
      const apps = [];
      for (const f of files) {
        try {
          const a = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
          apps.push({ id: a.id, name: a.name, dataSources: a.dataSources || [], updated: a.updated || null });
        } catch { /* skip corrupt */ }
      }
      return ok(apps.length ? JSON.stringify(apps, null, 2) : 'No mini apps yet.');
    }

    if (name === 'delete_tab') {
      const id = String(args.id || '').trim();
      if (!ID_RE.test(id)) return fail(`Bad id "${id}".`);
      const file = path.join(appsDir(), `${id}.json`);
      try { await fs.unlink(file); } catch { return fail(`No mini app "${id}".`); }
      return ok(`Deleted "${id}" — the tab is gone from the sidebar.`);
    }

    return fail(`Unknown tool: ${name}`);
  } catch (err) {
    return fail(`${name} failed: ${err.message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
