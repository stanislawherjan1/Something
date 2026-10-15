import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Plug, Unplug, Link, Unlink, Plus, Trash2, Users, Loader2, RefreshCw, ChevronRight, Settings as SettingsIcon, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useApi, invalidate } from '@/lib/useApi';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/Skeleton';
import EditorHeader from '../EditorHeader.jsx';
import useMe from '../useMe.js';
import { useBranding, BrandedImage } from '../identity';
import { FieldInput, StepBody, interpolate, Toggle, formatRelative, Tabs, logoUrl, RemoveDialog, Pick } from './IntegrationsDashboard.jsx';
import { TabBar } from './MemoryV4View.jsx';
import TileBanner from './TileBanner.jsx';
import { useIntegrationToasts, IntegrationToasts } from './integrationToasts.jsx';
import { Avatar } from './TeamDashboard.jsx';
import { isRemoteMcpOauth, isOpenServer, openOAuthPopup } from './integrationConnect.js';

/*
 * One integration's page (/integrations/<id>): what it is, the workspace's
 * connection and the person's own, each edited in place — a secret is shown
 * as its last characters and kept unless a new one is typed; a multi
 * connection (mail) lists its accounts, one can be added or removed without
 * touching the others — a Test, the how-to steps, and Disconnect. An admin
 * connects for the whole workspace or just for themselves; a member only for
 * themselves, and only what the catalog marks personal.
 */

const api = async (method, path, body) => {
  const r = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};



/** A stored value as the form shows it: a non-secret in clear, a secret as its last characters (kept unless retyped). */
/** A value still holding the mask's dots was never retyped: never sent as a secret. */
const untouched = (v) => typeof v !== 'string' || v === '' || v.includes('\u2022');
function masked(f) {
  if (!f?.set) return '';
  if (f.value != null) return f.value;
  return f.summary ? `${'•'.repeat(Math.max(4, Math.min(12, (f.summary.length || 8) - 4)))}${f.summary.last4 || ''}` : '••••';
}

/**
 * The fields of one connection (or one account of a multi one), edited in
 * place. Only what the person typed is sent; a secret left as shown is kept.
 */
function FieldsForm({ fields, stored, onSave, saving, saveLabel = 'Save changes', emptyLabel = 'Connect', quiet = false, columns = false }) {
  const [vals, setVals] = useState({});
  const [dirty, setDirty] = useState(false);
  // A new stored set (after a save, a reload) starts the form afresh.
  const [seen, setSeen] = useState(stored);
  if (seen !== stored) { setSeen(stored); setVals({}); setDirty(false); }
  const visible = fields.filter(f => !f.showIf || Object.entries(f.showIf).every(([k, v]) => (vals[k] ?? stored?.find(x => x.name === k)?.value ?? '') === v));
  const connected = stored?.some(f => f.set);
  const submit = async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of visible) if (!untouched(vals[f.name]) && vals[f.name] !== masked(stored?.find(x => x.name === f.name))) out[f.name] = vals[f.name];
    if (!connected) for (const f of visible) if (vals[f.name] == null && f.default) out[f.name] = f.default;
    // A failed save keeps what was typed (the toast says why).
    if ((await onSave(out)) === false) return;
    setVals({}); setDirty(false);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className={columns ? 'grid gap-4 sm:grid-cols-2' : 'flex flex-col gap-4'}>
      {visible.map((f) => {
        const s = stored?.find(x => x.name === f.name);
        const shown = vals[f.name] ?? masked(s);
        return (
          <div key={f.name} className="flex flex-col gap-1">
            <FieldInput field={f} value={shown} inputId={`f-${f.name}`} disabled={saving}
              onChange={(v) => { setVals((o) => ({ ...o, [f.name]: v })); setDirty(true); }} />
            {s?.set && s.summary && vals[f.name] == null && <span className="text-[11px] text-muted-foreground/55">Stored · {s.summary.length} characters. Type a new value to replace it.</span>}
          </div>
        );
      })}
      </div>
      <div className="flex items-center justify-end gap-2">
        {connected && dirty && (quiet
          ? <Button type="button" variant="ghost" size="sm" onClick={() => { setVals({}); setDirty(false); }}>Discard</Button>
          : <button type="button" onClick={() => { setVals({}); setDirty(false); }} className="rounded-[6px] px-3.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground/85">Discard</button>)}
        {quiet
          ? <Button type="submit" size="sm" variant="ghost" disabled={saving || (connected && !dirty)}>{saving ? <Loader2 className="animate-spin" /> : <Check />}{connected ? saveLabel : emptyLabel}</Button>
          : (
            // The modals' Connect button, as is.
            <button type="submit" disabled={saving || (connected && !dirty)} className={cn('inline-flex items-center gap-1.5 rounded px-6 py-2 text-[13px] font-medium transition-all', saving || (connected && !dirty) ? 'cursor-not-allowed bg-muted text-muted-foreground/60' : 'bg-foreground text-background hover:opacity-95 active:scale-[0.98]')}>
              {saving && <Loader2 className="size-3.5 animate-spin" />}{connected ? saveLabel : emptyLabel}
            </button>
          )}
      </div>
    </form>
  );
}


/**
 * One connection — the team's or a person's own — as rows in a card: the
 * connection itself (connected or not, Test, Disconnect), write access for
 * the team (a switch), then the settings — a key, or the accounts of a mail
 * connection — edited in place.
 */
/** A section as the Memory screen draws them: a small uppercase title, a note on the right, the content. */
function Section({ title, right, children }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex h-5 items-center justify-between gap-3">
        <h2 className="shrink-0 whitespace-nowrap text-[11px] font-semibold uppercase leading-none tracking-[0.1em] text-muted-foreground/70">{title}</h2>
        {right && <div className="flex items-center leading-none">{right}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * One connection — the team's or a person's own — as a few short sections:
 * the connection (status, Test, Disconnect), access for the team, the
 * settings (folded once connected), how to set it up (folded once connected).
 */
function ConnectionCard({ integration, reach, solo = false, detail, canManage, onChanged, toast, stepVars, botName }) {
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [write, setWrite] = useState(true);
  const connected = !!detail;
  // Under the banner: Settings and How to set it up as tabs (the Memory screen's bar).
  const [tab, setTab] = useState('settings');
  const writeNow = connected ? (detail.access || 'write') === 'write' : write;
  const q = reach === 'personal' ? '?reach=personal' : `?access=${writeNow ? 'write' : 'read'}`;
  const base = `/api/integrations/${encodeURIComponent(integration.id)}`;
  const oauth = isRemoteMcpOauth(integration);
  const open = isOpenServer(integration);
  const run = async (fn, { mode = null, done = null } = {}) => {
    setSaving(true);
    try {
      const r = await fn();
      await onChanged();
      if (mode) toast.pushActivationToast(integration, !!r?.restarting, mode);
      else if (r?.restarting) toast.pushRestartToast();
      else if (done) toast.pushToast(done, 'ok', { logo: integration.logo, label: integration.label });
      return true;
    } catch (e) { toast.pushToast(e.message, 'error', { logo: integration.logo, label: integration.label }); return false; }
    finally { setSaving(false); }
  };
  useEffect(() => {
    const onMsg = (e) => { if (e.origin === window.location.origin && e.data?.type === 'integration-oauth' && e.data.id === integration.id && (e.data.reach || 'workspace') === reach) { if (e.data.ok) toast.pushActivationToast(integration, !!e.data.restarting, 'install'); else toast.pushToast(`Couldn't connect ${integration.label}.`, 'error', { logo: integration.logo, label: integration.label }); } };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [integration, reach, toast]);
  const connect = () => {
    if (oauth) {
      const ok = openOAuthPopup(integration, () => onChanged(), { reach, access: writeNow ? 'write' : 'read' });
      if (!ok) window.location.assign(`${base}/oauth/start${q}`);
      return;
    }
    if (open) run(() => api('PUT', `${base}${q}`, { fields: {} }), { mode: 'install' });
  };
  const test = async () => { setSaving(true); try { const t = await api('POST', `${base}/test${q}`); toast.pushToast(t.ok ? `Test passed: ${t.detail}` : `Test failed: ${t.error}`, t.ok ? 'ok' : 'error', { logo: integration.logo, label: integration.label }); } catch (e) { toast.pushToast(e.message, 'error', { logo: integration.logo, label: integration.label }); } finally { setSaving(false); } };
  const perItem = (integration.fields || []).filter(f => !f.globalForMulti);
  const globalFields = (integration.fields || []).filter(f => f.globalForMulti);
  const items = detail?.items || [];
  // A team connection without write access: the hook blocks every change, so what holds for every account is moot.
  const readOnlyTeam = reach === 'workspace' && !solo && !writeNow;
  // The settings tab of a multi-account service is ONE form: every account's
  // edits, a new account and the shared settings collect in this draft and go
  // with one Connect (the first time) or one Save changes.
  const [draft, setDraft] = useState({ items: {}, add: null, globals: {} });
  const [seenDetail, setSeenDetail] = useState(detail);
  if (seenDetail !== detail) { setSeenDetail(detail); setDraft({ items: {}, add: null, globals: {} }); }
  const typed = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => !untouched(v)));
  const draftDirty = Object.values(draft.items).some(o => Object.keys(typed(o)).length) || (draft.add && Object.keys(typed(draft.add)).length) || Object.keys(typed(draft.globals)).length > 0;
  const withDefaults = (fields, vals) => ({ ...Object.fromEntries(fields.filter(f => f.default != null).map(f => [f.name, f.default])), ...vals });
  const saveAll = async () => { if (await run(async () => {
    let last = null;
    if (!connected) {
      const fields = { ...withDefaults(globalFields, typed(draft.globals)), ...withDefaults(perItem, typed(draft.add)) };
      last = await api('PUT', `${base}${q}`, { items: [{ fields }] });
    } else {
      for (const it of items) {
        const o = {}; for (const [k, v] of Object.entries(typed(draft.items[it.index]))) if (v !== masked(it.fields.find(x => x.name === k))) o[k] = v;
        if (Object.keys(o).length) last = await api('PATCH', `${base}/items/${it.index}${q}`, { fields: o });
      }
      if (draft.add && Object.keys(typed(draft.add)).length) last = await api('POST', `${base}/items${q}`, { fields: withDefaults(perItem, typed(draft.add)) });
      if (Object.keys(typed(draft.globals)).length) last = await api('PATCH', `${base}${q}`, { globalFields: typed(draft.globals) });
    }
    return last;
  }, connected ? { done: 'Changes saved' } : { mode: 'install' })) setDraft({ items: {}, add: null, globals: {} }); };   // a failed save keeps the draft
  const steps = integration.steps || [];
  const hasSettings = canManage && !oauth && !open;
  return (
    <div className="flex flex-col gap-7">
      {/* The connection as a banner: the service's halftone behind one plain
          line — the state, since when, the two actions — and, attached under
          it, a white strip with the team's access and its switch. */}
      <div className="overflow-hidden rounded-[6px] border border-border/60">
      <div className="relative flex min-h-20 flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <TileBanner image={logoUrl(integration.logo)} seed={`${integration.id}-${reach}`} soft className="!absolute inset-0 h-full" />
        <div className="relative flex min-w-0 flex-1 items-center">
          {/* The state in the tile's own chip: an icon, the word, the when and who. */}
          <span className="flex items-center gap-2.5 rounded-[6px] border border-border/60 bg-background/90 px-3 py-2 backdrop-blur">
            <span className={cn('inline-flex size-2 shrink-0 rounded-full', connected ? 'bg-emerald-500' : 'bg-muted-foreground/30')} />
            {connected ? <Link className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} /> : <Unlink className="size-4 shrink-0 text-muted-foreground/60" strokeWidth={1.75} />}
            <span className="text-[14px] font-medium text-foreground/90">{connected ? 'Connected' : 'Not connected'}</span>
            {connected && detail.activatedAt && <span className="text-[12px] text-muted-foreground/60">{formatRelative(new Date(detail.activatedAt))}</span>}
          </span>
        </div>
        {connected && canManage && (
          <div className="relative flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" className="bg-background/90 backdrop-blur" disabled={saving} onClick={test}><RefreshCw />Test</Button>
            <Button variant="outline" size="sm" className="bg-background/90 backdrop-blur" onClick={() => setConfirm(true)}><Unplug />Disconnect</Button>
            {confirm && (
              <RemoveDialog integration={integration} query={q} title={`Disconnect ${integration.label}?`} confirmLabel="Disconnect" busyLabel="Disconnecting…"
                body={reach === 'personal' ? 'Your own connection goes and its stored sign-in is erased. You can connect it again any time.' : 'The workspace\'s connection goes and its stored credentials are erased. You can connect it again any time.'}
                onClose={() => setConfirm(false)}
                onSuccess={async (d) => { setConfirm(false); await onChanged(); toast.pushActivationToast(integration, !!d?.restarting, 'remove'); }} />
            )}
          </div>
        )}
        {!connected && canManage && (oauth || open) && <Button size="sm" className="relative" disabled={saving} onClick={connect}><Plug />{oauth ? `Sign in to ${integration.label}` : 'Connect'}</Button>}
        {!canManage && <span className="relative text-[13px] text-muted-foreground/60">{reach === 'workspace' ? 'Admins connect this' : 'Not for your own account'}</span>}
      </div>
      {canManage && reach === 'workspace' && !solo && (
        <div className="flex items-center justify-between gap-4 border-t border-border/60 bg-card px-5 py-3">
          <span className="text-[13px] text-foreground/85">
            <span className="font-medium">{writeNow ? 'Read and write' : 'Read-only'}</span>
            <span className="ml-2 text-muted-foreground/70">{writeNow ? `${botName} can also create, send and change things there.` : `${botName} reads through it; nothing is created, sent or changed.`}</span>
          </span>
          <Toggle on={writeNow} busy={saving} label="Write access for the team" onClick={() => { const v = !writeNow; if (connected) run(() => api('PATCH', `${base}`, { access: v ? 'write' : 'read' }), { done: v ? 'Read and write for the team' : 'Read-only for the team' }); else setWrite(v); }} />
        </div>
      )}
      </div>

      {(hasSettings || (steps.length > 0 && canManage)) && (
        <div className="flex flex-col gap-5">
          <TabBar value={hasSettings && tab === 'settings' ? 'settings' : 'steps'} onChange={setTab}
            tabs={[...(hasSettings ? [['settings', <span key="s" className="flex items-center gap-1.5"><SettingsIcon className="size-3.5" strokeWidth={1.75} />Settings</span>]] : []), ...(steps.length > 0 && canManage ? [['steps', <span key="h" className="flex items-center gap-1.5"><BookOpen className="size-3.5" strokeWidth={1.75} />How to set it up</span>]] : [])]} />
          {hasSettings && tab === 'settings' && (!integration.multi ? (
            <FieldsForm fields={integration.fields || []} stored={detail?.fields || null} saving={saving}
              onSave={(f) => run(() => api(connected ? 'PATCH' : 'PUT', `${base}${q}`, { fields: f }), connected ? { done: 'Changes saved' } : { mode: 'install' })} />
          ) : (
            <div className="flex flex-col gap-2.5">
              {/* Each account under its own address; the fields in two columns. */}
              <Section title={`${integration.itemLabel || 'Account'}s`} right={items.length > 0 && <span className="text-[11.5px] text-muted-foreground/55">{items.length === 1 ? 'One account' : `${items.length} accounts`}</span>}>
                <div className="flex flex-col gap-2.5">
                  {items.map((it) => {
                    const { title, subtitle } = itemHeading(it, perItem, `${integration.itemLabel || 'Account'} ${it.index + 1}`);
                    return (
                      <ItemCard key={it.index} title={title} subtitle={subtitle} open={items.length === 1}
                        onRemove={() => run(() => api('DELETE', `${base}/items/${it.index}${q}`), { done: 'Account removed' })} saving={saving}>
                        <FieldsGrid fields={perItem} stored={it.fields} values={draft.items[it.index] || {}} disabled={saving}
                          onChange={(name, v) => setDraft(d => ({ ...d, items: { ...d.items, [it.index]: { ...(d.items[it.index] || {}), [name]: v } } }))} />
                      </ItemCard>
                    );
                  })}
                  {(draft.add || !connected) ? (
                    <ItemCard title={connected ? `New ${(integration.itemLabel || 'account').toLowerCase()}` : `${integration.itemLabel || 'Account'} 1`} onRemove={connected ? () => setDraft(d => ({ ...d, add: null })) : null} saving={saving} open>
                      <FieldsGrid fields={perItem} stored={null} values={draft.add || {}} disabled={saving}
                        onChange={(name, v) => setDraft(d => ({ ...d, add: { ...(d.add || {}), [name]: v } }))} />
                    </ItemCard>
                  ) : (
                    <button type="button" onClick={() => setDraft(d => ({ ...d, add: {} }))} className="inline-flex items-center justify-center gap-1.5 rounded border border-dashed border-border/70 bg-background px-3 py-2.5 text-[12.5px] font-medium text-muted-foreground/80 transition-colors hover:border-foreground/30 hover:text-foreground/90">
                      <Plus className="size-3.5" strokeWidth={2} />Add {(integration.itemLabel || 'account').toLowerCase()}
                    </button>
                  )}
                </div>
              </Section>
              {/* What holds for every account, as rows; part of the same form. */}
              {globalFields.length > 0 && (
                <SettingRows fields={globalFields} saving={saving}
                  disabled={readOnlyTeam} note={readOnlyTeam ? `Read-only for the team: ${botName} sends nothing and drafts nothing. Allow changes above to choose.` : null}
                  stored={globalFields.map(g => ({ name: g.name, value: draft.globals[g.name] ?? (connected ? detail?.items?.[0]?.fields?.find(f => f.name === g.name)?.value : undefined) ?? g.default ?? '' }))}
                  onChange={(name, value) => setDraft(d => ({ ...d, globals: { ...d.globals, [name]: value } }))} />
              )}
              {/* One decision, one button: Connect the first time, Save changes after. */}
              <div className="flex items-center justify-end gap-2 pt-1.5">
                {connected && draftDirty && <Button type="button" variant="ghost" size="sm" onClick={() => setDraft({ items: {}, add: null, globals: {} })}>Discard</Button>}
                <button type="button" onClick={saveAll} disabled={saving || (connected && !draftDirty)} className={cn('inline-flex items-center gap-1.5 rounded px-6 py-2 text-[13px] font-medium transition-all', saving || (connected && !draftDirty) ? 'cursor-not-allowed bg-muted text-muted-foreground/60' : 'bg-foreground text-background hover:opacity-95 active:scale-[0.98]')}>
                  {saving && <Loader2 className="size-3.5 animate-spin" />}{connected ? 'Save changes' : 'Connect'}
                </button>
              </div>
            </div>
          ))}
          {(!hasSettings || tab === 'steps') && steps.length > 0 && canManage && (
            <ol className="flex flex-col">
              {steps.map((st, i) => (
                <li key={i} className={cn('flex gap-3 py-3.5', i < steps.length - 1 && 'border-b border-border/50', i === 0 && 'pt-0')}>
                  <div className="w-5 shrink-0 pt-px text-[13px] tabular-nums text-muted-foreground/45">{i + 1}.</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-foreground/85">{interpolate(st.title, stepVars)}</div>
                    {st.body && <StepBody body={interpolate(st.body, stepVars)} />}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/** One account of a multi connection, the way the connect form lists them: a header row, the fields folded under it. */
/**
 * What an account's card says before it is opened: its address (the first
 * text field that names a user, address or login — never the provider, which
 * also has "EMAIL" in its name) and, muted, the provider and the label.
 */
function itemHeading(item, fields, fallback) {
  const val = (name) => item.fields.find(f => f.name === name && f.value)?.value;
  const addr = fields.find(f => f.type !== 'select' && f.type !== 'secret' && /USER|ADDRESS|LOGIN|ACCOUNT_NAME|^NAME/i.test(f.name) && val(f.name));
  const provider = fields.find(f => f.type === 'select' && /PROVIDER|KIND|TYPE/i.test(f.name));
  const providerLabel = provider && (provider.options || []).find(o => o.value === val(provider.name))?.label;
  const label = fields.find(f => /_ID$|LABEL/i.test(f.name) && val(f.name) && val(f.name) !== 'primary');
  const parts = [providerLabel, label && val(label.name)].filter(Boolean);
  return { title: addr ? val(addr.name) : fallback, subtitle: parts.join(' · ') || undefined };
}

/**
 * Settings that hold for every account, as rows in one card — the label and
 * what it means on the left, the choice on the right, saved as it changes.
 */
function SettingRows({ fields, stored, saving, onChange, disabled = false, note = null }) {
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/60 bg-card">
      {fields.map((f, i) => {
        const current = stored?.find(x => x.name === f.name)?.value ?? f.default ?? '';
        return (
          <div key={f.name} className={cn('flex items-center justify-between gap-6 px-5 py-3.5', i > 0 && 'border-t border-border/50')}>
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-foreground/90">{f.label}</div>
              {(note || f.helper) && <div className="mt-0.5 text-[12px] text-muted-foreground/70">{note || f.helper}</div>}
            </div>
            <div className="flex w-44 shrink-0">
              {f.type === 'select'
                ? <Pick id={`g-${f.name}`} value={current} options={(f.options || []).map(o => ({ value: o.value, label: o.label }))} onChange={(v) => onChange(f.name, v)} disabled={saving || disabled} />
                : <FieldInput field={{ ...f, label: undefined }} value={current} inputId={`g-${f.name}`} disabled={saving || disabled} onChange={(v) => onChange(f.name, v)} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The fields of one account in two columns, their values held by the page's draft. */
function FieldsGrid({ fields, stored, values, onChange, disabled }) {
  const visible = fields.filter(f => !f.showIf || Object.entries(f.showIf).every(([k, v]) => (values[k] ?? stored?.find(x => x.name === k)?.value ?? fields.find(x => x.name === k)?.default ?? '') === v));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {visible.map((f) => {
        const st = stored?.find(x => x.name === f.name);
        return (
          <div key={f.name} className="flex flex-col gap-1">
            <FieldInput field={f} value={values[f.name] ?? masked(st)} inputId={`f-${f.name}`} disabled={disabled} onChange={(v) => onChange(f.name, v)} />
            {st?.set && st.summary && values[f.name] == null && <span className="text-[11px] text-muted-foreground/55">Stored · {st.summary.length} characters. Type a new value to replace it.</span>}
          </div>
        );
      })}
    </div>
  );
}

function ItemCard({ title, subtitle, onRemove, saving, open: initiallyOpen = false, children }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="overflow-hidden rounded border border-border/50 bg-background">
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <button type="button" onClick={() => setOpen(!open)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronRight className={cn('size-3.5 shrink-0 text-muted-foreground/50 transition-transform', open && 'rotate-90')} strokeWidth={2} />
          <span className="truncate text-[13px] font-medium text-foreground/90">{title}</span>
          {subtitle && <span className="truncate text-[12px] text-muted-foreground/70">{subtitle}</span>}
        </button>
        {onRemove && <button type="button" disabled={saving} onClick={onRemove} className="rounded p-1 text-muted-foreground/65 transition-colors hover:bg-muted/30 hover:text-destructive" aria-label="Remove"><Trash2 className="size-3.5" strokeWidth={1.75} /></button>}
      </div>
      {open && <div className="border-t border-border/40 px-3.5 py-3.5">{children}</div>}
    </div>
  );
}

/**
 * Who on the team connected their own account: one banner like the
 * connection's — the count in its chip — and, attached under it, a white
 * list of the people, each with when they connected and Disconnect.
 */
function PeopleList({ integration, people, onChanged, toast }) {
  const [removing, setRemoving] = useState(null);
  return (
    <div className="overflow-hidden rounded-[6px] border border-border/60">
      <div className="relative flex min-h-20 items-center px-5 py-4">
        <TileBanner image={logoUrl(integration.logo)} mode="dark" seed={`${integration.id}-people`} soft className="!absolute inset-0 h-full" />
        <span className="relative flex items-center gap-2.5 rounded-[6px] border border-border/60 bg-background/90 px-3 py-2 backdrop-blur">
          <Users className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
          <span className="text-[14px] font-medium text-foreground/90">{people.length ? `${people.length} ${people.length === 1 ? 'person' : 'people'}` : 'Nobody yet'}</span>
          <span className="text-[12px] text-muted-foreground/60">{people.length ? 'with their own account' : `has connected their own ${integration.label}`}</span>
        </span>
      </div>
      {people.length > 0 && (
        <div className="divide-y divide-border/60 border-t border-border/60 bg-card">
          {people.map((p) => (
            <div key={p.slug} className="flex items-center gap-3 px-5 py-3">
              <Avatar name={p.name} avatarUrl={p.avatarUrl} className="size-7 text-[11px]" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/90">{p.name}</span>
              {p.activatedAt && <span className="text-[12px] text-muted-foreground/60">{formatRelative(new Date(p.activatedAt))}</span>}
              <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={() => setRemoving(p)}><Unplug />Disconnect</Button>
            </div>
          ))}
        </div>
      )}
      {removing && (
        <RemoveDialog integration={integration} query={`?reach=personal&slug=${encodeURIComponent(removing.slug)}`} title={`Disconnect ${removing.name}'s ${integration.label}?`} confirmLabel="Disconnect" busyLabel="Disconnecting…"
          body={`${removing.name}'s own connection goes and its stored sign-in is erased. They can connect it again any time.`}
          onClose={() => setRemoving(null)}
          onSuccess={async () => { setRemoving(null); await onChanged(); toast.pushToast(`${removing.name}'s own ${integration.label} disconnected`, 'neutral', { logo: integration.logo, label: integration.label }); }} />
      )}
    </div>
  );
}

/** The header's icon slot holds the way back: an arrow to the Integrations list. */
function BackToIntegrations(props) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/integrations')} aria-label="Back to Integrations" title="Integrations" className="-m-1 rounded-[5px] p-1 text-muted-foreground/70 transition-colors hover:bg-muted/50 hover:text-foreground">
      <ArrowLeft {...props} />
    </button>
  );
}

export default function IntegrationPage({ id, sidebarOpen }) {
  const { me } = useMe();
  const branding = useBranding();
  const toast = useIntegrationToasts(branding.botDisplayName);
  const { data, loading, error, reload } = useApi(`/api/integrations/${encodeURIComponent(id)}`);
  const onChanged = useCallback(async () => { invalidate('/api/integrations'); invalidate('/api/memory/v4/sources'); await reload(); }, [reload]);
  const stepVars = useMemo(() => ({ botDisplayName: branding.botDisplayName, botName: branding.botName, title: branding.title }), [branding]);
  const canWorkspace = !!data?.canConnectWorkspace;
  // Solo is a team of one: the connection is simply the owner's — one view, no People.
  const solo = me?.teamMode === false;
  const showPersonal = !!data?.personal && (!solo || !!data?.mine);
  // Tabs: Team (admins) and You (when the service can be yours). A member
  // has no Team tab — the workspace's connection is not theirs to look into.
  // Admins get a third tab, People: who on the team connected their own account.
  const people = useMemo(() => data?.activeFor || [], [data]);
  // Each tab carries its face: the organisation's mark, your avatar, the people's.
  const orgIcon = branding.iconUrl || branding.logoUrl;
  const tabs = useMemo(() => [
    ...(canWorkspace ? [{ id: 'team', label: (
      <span className="flex items-center gap-1.5">
        <span className="flex size-4 items-center justify-center overflow-hidden rounded-sm border border-border/60 bg-background">{orgIcon ? <BrandedImage src={orgIcon} alt="" className="size-full object-contain" /> : <Users className="size-2.5" strokeWidth={2} />}</span>
        Team
      </span>) }] : []),
    ...(showPersonal ? [{ id: 'me', label: (
      <span className="flex items-center gap-1.5"><Avatar name={me?.displayName || me?.email} email={me?.email} avatarUrl={me?.avatarUrl} className="size-4 text-[8px]" />You</span>) }] : []),
    ...(canWorkspace && showPersonal && !solo ? [{ id: 'people', label: (
      <span className="flex items-center gap-1.5">
        {people.length > 0 && <span className="flex items-center -space-x-1">{people.slice(0, 3).map(p => <Avatar key={p.slug} name={p.name} avatarUrl={p.avatarUrl} className="size-4 text-[8px] ring-1 ring-background" />)}</span>}
        People
      </span>) }] : []),
  ], [canWorkspace, showPersonal, solo, people, orgIcon, me]);
  // The tile that opened the page says which tab (?tab=team|me).
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get('tab'));
  const current = tabs.some(t => t.id === tab) ? tab : tabs[0]?.id;
  if (loading && !data) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader icon={BackToIntegrations} title="Integration" sidebarOpen={sidebarOpen} />
        <div className="flex flex-col gap-4 px-4 pt-2 sm:px-6"><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /></div>
      </div>
    );
  }
  if (!data || error) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EditorHeader icon={BackToIntegrations} title="Integration" sidebarOpen={sidebarOpen} />
        <div className="px-4 pt-2 text-[13px] text-muted-foreground sm:px-6">{error || 'Not found.'}</div>
      </div>
    );
  }
  const integration = data;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The tabs live in the top bar, on the right. */}
      <EditorHeader icon={BackToIntegrations} title={integration.label} sidebarOpen={sidebarOpen}
        meta={tabs.length > 1 ? <Tabs value={current} onChange={setTab} items={tabs} /> : null} />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-6 px-4 pb-12 pt-4 sm:px-6">
          {current === 'team' && (
            <ConnectionCard key={`team-${!!integration.workspace}`} integration={integration} reach="workspace" solo={solo} detail={integration.workspace} canManage={canWorkspace} onChanged={onChanged} toast={toast} stepVars={stepVars} botName={branding.botDisplayName} />
          )}
          {current === 'me' && (
            <ConnectionCard key={`me-${!!integration.mine}`} integration={integration} reach="personal" detail={integration.mine} canManage={!!integration.canConnectPersonal} onChanged={onChanged} toast={toast} stepVars={stepVars} botName={branding.botDisplayName} />
          )}
          {current === 'people' && (
            <PeopleList integration={integration} people={people} onChanged={onChanged} toast={toast} />
          )}
          {!tabs.length && (
            <div className="rounded-[6px] border border-dashed border-border/60 px-4 py-4 text-[12.5px] text-muted-foreground/70">Ask an admin to connect {integration.label} for the workspace.</div>
          )}

          <IntegrationToasts toasts={toast.toasts} botDisplayName={branding.botDisplayName} dismissToast={toast.dismissToast} />
        </div>
      </div>
    </div>
  );
}
