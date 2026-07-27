#!/usr/bin/env node
/**
 * miniapp-mcp — lets the assistant build persistent mini apps (sidebar tabs).
 *
 * save_as_tab writes an OpenUI Lang spec + data to
 *   <PROJECT_DIR>[/users/<slug>]/.claude/miniapps/<id>.json
 * and the workspace UI picks it up live (chokidar → SSE → sidebar refetch),
 * so the app appears under "Mini Apps" with no further step.
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
const COMPONENTS = ['App', 'Tabs', 'Card', 'Grid', 'Text', 'Badge', 'Stat', 'DataTable', 'List', 'LineChart', 'BarChart', 'Button', 'Form'];
// OpenUI Lang builtin helper functions (lang-core BUILTINS + Each) — legal in
// specs but not UI components.
const BUILTINS = ['Count', 'First', 'Last', 'Sum', 'Avg', 'Min', 'Max', 'Abs', 'Ceil', 'Floor', 'Round', 'Sort', 'Filter', 'Each'];
// Sidebar icon choices — kebab-case lucide ids the UI knows how to render.
// Must stay in sync with ICONS in frontend MiniAppsList.jsx.
const ICONS = ['layout-grid', 'shopping-cart', 'trending-up', 'bar-chart', 'calendar', 'check-square', 'list-todo', 'mail', 'users', 'package', 'dollar-sign', 'cloud-sun', 'globe', 'zap', 'heart', 'star', 'clock'];

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG_RE = /^[a-z0-9-]+$/;
// Mirror the wsapi state-route caps (routes/miniapps.js) — same store.
const MAX_STATE_ENTRIES = 500;
const MAX_STATE_BYTES = 64 * 1024;

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
  Button(label: string, say: string)               click sends "say" to you (the assistant) in chat — you are the backend; act on it and update the app
  Form(stateKey: string, fields: {name,label,type?}[], submitLabel?: string, notify?: string)
                                                   inputs the user fills; submit APPENDS the entry to app state under stateKey (instant, no LLM); if notify is set, that text is also sent to you in chat
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
  { "key": "expenses", "source": "state" }                   app state: rows the USER adds via Form clicks; read it back with get_tab_state
Only same-origin api:/api/... paths are allowed as live sources.

Interactive pattern (user acts in the UI, you act on it):
- Form appends entries to state instantly — the widget updates without you.
- Read what the user clicked/typed with get_tab_state (on demand or from a
  scheduled reminder), then act (compute, call tools) and update the app via
  save_as_tab (same id) if its layout/data must change.

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
      'Save a mini app as a persistent sidebar tab ("Mini Apps"). The tab appears in the ' +
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
    name: 'start_tab',
    description:
      'Announce a mini app you are ABOUT to build: the tab appears in the sidebar immediately with a ' +
      'building spinner. Call this FIRST (before gathering data), then finish with save_as_tab (same id), ' +
      'which replaces the placeholder. Also briefly tell the user in chat that you are building the app.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Same stable slug you will pass to save_as_tab' },
        name: { type: 'string', description: 'Tab label' },
        icon: {
          type: 'string',
          enum: ['layout-grid', 'shopping-cart', 'trending-up', 'bar-chart', 'calendar', 'check-square', 'list-todo', 'mail', 'users', 'package', 'dollar-sign', 'cloud-sun', 'globe', 'zap', 'heart', 'star', 'clock'],
          description: 'Sidebar icon (same choice you will use in save_as_tab)',
        },
      },
      required: ['id', 'name'],
    },
  },
  {
    name: 'append_tab_state',
    description:
      'Append an entry to a mini app\'s state list — the SAME store the app\'s Form writes to, so the ' +
      'widget updates live. Use when the user asks you (in chat) to add a record the app tracks: ' +
      '"dodaj lead Acme 25k" → append_tab_state("leads", {key:"leads", entry:{...}}).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The app id' },
        key: { type: 'string', description: 'State list name (the Form\'s stateKey / the "state" dataSource key)' },
        entry: { type: 'object', description: 'The row to append — same shape the app\'s Form produces', additionalProperties: true },
      },
      required: ['id', 'key', 'entry'],
    },
  },
  {
    name: 'set_tab_state',
    description:
      'Overwrite one key in a mini app\'s state (e.g. replace a cleaned-up list, reset a counter). ' +
      'Prefer append_tab_state for adding records.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The app id' },
        key: { type: 'string', description: 'State key to set' },
        value: { description: 'New value (array, object, string, number, null)' },
      },
      required: ['id', 'key'],
    },
  },
  {
    name: 'get_tab_state',
    description:
      'Read a mini app\'s user-generated state: everything the user added through the app\'s Form ' +
      'components (and Button context). Use it to act on what the user clicked/typed — e.g. a reminder ' +
      'that reads state, computes totals, and updates the app or alerts the user.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The app id' } },
      required: ['id'],
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
        if (src !== 'embedded' && src !== 'state' && !(src.startsWith('api:/api/') && !src.includes('//'))) {
          return fail(`Bad data source "${src}" for key "${s?.key}" — use "embedded", "state" or "api:/api/...".`);
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
      // NOTE: no `status` field — a full save always clears any 'building'
      // placeholder start_tab left behind.
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
      return ok(`Saved. "${label}" is now in the sidebar under Mini Apps${created ? ' (updated in place)' : ''}.`);
    }

    if (name === 'start_tab') {
      const id = String(args.id || '').trim();
      const label = String(args.name || '').trim();
      if (!ID_RE.test(id)) return fail(`Bad id "${id}" — use lowercase letters, digits and dashes (max 64 chars).`);
      if (!label || label.length > 80) return fail('Bad name — 1..80 characters.');
      const icon = ICONS.includes(args.icon) ? args.icon : 'layout-grid';
      const file = path.join(appsDir(), `${id}.json`);
      let prev = {};
      try { prev = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* new */ }
      await writeJsonAtomic(file, {
        ...prev,
        id,
        name: label,
        icon: prev.icon || icon,
        status: 'building',
        created: prev.created || new Date().toISOString(),
        updated: new Date().toISOString(),
        order: prev.order ?? 0,
      });
      return ok(`Placeholder up — "${label}" shows in the sidebar with a building spinner. Finish with save_as_tab("${id}", ...).`);
    }

    if (name === 'append_tab_state' || name === 'set_tab_state') {
      const id = String(args.id || '').trim();
      const key = String(args.key || '').trim();
      if (!ID_RE.test(id)) return fail(`Bad id "${id}".`);
      if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) return fail(`Bad state key "${key}".`);
      const file = path.join(appsDir(), `${id}.state.json`);
      let state = {};
      try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
      } catch { /* fresh state */ }
      if (name === 'append_tab_state') {
        if (!args.entry || typeof args.entry !== 'object' || Array.isArray(args.entry)) return fail('entry must be an object.');
        const list = Array.isArray(state[key]) ? state[key] : [];
        if (list.length >= MAX_STATE_ENTRIES) return fail(`State list "${key}" is full (${MAX_STATE_ENTRIES}).`);
        list.push({ ...args.entry, _ts: new Date().toISOString() });
        state[key] = list;
      } else {
        state[key] = args.value ?? null;
      }
      const serialized = JSON.stringify(state, null, 2);
      if (serialized.length > MAX_STATE_BYTES) return fail('State too large (64KB cap).');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.tmp', serialized);
      await fs.rename(file + '.tmp', file);
      return ok(`State updated — "${key}" in "${id}". The open widget refreshes live.`);
    }

    if (name === 'get_tab_state') {
      const id = String(args.id || '').trim();
      if (!ID_RE.test(id)) return fail(`Bad id "${id}".`);
      try {
        const raw = await fs.readFile(path.join(appsDir(), `${id}.state.json`), 'utf8');
        return ok(raw);
      } catch {
        return ok('{}');   // no user input yet — empty state, not an error
      }
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
      try { await fs.unlink(path.join(appsDir(), `${id}.state.json`)); } catch { /* no state */ }
      return ok(`Deleted "${id}" — the tab is gone from the sidebar.`);
    }

    return fail(`Unknown tool: ${name}`);
  } catch (err) {
    return fail(`${name} failed: ${err.message}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
