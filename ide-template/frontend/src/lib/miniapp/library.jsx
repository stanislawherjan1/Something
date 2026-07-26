/**
 * Mini-app component library — the ONLY components an AI-built app may use.
 *
 * The model emits OpenUI Lang — a statement language (`root = App([...])`,
 * one `name = Component(args...)` per line, POSITIONAL args mapped to props in
 * Zod key order, refs + hoisting). @openuidev/react-lang parses it and renders
 * through these definitions; props are validated against each Zod schema, so a
 * spec can never execute arbitrary code — it can only compose what's
 * whitelisted here (same guarantee as artifacts). NOTE: renderers receive
 * `{ props, renderNode }` (not spread props); nested elements render via
 * `renderNode(props.children)`.
 *
 * Data flow: specs reference data by key (`dataKey="orders"`) instead of
 * embedding query logic. MiniAppView resolves the app's dataSources (embedded
 * snapshot or same-origin /api fetch) into a map and provides it via
 * MiniAppDataContext; components look their key up at render time. Live
 * refresh = re-fetch sources, context updates, widgets re-render. This keeps
 * the renderer independent of OpenUI's tool/Query runtime (slice 2).
 */

import { createContext, useContext } from 'react';
import { defineComponent, createLibrary } from '@openuidev/react-lang';
import { z } from 'zod';
import {
  LineChart as RLineChart, Line, BarChart as RBarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from 'recharts';
import { cn } from '@/lib/utils';

export const MiniAppDataContext = createContext({ data: {}, loading: false, errors: {} });

// Resolve a dataKey to rows. Accepts arrays directly, or common envelope
// shapes ({ items: [...] }, { rows: [...] }, { data: [...] }).
function useRows(dataKey) {
  const { data, loading, errors } = useContext(MiniAppDataContext);
  const raw = dataKey ? data?.[dataKey] : null;
  const rows = Array.isArray(raw) ? raw
    : Array.isArray(raw?.items) ? raw.items
    : Array.isArray(raw?.rows) ? raw.rows
    : Array.isArray(raw?.data) ? raw.data
    : null;
  return { rows, value: raw, loading, error: dataKey ? errors?.[dataKey] : null };
}

function Placeholder({ loading, error, children }) {
  if (error) return <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">{String(error)}</div>;
  if (loading) return <div className="h-16 animate-pulse rounded-md bg-muted/40" />;
  return children;
}

/* ── Layout ──────────────────────────────────────────────────────────────── */

// OpenUI Lang args are POSITIONAL and map to props in Zod key order — the
// order of keys in each schema below is part of the language contract the
// model is prompted with (mirrored in miniapp-mcp's grammar). Don't reorder.

const App = defineComponent({
  name: 'App',
  description: 'The app root: a vertical stack of sections. Every program is root = App([...]).',
  props: z.object({
    children: z.array(z.any()).describe('Sections, top to bottom'),
  }),
  component: ({ props: p, renderNode }) => (
    <div className="flex flex-col gap-3">{renderNode(p.children)}</div>
  ),
});

const Card = defineComponent({
  name: 'Card',
  description: 'Container with an optional title. Wrap sections of the app in Cards.',
  props: z.object({
    title: z.string().nullable().optional().describe('Section heading shown above the content; null for none'),
    children: z.array(z.any()).optional().describe('Card content'),
  }),
  component: ({ props: p, renderNode }) => (
    <section className="rounded-xl border border-border/60 bg-card p-4 shadow-xs">
      {p.title && <h3 className="mb-3 text-[13px] font-semibold tracking-tight text-foreground/85">{p.title}</h3>}
      <div className="flex flex-col gap-3">{renderNode(p.children)}</div>
    </section>
  ),
});

const Grid = defineComponent({
  name: 'Grid',
  description: 'Responsive grid wrapper. Use columns=2..4 for stat rows and side-by-side cards.',
  props: z.object({
    columns: z.number().int().min(1).max(4).default(2).describe('Column count on desktop; collapses on mobile'),
    children: z.array(z.any()).optional().describe('Grid cells'),
  }),
  component: ({ props: p, renderNode }) => renderGrid(p.columns ?? 2, renderNode(p.children)),
});

function renderGrid(columns, children) {
  return (
    <div className={cn(
      'grid gap-3',
      columns === 1 && 'grid-cols-1',
      columns === 2 && 'grid-cols-1 sm:grid-cols-2',
      columns === 3 && 'grid-cols-1 sm:grid-cols-3',
      columns === 4 && 'grid-cols-2 sm:grid-cols-4',
    )}>{children}</div>
  );
}

/* ── Content ─────────────────────────────────────────────────────────────── */

const Text = defineComponent({
  name: 'Text',
  description: 'Paragraph of text. Use muted for secondary notes.',
  props: z.object({
    content: z.string().describe('The text to display'),
    muted: z.boolean().optional().describe('Render in the secondary color'),
  }),
  component: ({ props: p }) => (
    <p className={cn('text-[13px] leading-relaxed', p.muted ? 'text-muted-foreground/75' : 'text-foreground/85')}>{p.content}</p>
  ),
});

const Badge = defineComponent({
  name: 'Badge',
  description: 'Small status pill. tone: neutral | success | warning | danger.',
  props: z.object({
    label: z.string().describe('Badge text'),
    tone: z.enum(['neutral', 'success', 'warning', 'danger']).default('neutral').describe('Color intent'),
  }),
  component: ({ props: p }) => renderBadge(p.label, p.tone ?? 'neutral'),
});

function renderBadge(label, tone) {
  return (
    <span className={cn(
      'inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
      tone === 'neutral' && 'border-border/60 bg-muted/40 text-foreground/70',
      tone === 'success' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
      tone === 'warning' && 'border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400',
      tone === 'danger'  && 'border-destructive/25 bg-destructive/10 text-destructive',
    )}>{label}</span>
  );
}

const Stat = defineComponent({
  name: 'Stat',
  description: 'Big-number KPI tile: label on top, value below, optional delta ("+12%") and hint.',
  props: z.object({
    label: z.string().describe('What the number measures'),
    value: z.string().describe('The formatted number, e.g. "1 284 zł" or "17"'),
    delta: z.string().optional().describe('Change vs previous period, e.g. "+12%" or "-3"'),
    hint: z.string().optional().describe('Small print under the value'),
  }),
  component: ({ props: p }) => renderStat(p),
});

function renderStat({ label, value, delta, hint }) {
    const negative = typeof delta === 'string' && delta.trim().startsWith('-');
    return (
      <div className="rounded-lg border border-border/55 bg-background px-3.5 py-3">
        <div className="text-[11px] font-medium uppercase tracking-[0.07em] text-muted-foreground/65">{label}</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[22px] font-semibold tracking-tight text-foreground">{value}</span>
          {delta && (
            <span className={cn('text-[12px] font-medium', negative ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400')}>{delta}</span>
          )}
        </div>
        {hint && <div className="mt-0.5 text-[11.5px] text-muted-foreground/60">{hint}</div>}
      </div>
    );
}

/* ── Data-bound ──────────────────────────────────────────────────────────── */

const columnSchema = z.object({
  key: z.string().describe('Row property to read'),
  label: z.string().optional().describe('Header text; defaults to the key'),
});

const DataTable = defineComponent({
  name: 'DataTable',
  description: 'Table over rows from a data source. Columns are picked by row property key.',
  props: z.object({
    dataKey: z.string().describe('Which data source to read rows from'),
    columns: z.array(columnSchema).optional().describe('Columns to show; defaults to the first row\'s keys'),
    empty: z.string().optional().describe('Message when there are no rows'),
  }),
  component: ({ props: p }) => <DataTableImpl {...p} />,
});

function DataTableImpl({ dataKey, columns, empty }) {
    const { rows, loading, error } = useRows(dataKey);
    const cols = columns?.length ? columns
      : rows?.length ? Object.keys(rows[0]).slice(0, 6).map(k => ({ key: k })) : [];
    return (
      <Placeholder loading={loading && !rows} error={error}>
        {!rows?.length ? (
          <div className="py-6 text-center text-[12.5px] text-muted-foreground/60">{empty || 'No data'}</div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border/55">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-border/55 bg-muted/30 text-left">
                  {cols.map(c => (
                    <th key={c.key} className="px-3 py-2 font-medium text-muted-foreground/75">{c.label || c.key}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/40 last:border-0 hover:bg-muted/20">
                    {cols.map(c => (
                      <td key={c.key} className="px-3 py-2 text-foreground/85">{formatCell(row?.[c.key])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Placeholder>
    );
}

const List = defineComponent({
  name: 'List',
  description: 'Vertical list of items from a data source: title, optional subtitle and status badge per row.',
  props: z.object({
    dataKey: z.string().describe('Which data source to read items from'),
    titleKey: z.string().describe('Row property used as the item title'),
    subtitleKey: z.string().optional().describe('Row property for the secondary line'),
    badgeKey: z.string().optional().describe('Row property rendered as a status pill'),
    empty: z.string().optional().describe('Message when the list is empty'),
  }),
  component: ({ props: p }) => <ListImpl {...p} />,
});

function ListImpl({ dataKey, titleKey, subtitleKey, badgeKey, empty }) {
    const { rows, loading, error } = useRows(dataKey);
    return (
      <Placeholder loading={loading && !rows} error={error}>
        {!rows?.length ? (
          <div className="py-6 text-center text-[12.5px] text-muted-foreground/60">{empty || 'Nothing here'}</div>
        ) : (
          <ul className="flex flex-col divide-y divide-border/40 rounded-lg border border-border/55">
            {rows.map((row, i) => (
              <li key={i} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-foreground/90">{formatCell(row?.[titleKey])}</div>
                  {subtitleKey && <div className="truncate text-[11.5px] text-muted-foreground/65">{formatCell(row?.[subtitleKey])}</div>}
                </div>
                {badgeKey && row?.[badgeKey] != null && (
                  <span className="shrink-0 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground/70">
                    {formatCell(row[badgeKey])}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Placeholder>
    );
}

const chartProps = z.object({
  dataKey: z.string().describe('Which data source to read points from'),
  x: z.string().describe('Row property for the x axis (e.g. "date")'),
  y: z.string().describe('Row property for the y value (e.g. "revenue")'),
  height: z.number().int().min(120).max(480).default(220).describe('Chart height in px'),
});

function ChartFrame({ dataKey, height, children }) {
  const { rows, loading, error } = useRows(dataKey);
  return (
    <Placeholder loading={loading && !rows} error={error}>
      {!rows?.length ? (
        <div className="py-6 text-center text-[12.5px] text-muted-foreground/60">No data</div>
      ) : (
        <div style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {children(rows)}
          </ResponsiveContainer>
        </div>
      )}
    </Placeholder>
  );
}

const chartAxisProps = {
  tick: { fontSize: 11, fill: 'var(--color-muted-foreground)' },
  tickLine: false,
  axisLine: { stroke: 'var(--color-border)' },
};

const MiniLineChart = defineComponent({
  name: 'LineChart',
  description: 'Line chart of y over x from a data source (trends over time).',
  props: chartProps,
  component: ({ props: p }) => (
    <ChartFrame dataKey={p.dataKey} height={p.height ?? 220}>
      {(rows) => (
        <RLineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey={p.x} {...chartAxisProps} />
          <YAxis {...chartAxisProps} width={44} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} />
          <Line type="monotone" dataKey={p.y} stroke="var(--color-ring)" strokeWidth={2} dot={false} />
        </RLineChart>
      )}
    </ChartFrame>
  ),
});

const MiniBarChart = defineComponent({
  name: 'BarChart',
  description: 'Bar chart of y per x from a data source (comparisons across categories).',
  props: chartProps,
  component: ({ props: p }) => (
    <ChartFrame dataKey={p.dataKey} height={p.height ?? 220}>
      {(rows) => (
        <RBarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey={p.x} {...chartAxisProps} />
          <YAxis {...chartAxisProps} width={44} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8 }} cursor={{ fill: 'var(--color-muted)', opacity: 0.35 }} />
          <Bar dataKey={p.y} fill="var(--color-ring)" radius={[4, 4, 0, 0]} maxBarSize={42} />
        </RBarChart>
      )}
    </ChartFrame>
  ),
});

function formatCell(v) {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export const miniappLibrary = createLibrary({
  components: [App, Card, Grid, Text, Badge, Stat, DataTable, List, MiniLineChart, MiniBarChart],
  root: 'App',
});

/** Component whitelist — save_as_tab validation mirrors this list. */
export const MINIAPP_COMPONENT_NAMES = [
  'App', 'Card', 'Grid', 'Text', 'Badge', 'Stat', 'DataTable', 'List', 'LineChart', 'BarChart',
];
