// Onboarding for review in the mock (?onboarding=a, dev only).
// Fixture data inline: one fictional shop, what research of its website found,
// and the starter plan built from the real catalogs' ids.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Globe, Check, Pencil, ImagePlus, X, Notebook, Calendar, ChevronDown,
  Sun, Reply, AlertCircle, Loader2, MessageSquare,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { PRESET_AVATARS } from '../workspace/views/AvatarTile.jsx';
import { Logo, Toggle, logoUrl } from '../workspace/views/IntegrationsDashboard.jsx';
import { Card, StepHeader, NavRow, inputCls, labelCls, Step2Avatar, TokenHelp } from '../SetupWizard.jsx';
import { PlanSkeleton } from './parts.jsx';

const BOT = { name: 'Aria', avatar: PRESET_AVATARS[0].url };
const ME = { name: 'Mara', role: 'Founder', goal: 'Fewer hours on order emails' };
// What the opt-in look-up found about the person (public pages only).
const ME_FOUND = [
  { k: 'Background', v: 'Ran an outdoor shop in Berlin before starting Fieldcraft in 2021', src: 'linkedin.com/in/mara-lindqvist' },
  { k: 'Also', v: 'Speaks about small-shop e-commerce at regional meetups', src: 'meetup.com' },
];

const COMPANY = {
  name: 'Fieldcraft',
  site: 'fieldcraft.co',
  facts: [
    { k: 'What you sell', v: 'Outdoor and camping gear: tents, packs, cookware', src: 'fieldcraft.co' },
    { k: 'Customers', v: 'Hikers and small outdoor clubs, mostly in Germany and Poland', src: 'fieldcraft.co/about' },
    { k: 'Wholesale', v: 'Clubs and shops book a call for bulk orders', src: 'fieldcraft.co/wholesale' },
    { k: 'Team', v: 'Six people, the founders are Mara and Jonas', src: 'fieldcraft.co/about' },
  ],
  tools: [
    { id: 'shopify', label: 'Shopify', logo: '/integrations/shopify.svg', seen: 'The store runs on it' },
    { id: 'mailchimp', label: 'Mailchimp', logo: '/integrations/mailchimp.svg', seen: 'Newsletter form' },
    { id: 'meta-ads', label: 'Meta Ads', logo: '/integrations/meta.svg', seen: 'Meta pixel on every page' },
    { id: 'calendly', label: 'Calendly', logo: '/integrations/calendly.svg', seen: 'Wholesale calls' },
  ],
};

const PLAN = {
  // One click only: official remote MCP servers with OAuth, plus Google through the
  // deployment's own sign-in client.
  integrations: [
    { id: 'mailchimp', label: 'Mailchimp', logo: '/integrations/mailchimp.svg', why: 'The newsletter form on your site: lists, campaigns and how each send did.' },
    { id: 'calendly', label: 'Calendly', logo: '/integrations/calendly.svg', why: 'Your wholesale calls are booked there, so I know who is coming.' },
    { id: 'google-workspace', label: 'Google', logo: '/integrations/gworkspace.svg', why: 'Your mail and calendar, so I can plan your day.' },
  ],
  routines: [
    { id: 'where-is-my-order', icon: Reply, title: '"Where is my order" mail', summary: 'Answers order-status questions with a ready draft.', why: 'You want fewer hours on order emails.', needs: 'Shopify' },
    { id: 'stuck-orders', icon: AlertCircle, title: 'Stuck orders', summary: 'Orders unfulfilled after 48 hours or still unpaid.', why: 'Orders are most of your day.', needs: 'Shopify' },
    { id: 'morning-brief', icon: Sun, title: 'Morning brief', summary: "The day's top three and what's due, in one short message.", why: 'Your first one arrives tomorrow at 08:00.' },
  ],
};

// ─── Shared pieces ────────────────────────────────────────────────────────────

function Source({ src }) {
  const Icon = src === 'you said' ? MessageSquare : Globe;
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground/70">
      <Icon className="size-3" strokeWidth={1.75} />{src}
    </span>
  );
}

// A line the research drafted: unconfirmed until the person says it's right.
function FactRow({ fact, confirmable = true }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="group flex items-start gap-3 border-b border-border/50 py-2 last:border-b-0">
      <div className="w-[104px] shrink-0 pt-px text-[12px] text-muted-foreground/75">{fact.k}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] leading-snug text-foreground/90">{fact.v}</p>
        <div className="mt-0.5 flex items-center gap-3">
          <Source src={fact.src} />
          {confirmable && !ok && <span className="text-[11.5px] text-amber-700 dark:text-amber-400">Right?</span>}
          {ok && <span className="inline-flex items-center gap-1 text-[11.5px] text-emerald-700 dark:text-emerald-400"><Check className="size-3" strokeWidth={2.25} />Confirmed</span>}
        </div>
      </div>
      {confirmable && !ok && (
        <div className="flex shrink-0 gap-1 opacity-70 group-hover:opacity-100">
          <IconBtn label="That's right" onClick={() => setOk(true)}><Check className="size-3.5" strokeWidth={2} /></IconBtn>
          <IconBtn label="Edit"><Pencil className="size-3.5" strokeWidth={1.75} /></IconBtn>
        </div>
      )}
    </div>
  );
}

// Where a line came from: the source's favicon, its address on hover. The real
// one is fetched with the page by the server and served from the store (no
// third-party favicon service); the mock draws the site's initial.
function SourceIcon({ url }) {
  const host = url.replace(/^https?:\/\//, '').split('/')[0];
  const hue = [...host].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span className="group/src relative -top-px ml-1.5 inline-flex items-center align-middle">
      <span className="flex size-3 items-center justify-center rounded-[3px] text-[7.5px] font-semibold uppercase leading-none text-white"
        style={{ background: `hsl(${hue} 30% 48%)` }}>{host[0]}</span>
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 hidden w-max max-w-[340px] -translate-x-1/2 rounded bg-popover px-2.5 py-1.5 text-[12px] font-normal leading-snug text-popover-foreground/90 shadow-md ring-1 ring-foreground/10 group-hover/src:block">{url}</span>
    </span>
  );
}

// Light tabs: text with a line under the one that's open.
function TextTabs({ value, onChange, items }) {
  return (
    <div role="tablist" className="flex gap-5">
      {items.map((it) => (
        <button key={it.id} type="button" role="tab" aria-selected={it.id === value} onClick={() => onChange(it.id)}
          className={cn('-mb-px border-b-[1.5px] pb-2 text-[13px] font-medium transition-colors',
            it.id === value ? 'border-foreground/80 text-foreground/90' : 'border-transparent text-muted-foreground/70 hover:text-foreground/85')}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

// A found line, as a plain sentence. Hover shows edit and remove; click edits it.
function FoundLine({ text, src }) {
  const [v, setV] = useState(text);
  const [editing, setEditing] = useState(false);
  const [gone, setGone] = useState(false);
  const ref = useRef(null);
  // The same text becomes editable where it stands: nothing moves when editing starts.
  useEffect(() => {
    if (!editing || !ref.current) return;
    const el = ref.current; el.focus();
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(false);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }, [editing]);
  const save = () => { setV(ref.current?.textContent.trim() || v); setEditing(false); };
  const cancel = () => { if (ref.current) ref.current.textContent = v; setEditing(false); };
  if (gone) return null;
  return (
    <li className="group relative flex items-start py-2.5 pr-16">
      <p className="flex-1 text-[13.5px] leading-relaxed text-foreground/85">
        <span ref={ref} contentEditable={editing} suppressContentEditableWarning spellCheck={false}
          onClick={() => !editing && setEditing(true)} onBlur={() => editing && save()}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); cancel(); } }}
          className="cursor-text outline-none">{v}</span>
        {src && !editing && <SourceIcon url={src} />}
      </p>
      {/* mousedown keeps the focus in the text, so the click decides, not the blur */}
      <span onMouseDown={(e) => editing && e.preventDefault()}
        className={cn('absolute right-0 top-1/2 flex -translate-y-1/2 gap-0.5 transition-opacity', editing ? 'opacity-100' : 'opacity-60 group-hover:opacity-100')}>
        {editing ? (
          <>
            <IconBtn label="Save" onClick={save}><Check className="size-3.5" strokeWidth={2} /></IconBtn>
            <IconBtn label="Cancel" onClick={cancel}><X className="size-3.5" strokeWidth={1.75} /></IconBtn>
          </>
        ) : (
          <>
            <IconBtn label="Edit" onClick={() => setEditing(true)}><Pencil className="size-3.5" strokeWidth={1.75} /></IconBtn>
            <IconBtn label="Remove" onClick={() => setGone(true)}><X className="size-3.5" strokeWidth={1.75} /></IconBtn>
          </>
        )}
      </span>
    </li>
  );
}

function FoundSection({ from, children }) {
  return (
    <section>
      {children}
    </section>
  );
}

function IconBtn({ children, label, onClick }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick}
      className="flex size-7 items-center justify-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors">
      {children}
    </button>
  );
}

function ToolFound({ tool }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[6px] border border-border/60 bg-card px-2.5 py-2">
      <Logo src={tool.logo} alt={tool.label} size="size-7" imgSize="size-4" />
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-foreground/90">{tool.label}</div>
        <div className="truncate text-[11.5px] text-muted-foreground/70">{tool.seen}</div>
      </div>
    </div>
  );
}

function SmallBtn({ children, primary, onClick }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] font-medium transition-colors',
        primary ? 'bg-foreground text-background hover:bg-foreground/90' : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground')}>
      {children}
    </button>
  );
}

// The alternatives, drawn above everything (no card or bar clips it); opens
// upwards when there is no room below.
function AltMenu({ anchor, items, onPick }) {
  const r = anchor?.getBoundingClientRect();
  if (!r) return null;
  const height = Math.min(items.length * 34 + 8, 260);
  const below = window.innerHeight - r.bottom - 12;
  const up = below < height && r.top > below;
  return (
    <div onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', left: r.left, ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }), maxHeight: 260 }}
      className="z-[60] w-[200px] overflow-y-auto rounded-[6px] border border-border/60 bg-card p-1 shadow-[0_12px_32px_-14px_rgba(0,0,0,0.3)]">
      {items.map((o) => (
        <button key={o.id} type="button" onClick={() => onPick(o)}
          className="flex w-full items-center gap-2.5 rounded-[4px] px-2 py-1.5 text-left text-[12.5px] text-foreground/85 hover:bg-foreground/[0.05]">
          <img src={logoUrl(o.logo)} alt="" className="size-4 object-contain" />{o.label}
        </button>
      ))}
    </div>
  );
}

// What "Use another …" calls each kind of tool.
const KIND_NAME = { notetaker: 'notetaker', booking: 'calendar', tasks: 'task app', docs: 'workspace', issues: 'tracker', payments: 'payments tool', newsletter: 'newsletter tool', site: 'site builder' };

function PlanIntegration({ item: first, compact }) {
  const [state, setState] = useState('idle'); // idle → connecting (the OAuth popup is open) → done
  const [item, setItem] = useState(first);
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const others = [first, ...(first.alternatives || [])].filter((x) => x.id !== item.id);
  const connect = () => { setState('connecting'); setTimeout(() => setState('done'), 1400); };
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);   // fixed to the screen: closes when the plan scrolls
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [open]);
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Logo src={item.logo} alt={item.label} size={compact ? 'size-8' : 'size-9'} imgSize="size-5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium leading-[18px] text-foreground/90">{item.label}</span>
          {first.alternatives?.length > 0 && state === 'idle' && (
            <span>
              <button ref={btn} type="button" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
                className="inline-flex items-baseline gap-0.5 text-[11.5px] leading-[18px] text-muted-foreground/70 hover:text-foreground/85">
                Use another {KIND_NAME[first.kind] || 'tool'} <ChevronDown className="size-3 translate-y-[2px] self-center" strokeWidth={2} />
              </button>
              {open && createPortal(<AltMenu anchor={btn.current} items={others} onPick={(o) => { setItem({ ...o, why: first.why }); setOpen(false); }} />, document.body)}
            </span>
          )}
        </div>
        <div className="text-[12px] leading-snug text-muted-foreground/80">{item.why || first.why}</div>
      </div>
      {state === 'done'
        ? <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-400"><Check className="size-3.5" strokeWidth={2.25} />Connected</span>
        : state === 'connecting'
          ? <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Connecting…</span>
          : <SmallBtn primary onClick={connect}>Connect</SmallBtn>}
    </div>
  );
}

function PlanRoutine({ item, compact }) {
  const [added, setAdded] = useState(false);
  const Icon = item.icon;
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className={cn('flex shrink-0 items-center justify-center rounded-[6px] bg-foreground/[0.05] text-foreground/70', compact ? 'size-8' : 'size-9')}>
        <Icon className="size-4" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground/90">{item.title}</div>
        <div className="text-[12px] leading-snug text-muted-foreground/80">
          {item.why}{item.needs && <span className="text-muted-foreground/60"> · needs {item.needs}</span>}
        </div>
      </div>
      {added
        ? <span className="inline-flex items-center gap-1 text-[12px] text-emerald-700 dark:text-emerald-400"><Check className="size-3.5" strokeWidth={2.25} />Added</span>
        : <SmallBtn onClick={() => setAdded(true)}>Add</SmallBtn>}
    </div>
  );
}

function SectionTitle({ children, right }) {
  return (
    <div className="mb-1 mt-5 flex items-center justify-between first:mt-0">
      <span className={labelCls}>{children}</span>
      {right}
    </div>
  );
}

function StarterPlan({ compact = false }) {
  return (
    <div>
      <SectionTitle>Connect first</SectionTitle>
      <div className="divide-y divide-border/50">{PLAN.integrations.map((i) => <PlanIntegration key={i.id} item={i} compact={compact} />)}</div>
      <SectionTitle>Routines for you</SectionTitle>
      <div className="divide-y divide-border/50">{PLAN.routines.map((r) => <PlanRoutine key={r.id} item={r} compact={compact} />)}</div>
    </div>
  );
}

// Between the token and the results: one calm screen, the stages ticking off.
function Building({ stages, onDone }) {
  const [done, setDone] = useState(0);
  useEffect(() => {
    if (done >= stages.length) { const t = setTimeout(onDone, 500); return () => clearTimeout(t); }
    const t = setTimeout(() => setDone((n) => n + 1), 1100);
    return () => clearTimeout(t);
  }, [done, stages.length, onDone]);
  return (
    <>
      <div className="flex flex-1 flex-col justify-center px-12">
        <h1 className="text-[20px] font-semibold tracking-[-0.015em] text-foreground/90">Setting things up</h1>
        <p className="mt-1 text-[13px] text-muted-foreground/80">This takes a moment.</p>
        <ul className="mt-8 space-y-3.5">
          {stages.map((label, i) => (
            <li key={label} className={cn('flex items-center gap-3 text-[13.5px] transition-colors', i <= done ? 'text-foreground/85' : 'text-muted-foreground/45')}>
              <span className="flex size-4 items-center justify-center">
                {i < done ? <Check className="size-4 text-foreground/80" strokeWidth={2.25} />
                  : i === done ? <Loader2 className="size-4 animate-spin text-foreground/60" strokeWidth={2} />
                  : <span className="size-1.5 rounded-full bg-foreground/20" />}
              </span>
              {label}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

// ─── Option A: the wizard that looks you up ──────────────────────────────────


function OptionA() {
  const [step, setStep] = useState(1);
  const [botName, setBotName] = useState('');
  const [avatarIdx, setAvatarIdx] = useState(0);
  const [customAvatar, setCustomAvatar] = useState(null);
  const [company, setCompany] = useState('');
  const [logo, setLogo] = useState(null);
  const logoRef = useRef(null);
  const [about, setAbout] = useState('');
  const [site, setSite] = useState('');
  const [fullName, setFullName] = useState('');
  const [foundTab, setFoundTab] = useState('company');
  const [role, setRole] = useState('');
  const [help, setHelp] = useState('');
  const [lookup, setLookup] = useState(false);
  const total = 6;
  const who = botName.trim() || 'your coworker';
  // The plan is picked by a model: the skeleton shows while it works (5 s in the mock).
  const [picking, setPicking] = useState(true);
  useEffect(() => { if (step !== 6) return; setPicking(true); const t = setTimeout(() => setPicking(false), 5000); return () => clearTimeout(t); }, [step]);
  const next = () => setStep((s) => Math.min(total + 1, s + 1));
  const back = () => setStep((s) => (s === 5 || (s === 6 && !site.trim() && !lookup) ? 4 : Math.max(1, s - 1)));

  return (
    <div className="mx-auto w-full max-w-[880px]">
      <style>{'@keyframes onbIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'}</style>
      {step === 7 ? null : (
      <Card banner={step === 6 ? 'rings' : 'wave'}>
      <div key={String(step)} className="flex min-h-0 flex-1 flex-col" style={{ animation: 'onbIn .38s cubic-bezier(.2,.7,.2,1)' }}>
      {step === 1 && (
        <Step2Avatar
          bare step={1} total={total} title="Meet your coworker" subtitle="A name and a face. Everything else it learns from you."
          botName={botName} setBotName={setBotName}
          avatarIdx={avatarIdx} onPickPreset={(i) => { setAvatarIdx(i); setCustomAvatar(null); }}
          customAvatar={customAvatar} onPickFile={(f) => f && setCustomAvatar({ file: f, url: URL.createObjectURL(f) })}
          onNext={next} canNext={!!botName.trim()} />
      )}

      {step === 2 && (
        <>
          <StepHeader step={2} total={total} title="Your company" subtitle={`So ${who} knows what you do from the first day.`} />
          <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">
            <div className="flex gap-3">
              <div className="shrink-0">
                <label className={labelCls}>Logo</label>
                <input ref={logoRef} type="file" accept="image/png,image/jpeg" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) setLogo(URL.createObjectURL(f)); e.target.value = ''; }} />
                <button type="button" onClick={() => logoRef.current?.click()} title={logo ? 'Change the logo' : 'Upload a logo (optional)'}
                  className={cn('mt-2 flex h-[38px] items-center gap-2 rounded-[6px] pl-1.5 pr-3 text-[12.5px] font-medium transition-colors',
                    logo ? 'border border-border/60 text-foreground/80 hover:border-foreground/30' : 'border border-dashed border-border/80 text-muted-foreground/70 hover:border-foreground/30 hover:text-foreground/80')}>
                  <span className="flex size-7 items-center justify-center overflow-hidden rounded-[4px] bg-[#f1efea] dark:bg-[#2a2826]">
                    {logo ? <img src={logo} alt="" className="size-full bg-card object-contain p-0.5" /> : <ImagePlus className="size-3.5" strokeWidth={1.75} />}
                  </span>
                  {logo ? 'Change' : 'Upload'}
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <label className={labelCls}>Company name</label>
                <input className={cn(inputCls, 'mt-2')} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme · Globex · Initech" />
              </div>
            </div>
            <label className={cn(labelCls, 'mt-6 block')}>What does it do, in one sentence?</label>
            <input className={cn(inputCls, 'mt-2')} value={about} onChange={(e) => setAbout(e.target.value)}
              placeholder="We sell outdoor and camping gear online, mostly to hikers and clubs" />
            <label className={cn(labelCls, 'mt-6 block')}>Website <span className="normal-case tracking-normal text-muted-foreground/55">(optional)</span></label>
            <div className="relative mt-2">
              <Globe className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" strokeWidth={1.75} />
              <input className={cn(inputCls, 'pl-8')} value={site} onChange={(e) => setSite(e.target.value)} placeholder="yourcompany.com" />
            </div>
          </div>
          <div className="shrink-0 border-t border-border/60 px-8 py-4">
            <NavRow onBack={back} onNext={next} canNext={!!company.trim() && !!about.trim()}
              step={2} total={total} />
          </div>
        </>
      )}

      {step === 3 && (
        <>
          <StepHeader step={3} total={total} title="About you" subtitle={`So ${who} knows who it works with.`} />
          <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">
            <div className="flex gap-3">
              <div className="min-w-0 flex-1">
                <label className={labelCls}>Full name</label>
                <input className={cn(inputCls, 'mt-2')} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Mara Lindqvist" />
              </div>
              <div className="min-w-0 flex-1">
                <label className={labelCls}>Your role</label>
                <input className={cn(inputCls, 'mt-2')} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Founder · Head of sales" />
              </div>
            </div>
            <label className={cn(labelCls, 'mt-6 block')}>What do you need help with?</label>
            <textarea rows={3} className={cn(inputCls, 'mt-2 resize-none leading-snug')} value={help} onChange={(e) => setHelp(e.target.value)}
              placeholder="Answering customer emails about orders, keeping an eye on stock, preparing the weekly numbers" />
            <div className="mt-6 flex items-start justify-between gap-4 rounded-[6px] border border-border/60 px-3.5 py-3">
              <div>
                <div className="text-[13px] font-medium text-foreground/90">Look me up on the web</div>
                <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground/75">Public pages only. You'll see what it found before anything is kept.</div>
              </div>
              <Toggle on={lookup} small label="Look me up on the web" onClick={() => setLookup((v) => !v)} />
            </div>
          </div>
          <div className="shrink-0 border-t border-border/60 px-8 py-4">
            <NavRow onBack={back} onNext={next} canNext={!!fullName.trim() && !!role.trim() && !!help.trim()} step={3} total={total} />
          </div>
        </>
      )}

      {step === 4 && (
        <>
          <StepHeader step={4} total={total} title="Connect Claude" subtitle="Your coworker runs on your own Claude plan. The token is stored encrypted on your server and never leaves it." />
          <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">
            <label className={labelCls}>Claude token</label>
            <input type="password" className={cn(inputCls, 'mt-2 font-mono')} defaultValue="sk-ant-oat01-example-token" placeholder="sk-ant-oat01-…" />
            <div className="mt-3"><TokenHelp /></div>
          </div>
          <div className="shrink-0 border-t border-border/60 px-8 py-4"><NavRow onBack={back} onNext={() => setStep('building')} step={4} total={total} /></div>
        </>
      )}

      {step === 'building' && (
        <Building
          stages={[
            'Connecting to Claude',
            ...(site.trim() ? [`Reading ${site.trim()}`] : []),
            ...(lookup ? [`Looking up ${fullName.trim() || 'you'}`] : []),
            `Getting ${who} ready`,
          ]}
          onDone={() => setStep(site.trim() || lookup ? 5 : 6)} />
      )}

      {step === 5 && (
        <>
          <StepHeader step={5} total={total} title="What we found" subtitle="Fix or remove anything that's off."
            tabs={site.trim() && lookup ? <TextTabs value={foundTab} onChange={setFoundTab}
              items={[{ id: 'company', label: company.trim() || 'Company' }, { id: 'you', label: 'You' }]} /> : null} />
          <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">
            {(

              <>
                {site.trim() && (!lookup || foundTab === 'company') && (
                  <FoundSection from={site.trim()}>
                    <ul className="divide-y divide-border/50">{COMPANY.facts.map((f) => <FoundLine key={f.k} text={f.v} src={f.src} />)}</ul>
                    <div className="mt-6">
                      <div className="mb-2 text-[12px] text-muted-foreground/70">Tools we spotted on {site.trim()}</div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {COMPANY.tools.map((t) => (
                          <span key={t.id} title={t.seen}
                            className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card py-[3px] pl-[3px] pr-2.5 text-[12px] font-medium text-foreground/80">
                            <span className="flex size-[18px] items-center justify-center rounded-full bg-white ring-1 ring-black/[0.05]">
                              <img src={logoUrl(t.logo)} alt="" className="size-3 object-contain" />
                            </span>
                            {t.label}
                          </span>
                        ))}
                      </div>
                    </div>
                  </FoundSection>
                )}
                {lookup && (!site.trim() || foundTab === 'you') && (
                  <FoundSection from="public pages">
                    <ul className="divide-y divide-border/50">{ME_FOUND.map((f) => <FoundLine key={f.k} text={f.v} src={f.src} />)}</ul>
                  </FoundSection>
                )}
              </>
            )}
          </div>
          <div className="shrink-0 border-t border-border/60 px-8 py-4"><NavRow onBack={back} onNext={next} nextLabel="Looks right" step={5} total={total} /></div>
        </>
      )}

      {step === 6 && (
        <>
          <StepHeader step={6} total={total} title="Your starter plan" subtitle={`Picked for ${company.trim() || COMPANY.name} and what you want first. Connect now or any time later.`} />
          <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">{picking ? <PlanSkeleton /> : <StarterPlan />}</div>
          <div className="shrink-0 border-t border-border/60 px-8 py-4"><NavRow onBack={back} onNext={next} nextLabel="Open workspace" step={6} total={total} /></div>
        </>
      )}

      </div>
      </Card>
      )}

      {step === 7 && (
        <div className="py-24 text-center text-[13px] text-muted-foreground">The workspace opens here. <button className="underline" onClick={() => setStep(1)}>Start over</button></div>
      )}
    </div>
  );
}

// ─── Joining an existing team: only about the person ─────────────────────────

const MEMBER_PLAN = {
  team: [
    { id: 'mailchimp', label: 'Mailchimp', logo: '/integrations/mailchimp.svg' },
    { id: 'calendly', label: 'Calendly', logo: '/integrations/calendly.svg' },
    { id: 'notion', label: 'Notion', logo: '/integrations/notion.svg' },
    { id: 'stripe', label: 'Stripe', logo: '/integrations/stripe.svg' },
    { id: 'linear', label: 'Linear', logo: '/integrations/linear.svg' },
    { id: 'airtable', label: 'Airtable', logo: '/integrations/airtable.svg' },
    { id: 'todoist', label: 'Todoist', logo: '/integrations/todoist.svg' },
  ],
  // Personal reach: connected for this person only, used in their conversations.
  yours: [
    { id: 'google-workspace', label: 'Google', logo: '/integrations/gworkspace.svg', why: 'Your own mail and calendar. Only you and Aria see them.' },
    { id: 'granola', kind: 'notetaker', label: 'Granola', logo: '/integrations/granola.svg', why: 'Your call notes, so follow-ups write themselves. Only you see them.',
      alternatives: [
        { id: 'fireflies', label: 'Fireflies', logo: '/integrations/fireflies.svg' },
        { id: 'fathom', label: 'Fathom', logo: '/integrations/fathom.svg' },
        { id: 'otter', label: 'Otter', logo: '/integrations/otter.svg' },
        { id: 'readai', label: 'Read AI', logo: '/integrations/readai.svg' },
        { id: 'krisp', label: 'Krisp', logo: '/integrations/krisp.svg' },
      ] },
  ],
  routines: [
    { id: 'meeting-prep', icon: Calendar, title: 'Meeting prep', summary: 'Before calls with outside people: who, the last thread, open items.', why: "Works now: the team's Calendly books your calls." },
    { id: 'meeting-followup', icon: Notebook, title: 'After the meeting', summary: 'Turns call notes into tasks and a follow-up draft.', why: 'You follow up with clubs after calls.', needs: 'a notetaker' },
    { id: 'morning-brief', icon: Sun, title: 'Morning brief', summary: "The day's top three and what's due.", why: 'Your first one arrives tomorrow at 08:00.' },
  ],
};

// What the team already connected: three logos and three names, the rest as "+N"
// and "and N more" (the same N), the full list on hover.
function TeamConnections({ tools }) {
  if (!tools.length) return null;
  const shown = tools.slice(0, 3);
  const rest = tools.length - shown.length;
  const names = tools.map((t) => t.label);
  const sentence = names.length <= 3
    ? names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
  return (
    <div title={names.join(', ')} className="mb-6 flex items-center gap-3 rounded-[6px] bg-foreground/[0.035] px-3.5 py-3">
      <div className="flex shrink-0">
        {shown.map((t, i) => (
          <span key={t.id} className={cn('flex size-7 items-center justify-center rounded-full bg-white ring-2 ring-[#f6f5f2] dark:ring-[#262523]', i > 0 && '-ml-2')}>
            <img src={logoUrl(t.logo)} alt="" className="size-4 object-contain" />
          </span>
        ))}
        {rest > 0 && (
          <span className="-ml-2 flex size-7 items-center justify-center rounded-full bg-foreground/[0.08] text-[10.5px] font-semibold text-foreground/70 ring-2 ring-[#f6f5f2] dark:ring-[#262523]">+{rest}</span>
        )}
      </div>
      <p className="text-[12.5px] leading-snug text-foreground/75">Your team already connected {sentence}. {BOT.name} uses them for you too.</p>
    </div>
  );
}

function OptionMember() {
  const [step, setStep] = useState(1);
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('');
  const [help, setHelp] = useState('');
  const [lookup, setLookup] = useState(false);
  const total = lookup ? 3 : 2;
  const planStep = lookup ? 3 : 2;
  const [picking, setPicking] = useState(true);
  useEffect(() => { if (step !== planStep) return; setPicking(true); const t = setTimeout(() => setPicking(false), 5000); return () => clearTimeout(t); }, [step, planStep]);
  return (
    <div className="mx-auto w-full max-w-[880px]">
      <style>{'@keyframes onbIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'}</style>
      {step === 'done' ? (
        <div className="py-24 text-center text-[13px] text-muted-foreground">The workspace opens here. <button className="underline" onClick={() => setStep(1)}>Start over</button></div>
      ) : (
      <Card banner={step === planStep ? 'rings' : 'wave'}>
      <div key={String(step)} className="flex min-h-0 flex-1 flex-col" style={{ animation: 'onbIn .38s cubic-bezier(.2,.7,.2,1)' }}>
        {step === 1 && (
          <>
            <StepHeader step={1} title={`Welcome to ${COMPANY.name}`} subtitle={`${BOT.name} works for the whole team. Tell it a little about you.`} />
            <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">
              <div className="flex gap-3">
                <div className="min-w-0 flex-1">
                  <label className={labelCls}>Full name</label>
                  <input className={cn(inputCls, 'mt-2')} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Jonas Weber" />
                </div>
                <div className="min-w-0 flex-1">
                  <label className={labelCls}>Your role</label>
                  <input className={cn(inputCls, 'mt-2')} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Wholesale · Customer care" />
                </div>
              </div>
              <label className={cn(labelCls, 'mt-6 block')}>What do you need help with?</label>
              <textarea rows={3} className={cn(inputCls, 'mt-2 resize-none leading-snug')} value={help} onChange={(e) => setHelp(e.target.value)}
                placeholder="Following up with clubs after calls, keeping my week organised" />
              <div className="mt-6 flex items-start justify-between gap-4 rounded-[6px] border border-border/60 px-3.5 py-3">
                <div>
                  <div className="text-[13px] font-medium text-foreground/90">Look me up on the web</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground/75">Public pages only. You'll see what it found before anything is kept.</div>
                </div>
                <Toggle on={lookup} small label="Look me up on the web" onClick={() => setLookup((v) => !v)} />
              </div>
            </div>
            <div className="shrink-0 border-t border-border/60 px-8 py-4">
              <NavRow onNext={() => setStep('building')} canNext={!!fullName.trim() && !!role.trim() && !!help.trim()} step={1} total={total} />
            </div>
          </>
        )}
        {step === 'building' && (
          <Building
            stages={['Getting to know you', ...(lookup ? [`Looking up ${fullName.trim() || 'you'}`] : []), `Getting ${BOT.name} ready for you`]}
            onDone={() => setStep(lookup ? 2 : planStep)} />
        )}
        {step === 2 && lookup && (
          <>
            <StepHeader step={2} title="What we found" subtitle="Fix or remove anything that's off." />
            <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">
              <ul className="divide-y divide-border/50">{ME_FOUND.map((f) => <FoundLine key={f.k} text={f.v} src={f.src} />)}</ul>
            </div>
            <div className="shrink-0 border-t border-border/60 px-8 py-4">
              <NavRow onBack={() => setStep(1)} onNext={() => setStep(3)} nextLabel="Looks right" step={2} total={total} />
            </div>
          </>
        )}
        {step === planStep && (
          <>
            <StepHeader step={planStep} title="Your starter plan" subtitle={`Picked for your role and what you want help with.`} />
            <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">
              {picking ? <PlanSkeleton /> : <>
              <TeamConnections tools={MEMBER_PLAN.team} />
              <SectionTitle>Connect yours</SectionTitle>
              <div className="divide-y divide-border/50">{MEMBER_PLAN.yours.map((i) => <PlanIntegration key={i.id} item={i} />)}</div>
              <SectionTitle>Routines for you</SectionTitle>
              <div className="divide-y divide-border/50">{MEMBER_PLAN.routines.map((r) => <PlanRoutine key={r.id} item={r} />)}</div>
              </>}
            </div>
            <div className="shrink-0 border-t border-border/60 px-8 py-4">
              <NavRow onBack={() => setStep(lookup ? 2 : 1)} onNext={() => setStep('done')} nextLabel="Open workspace" step={planStep} total={total} />
            </div>
          </>
        )}
      </div>
      </Card>
      )}
    </div>
  );
}

// ─── The preview shell: switch between the options ───────────────────────────

const OPTIONS = [
  { id: 'a', label: 'First setup (admin)', C: OptionA },
  { id: 'member', label: 'Joining a team', C: OptionMember },
];

export default function OnboardingPreview({ option = 'a' }) {
  const [cur, setCur] = useState(OPTIONS.some((o) => o.id === option) ? option : 'a');
  const pick = (id) => {
    setCur(id);
    const u = new URL(window.location.href); u.searchParams.set('onboarding', id);
    window.history.replaceState(null, '', u);
  };
  const { C } = OPTIONS.find((o) => o.id === cur);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <C key={cur} />
      {OPTIONS.length > 1 && <div className="fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 gap-1 rounded-full border border-border/60 bg-card p-1 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.25)]">
        {OPTIONS.map((o) => (
          <button key={o.id} type="button" onClick={() => pick(o.id)}
            className={cn('rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-colors',
              cur === o.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
            {o.label}
          </button>
        ))}
      </div>}
    </div>
  );
}
