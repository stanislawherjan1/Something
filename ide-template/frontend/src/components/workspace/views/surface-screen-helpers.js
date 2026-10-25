// Constants and helpers shared by the surface screens (Telegram, Slack) —
// kept apart from the components so fast refresh keeps working.
export const TEAM_URL = '/api/team';
export const labelCls = 'text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground/75';

export async function call(url, init) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...init });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json().catch(() => ({}));
}

export function formatWhen(iso) {
  if (!iso) return 'a while ago';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'a while ago' : d.toLocaleString();
}

export const barBtn = 'inline-flex items-center gap-1.5 rounded-[6px] border border-border/60 px-3 py-1.5 text-[12.5px] font-medium text-muted-foreground/80 transition-colors hover:border-foreground/20 hover:text-foreground/90';
export const barDanger = 'inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12.5px] font-medium text-destructive transition-colors hover:bg-destructive/10';
export const primaryBtn = 'inline-flex items-center gap-1.5 rounded-[6px] bg-foreground px-3 py-1 text-[12px] font-medium text-background hover:bg-foreground/85 disabled:opacity-50';
export const quietBtn = 'rounded-[6px] px-2.5 py-1 text-[12px] font-medium text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground/90 disabled:opacity-50';
export const outlineBtn = 'inline-flex items-center gap-1.5 rounded-[6px] border border-border/60 bg-background px-2.5 py-1 text-[12px] font-medium text-foreground/80 transition-colors hover:border-foreground/25 hover:bg-muted/40 disabled:opacity-50';
export const gcell = 'flex h-full items-center border-b border-border/60 py-2.5 pr-4';
