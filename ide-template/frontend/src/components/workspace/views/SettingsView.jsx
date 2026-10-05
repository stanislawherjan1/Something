import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Settings, Upload, Trash2, AlertTriangle, Check, ChevronDown, Search, Lock, LockOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { mutate, useApi } from '@/lib/useApi';
import EditorHeader from '../EditorHeader.jsx';
import PersonInitial from '../PersonInitial.jsx';
import { SkeletonLine, SkeletonCircle } from '../SkeletonLoader.jsx';

/**
 * SettingsView — the person's own settings, as a page (it used to be a modal
 * off the user menu). Every control saves on its own: no Save button to miss.
 *
 * Time zone and reply language are set here, and the assistant changes them
 * when the person asks it to (set_my_settings). The padlock next to each stops
 * the assistant from changing it at all. The morning planning runs at 06:00 in
 * this time zone. Admins also set the workspace default zone, used for anyone
 * who hasn't set their own.
 */

const LANGUAGES = [
  'English', 'Polish', 'German', 'French', 'Spanish', 'Italian', 'Portuguese', 'Dutch',
  'Swedish', 'Norwegian', 'Danish', 'Finnish', 'Czech', 'Slovak', 'Ukrainian', 'Romanian',
  'Hungarian', 'Greek', 'Turkish', 'Russian', 'Arabic', 'Hebrew', 'Hindi', 'Vietnamese',
  'Thai', 'Indonesian', 'Chinese', 'Japanese', 'Korean',
];
const MIRROR = 'Same as I write';

function allTimezones() {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Europe/London', 'Europe/Warsaw', 'America/New_York']; }
}
const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();

export default function SettingsView({ sidebarOpen }) {
  const meQ = useApi('/api/me');
  const me = meQ.data;
  const integ = useApi('/api/integrations');
  const tgActive = !!(integ.data?.integrations || []).find(i => i.id === 'telegram')?.active;
  const [error, setError] = useState(null);

  // One PATCH per change; the fresh envelope goes to every mounted view.
  const patch = useCallback(async (body) => {
    setError(null);
    try {
      const r = await fetch('/api/me', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Update failed (${r.status})`);
      await refresh();
    } catch (err) { setError(err.message); }
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorHeader icon={Settings} title="Settings" sidebarOpen={sidebarOpen} />
      <div className="flex-1 overflow-auto">
        <div className="flex max-w-[720px] flex-col gap-8 px-6 pb-12 pt-2">
          {error && (
            <div className="flex items-start gap-2 rounded-[6px] border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} />
              <span>{error}</span>
            </div>
          )}
          {!me ? <SkeletonGroups /> : (
            <>
              <Group title="Profile"><ProfileRows me={me} patch={patch} onError={setError} /></Group>
              <Group title="Assistant"><AssistantRows me={me} patch={patch} /></Group>
              {tgActive && <Group title="Telegram"><TelegramRows me={me} patch={patch} /></Group>}
              {me.role === 'admin' && <Group title="Workspace"><WorkspaceRows me={me} onError={setError} /></Group>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

async function refresh() {
  const freshMe = await fetch('/api/me').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (freshMe) mutate('/api/me', freshMe);
  const freshTeam = await fetch('/api/team').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (freshTeam) mutate('/api/team', freshTeam);
}

/* ─── Layout: groups of rows on hairlines, label left, control right ────── */

function Group({ title, children }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-[12px] font-medium text-muted-foreground/70">{title}</h2>
      <div className="flex flex-col divide-y divide-border/60 overflow-visible rounded-[6px] border border-border/60 bg-card">
        {children}
      </div>
    </section>
  );
}

function Row({ label, hint, children }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-foreground/90">{label}</div>
        {hint && <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground/70">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:w-[300px] sm:justify-end">{children}</div>
    </div>
  );
}

const inputCls = 'w-full rounded-[6px] border border-border/60 bg-background px-3 py-1.5 text-[13px] text-foreground/90 outline-none transition-colors focus:border-foreground/35';
const quietBtn = 'inline-flex items-center gap-1.5 rounded-[6px] border border-border/60 bg-card px-2.5 py-1 text-[12px] font-medium text-foreground/80 transition-colors hover:bg-muted/40';

// The padlock: locked = the assistant can't change this; only you can, here.
function LockToggle({ locked, onChange }) {
  const Icon = locked ? Lock : LockOpen;
  return (
    <button type="button" onClick={() => onChange(!locked)} aria-pressed={locked}
      title={locked ? "Locked — the assistant can't change this. Click to let it." : 'The assistant changes this when you ask. Click to lock.'}
      className={cn('flex size-[30px] shrink-0 items-center justify-center rounded-[6px] border transition-colors',
        locked ? 'border-foreground/25 bg-muted/50 text-foreground/85' : 'border-border/60 text-muted-foreground/55 hover:text-foreground/80')}>
      <Icon className="size-3.5" strokeWidth={2} />
    </button>
  );
}

/* ─── Rows ──────────────────────────────────────────────────────────────── */

function ProfileRows({ me, patch, onError }) {
  const [name, setName] = useState(me.displayName || '');
  const [busy, setBusy] = useState(false);
  const [broken, setBroken] = useState(false);   // picture didn't load → initial
  // Follow a change from elsewhere (another tab, the bot) without an effect.
  const [seen, setSeen] = useState({ name: me.displayName, avatar: me.avatarUrl });
  if (seen.name !== me.displayName || seen.avatar !== me.avatarUrl) {
    setSeen({ name: me.displayName, avatar: me.avatarUrl });
    setName(me.displayName || '');
    setBroken(false);
  }

  const saveName = () => {
    const n = name.trim();
    if (!n) { setName(me.displayName || ''); return; }
    if (n !== (me.displayName || '')) patch({ displayName: n });
  };

  const upload = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) { onError('Pick an image (PNG, JPEG, or webp).'); return; }
    setBusy(true);
    try {
      const blob = await resizeToImage(file, 512);
      const fd = new FormData();
      fd.append('avatar', blob, 'avatar');   // server detects the format by magic
      const r = await fetch('/api/me/avatar', { method: 'POST', body: fd });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Upload failed (${r.status})`);
      await refresh();
    } catch (err) { onError(err.message || "Couldn't process that image. Try a different one."); }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/me/avatar', { method: 'DELETE' });
      if (!r.ok && r.status !== 404) throw new Error(`Couldn't remove the picture (${r.status})`);
      await refresh();
    } catch (err) { onError(err.message); }
    setBusy(false);
  };

  const initial = (me.displayName || me.email || '?').trim().charAt(0).toUpperCase();
  return (
    <>
      <div className="flex items-center gap-3 px-4 py-3.5">
        {me.avatarUrl && !broken
          ? <div className="size-10 shrink-0 overflow-hidden rounded-full ring-1 ring-border/60"><img src={me.avatarUrl} alt="" onError={() => setBroken(true)} className="size-full object-cover" /></div>
          : <PersonInitial initial={initial} className="size-10 text-[15px]" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground/90">{me.displayName || me.email}</div>
          <div className="truncate text-[12px] text-muted-foreground/70">{me.email}</div>
        </div>
        {me.avatarUrl && (
          <button type="button" onClick={remove} disabled={busy} title="Remove picture"
            className="flex size-[30px] items-center justify-center rounded-[6px] text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
            <Trash2 className="size-3.5" strokeWidth={1.75} />
          </button>
        )}
        <label className={cn(quietBtn, 'cursor-pointer', busy && 'pointer-events-none opacity-50')}>
          <Upload className="size-3.5" strokeWidth={1.75} /> {me.avatarUrl ? 'Change picture' : 'Add picture'}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" disabled={busy}
            onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      <Row label="Display name" hint="How you show to the team.">
        <input type="text" value={name} maxLength={100} className={inputCls}
          onChange={(e) => setName(e.target.value)} onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      </Row>
    </>
  );
}

function AssistantRows({ me, patch }) {
  const zones = useMemo(() => allTimezones(), []);
  const tz = me.effectiveTimezone || me.timezone || me.defaultTimezone || 'UTC';
  const clock = useClock(tz);
  const offerBrowser = browserZone && browserZone !== tz && !me.timezoneLocked;
  const lang = me.preferredLanguage || '';

  return (
    <>
      <Row label="Reply language" hint="The language the assistant writes to you in.">
        <Combobox value={lang || MIRROR} options={[MIRROR, ...LANGUAGES]} allowCustom
          display={lang || MIRROR}
          onChange={(v) => patch({ preferredLanguage: v === MIRROR ? '' : v })} />
        <LockToggle locked={!!me.languageLocked} onChange={(v) => patch({ languageLocked: v })} />
      </Row>
      <Row
        label="Time zone"
        hint={(
          <>
            {`It's ${clock} there. Your morning planning runs at 06:00.`}
            {!me.timezone && ' Workspace default — set your own.'}
            {offerBrowser && (
              <>
                {' '}
                <button type="button" onClick={() => patch({ timezone: browserZone })}
                  className="font-medium text-foreground/75 underline decoration-border underline-offset-4 hover:text-foreground">
                  Use {browserZone.replace(/_/g, ' ')}
                </button>
              </>
            )}
          </>
        )}
      >
        <Combobox value={me.timezone || ''} display={formatZone(tz)} options={zones} format={formatZone}
          onChange={(v) => patch({ timezone: v })} />
        <LockToggle locked={!!me.timezoneLocked} onChange={(v) => patch({ timezoneLocked: v })} />
      </Row>
    </>
  );
}

function TelegramRows({ me, patch }) {
  const [chatId, setChatId] = useState(me.telegramChatId || '');
  const [seenId, setSeenId] = useState(me.telegramChatId);
  if (seenId !== me.telegramChatId) { setSeenId(me.telegramChatId); setChatId(me.telegramChatId || ''); }
  const surface = me.preferredSurface || 'both';
  const options = [{ value: 'both', label: 'Both' }, { value: 'telegram', label: 'Telegram' }, { value: 'web', label: 'Web' }];
  return (
    <>
      <Row label="Chat id" hint="Links your Telegram to this workspace.">
        <input type="text" value={chatId} maxLength={20} className={inputCls} placeholder="e.g. 123456789"
          onChange={(e) => setChatId(e.target.value)}
          onBlur={() => { const v = chatId.trim(); if (v !== (me.telegramChatId || '')) patch({ telegramChatId: v }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      </Row>
      <Row label="Reach me on" hint="Where the assistant messages you first.">
        <div className="grid w-full grid-cols-3 gap-1 rounded-[6px] bg-muted/40 p-1">
          {options.map((o) => (
            <button key={o.value} type="button" onClick={() => surface !== o.value && patch({ preferredSurface: o.value })}
              className={cn('rounded-[6px] px-2 py-1 text-[12px] font-medium transition-colors',
                surface === o.value ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.05)]' : 'text-muted-foreground/75 hover:text-foreground/90')}>
              {o.label}
            </button>
          ))}
        </div>
      </Row>
    </>
  );
}

function WorkspaceRows({ me, onError }) {
  const zones = useMemo(() => allTimezones(), []);
  const save = async (tz) => {
    onError(null);
    try {
      const r = await fetch('/api/team/default-timezone', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: tz }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Update failed (${r.status})`);
      await refresh();
    } catch (err) { onError(err.message); }
  };
  return (
    <Row label="Default time zone" hint="For everyone who hasn't set their own.">
      <Combobox value={me.defaultTimezone || 'UTC'} options={zones} format={formatZone} onChange={save} />
    </Row>
  );
}

function SkeletonGroups() {
  return (
    <>
      {[2, 2].map((n, g) => (
        <div key={g} className="flex flex-col gap-2">
          <SkeletonLine width="70px" height="12px" />
          <div className="flex flex-col divide-y divide-border/60 rounded-[6px] border border-border/60">
            {Array.from({ length: n }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5">
                {g === 0 && i === 0 && <SkeletonCircle size="40px" />}
                <div className="flex-1 space-y-2"><SkeletonLine width="30%" height="13px" /><SkeletonLine width="55%" height="11px" /></div>
                <SkeletonLine width="200px" height="30px" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/* ─── Combobox — a searchable list, the long zone list can't be a menu ──── */

function Combobox({ value, options, onChange, onClear, placeholder, display, allowCustom = false, format = (x) => x }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef(null);
  const input = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const off = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', off);
    setTimeout(() => input.current?.focus(), 0);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);

  const needle = q.trim().toLowerCase().replace(/\s+/g, '_');
  const shown = useMemo(() => {
    const hits = needle ? options.filter(o => o.toLowerCase().includes(needle) || format(o).toLowerCase().includes(q.trim().toLowerCase())) : options;
    return hits.slice(0, 200);
  }, [options, needle, q, format]);
  const custom = allowCustom && q.trim() && !options.some(o => o.toLowerCase() === q.trim().toLowerCase()) ? q.trim() : null;

  const choose = (v) => { setOpen(false); setQ(''); if (v !== value) onChange(v); };

  return (
    <div ref={box} className="relative min-w-0 flex-1">
      <button type="button" onClick={() => setOpen(!open)}
        className={cn(inputCls, 'flex items-center justify-between gap-2 text-left', !value && !display && 'text-muted-foreground/60')}>
        <span className="truncate">{display || (value ? format(value) : placeholder)}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground/60" strokeWidth={2} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-[300px] max-w-[85vw] overflow-hidden rounded-[6px] border border-border/60 bg-card shadow-[0_8px_24px_rgba(0,0,0,0.08)]">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <Search className="size-3.5 text-muted-foreground/60" strokeWidth={2} />
            <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search"
              onKeyDown={(e) => {
                if (e.key === 'Escape') setOpen(false);
                if (e.key === 'Enter') { e.preventDefault(); if (custom) choose(custom); else if (shown[0]) choose(shown[0]); }
              }}
              className="w-full bg-transparent text-[13px] text-foreground/90 outline-none placeholder:text-muted-foreground/55" />
          </div>
          <div className="scrollbar-hidden max-h-64 overflow-auto py-1">
            {onClear && (
              <Option onClick={() => { setOpen(false); setQ(''); onClear(); }} muted>{placeholder}</Option>
            )}
            {custom && <Option onClick={() => choose(custom)}>Use “{custom}”</Option>}
            {shown.map((o) => (
              <Option key={o} active={o === value} onClick={() => choose(o)}>{format(o)}</Option>
            ))}
            {!shown.length && !custom && <div className="px-3 py-2 text-[12.5px] text-muted-foreground/60">Nothing found</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Option({ active, muted, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-muted/40',
        muted ? 'text-muted-foreground/70' : 'text-foreground/85', active && 'font-medium text-foreground')}>
      <span className="truncate">{children}</span>
      {active && <Check className="size-3.5 shrink-0" strokeWidth={2.5} />}
    </button>
  );
}

/* ─── Helpers ───────────────────────────────────────────────────────────── */

function formatZone(tz) {
  if (!tz) return '';
  let off = '';
  try {
    off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find(p => p.type === 'timeZoneName')?.value || '';
  } catch { /* unknown zone */ }
  return `${tz.replace(/_/g, ' ')}${off ? ` (${off.replace('GMT', 'UTC')})` : ''}`;
}

function useClock(tz) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30 * 1000);
    return () => clearInterval(t);
  }, []);
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date()); }
  catch { return ''; }
}




// Resize an image to a size×size cover-cropped blob, kept small. Prefers webp;
// falls back to JPEG when the browser's canvas can't encode webp (some
// Safari/WebViews return PNG, which is huge for photos) — never ships PNG. Steps
// the JPEG quality down if a high-detail photo is still over the cap, so the
// upload always stays well under the server limit.
function resizeToImage(file, size) {
  const CAP = 480 * 1024;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale, h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const toBlob = (type, q) => new Promise((res) => canvas.toBlob(res, type, q));
        (async () => {
          let blob = await toBlob('image/webp', 0.85);
          if (!blob || blob.type !== 'image/webp' || blob.size > CAP) blob = await toBlob('image/jpeg', 0.85);
          if (blob && blob.size > CAP) blob = await toBlob('image/jpeg', 0.6);
          if (blob) resolve(blob); else reject(new Error('encode failed'));
        })();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
