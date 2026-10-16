// Onboarding: the first admin sets up the coworker, the company and themselves;
// anyone joining later says who they are. Then the setting-up screen while the
// website and the web are read, what was found (to fix or remove), and a starter
// plan: integrations that connect in one click and routines, each with why.
//
// Everything is saved as it goes (routes/onboarding.js, routes/setup.js), so a
// reload resumes where the person was.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe, ImagePlus, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBranding } from '../workspace/identity';
import { useTheme } from '@/context/ThemeContext';
import { invalidate } from '@/lib/useApi';
import { PRESET_AVATARS } from '../workspace/views/AvatarTile.jsx';
import { Toggle } from '../workspace/views/IntegrationsDashboard.jsx';
import { openOAuthPopup, isRemoteMcpOauth } from '../workspace/views/integrationConnect.js';
import { Card, StepHeader, NavRow, inputCls, labelCls, Step2Avatar, TokenHelp } from '../SetupWizard.jsx';
import { FoundLine, ToolPills, Building, PlanIntegration, PlanRoutine, PlanSkeleton, SectionTitle, TextTabs, TeamConnections } from './parts.jsx';

async function api(path, { method = 'GET', body } = {}) {
  const resp = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
  return data;
}
const upload = (path, file) => { const fd = new FormData(); fd.append('avatar', file); return api(path, { method: 'POST', body: fd }); };

function ErrorLine({ error }) {
  if (!error) return null;
  return (
    <div className="mt-4 flex items-start gap-2 rounded-[6px] border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[12px] text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={2} /><span>{error}</span>
    </div>
  );
}

function Bar({ children }) { return <div className="shrink-0 border-t border-border/60 px-8 py-4">{children}</div>; }
function Body({ children }) { return <div className="flex-1 overflow-y-auto px-8 pb-6 pt-6">{children}</div>; }
const Optional = () => <span className="normal-case tracking-normal text-muted-foreground/55">(optional)</span>;

/**
 * `setup`: /api/setup/status; `onb`: /api/onboarding. `onComplete` when the
 * person opens their workspace.
 */
export default function Onboarding({ setup, onb, onComplete }) {
  // A new person's workspace starts on the system's light or dark: the
  // address may have been used before, and a choice saved then in this
  // browser is not theirs. The wizard has no theme switch to undo.
  const { setTheme } = useTheme();
  useEffect(() => { setTheme('system'); }, [setTheme]);
  const { reload: reloadBranding, botName: brandBot } = useBranding();
  const admin = !!onb?.admin;
  const companyStep = !!onb?.steps?.company;            // the first admin, once
  const needsToken = !setup?.state?.hasClaudeToken;
  // Setup reports defaults ("assistant", "Workspace") for what was never set: go by what's missing.
  const missing = new Set(setup?.missing || []);
  const needsBot = admin && companyStep && missing.has('botName');

  // The steps this person goes through, in order.
  const order = [
    ...(needsBot ? ['bot'] : []),
    ...(companyStep ? ['company'] : []),
    'me',
    ...(admin && needsToken ? ['token'] : []),
    'building', 'found', 'plan',
  ];
  const numbered = order.filter((s) => s !== 'building');
  const [step, setStep] = useState(order[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // The coworker
  const [botName, setBotName] = useState(missing.has('botName') ? '' : (setup?.state?.botName || ''));
  const [avatarIdx, setAvatarIdx] = useState(0);
  const [customAvatar, setCustomAvatar] = useState(null);
  // The company
  const [company, setCompany] = useState(onb?.company?.name || (missing.has('title') ? '' : setup?.state?.title || ''));
  const [sentence, setSentence] = useState(onb?.company?.sentence || '');
  const [site, setSite] = useState((onb?.company?.site || '').replace(/^https?:\/\//, '').replace(/\/$/, ''));
  const [logo, setLogo] = useState(null);
  const logoRef = useRef(null);
  // The person
  const [fullName, setFullName] = useState(onb?.person?.fullName || '');
  const [role, setRole] = useState(onb?.person?.role || '');
  const [help, setHelp] = useState(onb?.person?.help || '');
  const [lookup, setLookup] = useState(!!onb?.person?.lookup);
  // Claude
  const [token, setToken] = useState('');
  // Research → findings → plan
  const [stages, setStages] = useState([]);
  const [findings, setFindings] = useState(null);       // { company?: {facts,tools,favicon,site,name}, person?: {facts} }
  const [tab, setTab] = useState('company');
  const [plan, setPlan] = useState(null);
  const [team, setTeam] = useState([]);
  const [catalog, setCatalog] = useState([]);
  // What this person can use now — the team's, or their own — so a routine's
  // Add switches on the moment its app is connected in the plan above.
  const [justConnected, setJustConnected] = useState(() => new Set());
  const connectedIds = new Set([
    ...catalog.filter((x) => x.active || x.mine?.active).map((x) => x.id),
    ...justConnected,
  ]);
  const routineReady = (r) => (r.requiresAll || []).every((id) => connectedIds.has(id))
    && (!(r.requires || []).length || r.requires.some((id) => connectedIds.has(id)));

  const who = botName.trim() || brandBot || 'your coworker';
  const go = (s) => { setError(null); setStep(s); };
  const next = () => go(order[order.indexOf(step) + 1]);
  const back = () => go(order[Math.max(0, order.indexOf(step) - 1)]);
  const num = (s) => numbered.indexOf(s) + 1;
  const run = async (fn) => { setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); } };

  // ── saves, step by step ───────────────────────────────────────────────────
  const saveBot = () => run(async () => {
    await api('/setup/branding', { method: 'POST', body: { botName: botName.trim() } });
    if (customAvatar) await upload('/setup/avatar', customAvatar.file);
    else await api('/setup/avatar/preset', { method: 'POST', body: { preset: PRESET_AVATARS[avatarIdx].id } });
    reloadBranding(); next();
  });
  const saveCompany = () => run(async () => {
    await api('/setup/branding', { method: 'POST', body: { title: company.trim() } });
    if (logo) await upload('/setup/logo', logo.file);
    await api('/onboarding/company', { method: 'POST', body: { name: company.trim(), sentence: sentence.trim(), site: site.trim() } });
    reloadBranding(); next();
  });
  const saveMe = () => run(async () => {
    await api('/onboarding/me', { method: 'POST', body: { fullName: fullName.trim(), role: role.trim(), help: help.trim(), lookup } });
    invalidate('/api/me'); invalidate('/api/team');   // the name they gave is now the roster's
    next();
  });
  const saveToken = () => run(async () => {
    await api('/setup/token', { method: 'POST', body: { token: token.trim() } });
    next();
  });

  // ── the research: start, then follow the stages ───────────────────────────
  const polling = useRef(null);
  const startResearch = useCallback(async () => {
    try {
      const r = await api('/onboarding/research', { method: 'POST' });
      setStages(r.stages || []);
      const tick = async () => {
        const s = await api('/onboarding/research');
        setStages(s.stages || []);
        if (!s.done) { polling.current = setTimeout(tick, 900); return; }
        if (s.error) { setError(s.error); return; }
        const f = s.findings || {};
        setFindings(f);
        if (f.company?.tools?.length) api('/integrations').then((c) => setCatalog(c.integrations || [])).catch(() => {});
        setTab(f.company ? 'company' : 'you');
        // Let the last tick show before the screen changes.
        setTimeout(() => go(f.company || f.person ? 'found' : 'plan'), 600);
      };
      polling.current = setTimeout(tick, 600);
    } catch (e) { setError(e.message); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (step === 'building') startResearch();
    return () => clearTimeout(polling.current);
  }, [step, startResearch]);

  // ── confirming what was found ─────────────────────────────────────────────
  const editLine = (part, i, text) => setFindings((f) => ({ ...f, [part]: { ...f[part], facts: f[part].facts.map((x, j) => (j === i ? { ...x, text } : x)) } }));
  const dropLine = (part, i) => setFindings((f) => ({ ...f, [part]: { ...f[part], facts: f[part].facts.filter((_, j) => j !== i) } }));
  const confirm = () => run(async () => {
    await api('/onboarding/confirm', { method: 'POST', body: { company: findings?.company?.facts || [], person: findings?.person?.facts || [] } });
    go('plan');
  });

  // ── the plan ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== 'plan') return;
    let live = true;
    (async () => {
      try {
        // Nothing found to confirm: the person's own answers still go to memory.
        if (!findings?.company && !findings?.person) await api('/onboarding/confirm', { method: 'POST', body: {} }).catch(() => {});
        const [p, c] = await Promise.all([api('/onboarding/plan'), api('/integrations')]);
        if (!live) return;
        setPlan(p.plan); setTeam(p.team || []); setCatalog(c.integrations || []);
      } catch (e) { if (live) setError(e.message); }
    })();
    return () => { live = false; };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  // Connect opens the provider's sign-in at once (from the click, or popup
  // blockers eat it) and resolves connected or not. The popup's result page
  // posts `integration-oauth` back; when it can't (providers that cut the
  // opener off read as closed at once), the integrations list is polled
  // until it shows the connection or the wait runs out.
  const connect = (id) => new Promise((resolve, reject) => {
    const entry = catalog.find((x) => x.id === id) || { id, fields: [{ type: 'remote-mcp-oauth' }] };
    const reach = admin ? 'workspace' : 'personal';
    if (!isRemoteMcpOauth(entry)) {
      api(`/integrations/${encodeURIComponent(id)}${reach === 'personal' ? '?reach=personal' : '?access=read'}`, { method: 'PUT', body: { fields: {} } })
        .then(() => resolve(true), reject);
      return;
    }
    let settled = false, timer = null;
    const settle = (ok) => {
      if (settled) return;
      settled = true; clearTimeout(timer); window.removeEventListener('message', onMsg); resolve(ok);
    };
    const onMsg = (e) => {
      if (e.origin !== window.location.origin || e.data?.type !== 'integration-oauth' || e.data.id !== id) return;
      settle(!!e.data.ok);
    };
    const isOn = async () => {
      const c = await api('/integrations');
      const e = (c.integrations || []).find((x) => x.id === id);
      return !!(reach === 'personal' ? e?.mine?.active : e?.active);
    };
    const until = Date.now() + 180_000;
    const poll = async () => {
      if (settled) return;
      try { if (await isOn()) return settle(true); } catch { /* keep trying */ }
      if (Date.now() > until) return settle(false);
      timer = setTimeout(poll, 1500);
    };
    window.addEventListener('message', onMsg);
    const opened = openOAuthPopup(entry, poll, { reach, access: 'read' });
    if (!opened) { settled = true; window.removeEventListener('message', onMsg); reject(new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.')); }
  });
  const addRoutine = async (id) => {
    await api(`/routines/catalog/${encodeURIComponent(id)}`, { method: 'POST' });
    return 'added';
  };
  const finish = () => run(async () => { await api('/onboarding/done', { method: 'POST' }); onComplete?.(); });

  // ── the screens ───────────────────────────────────────────────────────────
  const total = numbered.length;
  const tabs = findings?.company && findings?.person;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12 text-foreground"
      style={{ fontFamily: '"Geist Variable","Geist",-apple-system,BlinkMacSystemFont,system-ui,sans-serif' }}>
      <style>{'@keyframes onbIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'}</style>
      <div className="mx-auto w-full max-w-[880px]">
        <Card banner={step === 'plan' ? 'rings' : 'wave'}>
          <div key={step} className="flex min-h-0 flex-1 flex-col" style={{ animation: 'onbIn .38s cubic-bezier(.2,.7,.2,1)' }}>

            {step === 'bot' && (
              <Step2Avatar bare step={num('bot')} total={total} title="Meet your coworker" subtitle="A name and a face. Everything else it learns from you."
                botName={botName} setBotName={setBotName}
                avatarIdx={avatarIdx} onPickPreset={(i) => { setAvatarIdx(i); setCustomAvatar(null); }}
                customAvatar={customAvatar} onPickFile={(f) => f && setCustomAvatar({ file: f, url: URL.createObjectURL(f) })}
                onNext={saveBot} busy={busy} error={error} canNext={!!botName.trim()} />
            )}

            {step === 'company' && (
              <>
                <StepHeader step={num('company')} title="Your company" subtitle={`So ${who} knows what you do from the first day.`} />
                <Body>
                  <div className="flex gap-3">
                    <div className="shrink-0">
                      <label className={labelCls}>Logo</label>
                      <input ref={logoRef} type="file" accept="image/png,image/jpeg" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) setLogo({ file: f, url: URL.createObjectURL(f) }); e.target.value = ''; }} />
                      <button type="button" onClick={() => logoRef.current?.click()} title={logo ? 'Change the logo' : 'Upload a logo (optional)'}
                        className={cn('mt-2 flex h-[38px] items-center gap-2 rounded-[6px] pl-1.5 pr-3 text-[12.5px] font-medium transition-colors',
                          logo ? 'border border-border/60 text-foreground/80 hover:border-foreground/30' : 'border border-dashed border-border/80 text-muted-foreground/70 hover:border-foreground/30 hover:text-foreground/80')}>
                        <span className="flex size-7 items-center justify-center overflow-hidden rounded-[4px] bg-[#f1efea] dark:bg-[#2a2826]">
                          {logo ? <img src={logo.url} alt="" className="size-full bg-card object-contain p-0.5" /> : <ImagePlus className="size-3.5" strokeWidth={1.75} />}
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
                  <input className={cn(inputCls, 'mt-2')} value={sentence} onChange={(e) => setSentence(e.target.value)}
                    placeholder="We sell outdoor and camping gear online, mostly to hikers and clubs" />
                  <label className={cn(labelCls, 'mt-6 block')}>Website <Optional /></label>
                  <div className="relative mt-2">
                    <Globe className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" strokeWidth={1.75} />
                    <input className={cn(inputCls, 'pl-8')} value={site} onChange={(e) => setSite(e.target.value)} placeholder="yourcompany.com" />
                  </div>
                  <ErrorLine error={error} />
                </Body>
                <Bar><NavRow onBack={order.indexOf('company') > 0 ? back : undefined} onNext={saveCompany} busy={busy}
                  canNext={!!company.trim() && !!sentence.trim()} step={num('company')} total={total} /></Bar>
              </>
            )}

            {step === 'me' && (
              <>
                <StepHeader step={num('me')} title={companyStep ? 'About you' : `Welcome to ${onb?.company?.name || 'the team'}`}
                  subtitle={companyStep ? `So ${who} knows who it works with.` : `${who} works for the whole team. Tell it a little about you.`} />
                <Body>
                  <div className="flex gap-3">
                    <div className="min-w-0 flex-1">
                      <label className={labelCls}>Full name</label>
                      <input className={cn(inputCls, 'mt-2')} value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name and surname" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <label className={labelCls}>Your role</label>
                      <input className={cn(inputCls, 'mt-2')} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Founder · Head of sales" />
                    </div>
                  </div>
                  <label className={cn(labelCls, 'mt-6 block')}>What do you need help with?</label>
                  <textarea rows={3} className={cn(inputCls, 'mt-2 resize-none leading-snug')} value={help} onChange={(e) => setHelp(e.target.value)}
                    placeholder="Answering customer emails, keeping an eye on stock, preparing the weekly numbers" />
                  <div className="mt-6 flex items-start justify-between gap-4 rounded-[6px] border border-border/60 px-3.5 py-3">
                    <div>
                      <div className="text-[13px] font-medium text-foreground/90">Look me up on the web</div>
                      <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground/75">Public pages only. You'll see what it found before anything is kept.</div>
                    </div>
                    <Toggle on={lookup} small label="Look me up on the web" onClick={() => setLookup((x) => !x)} />
                  </div>
                  <ErrorLine error={error} />
                </Body>
                <Bar><NavRow onBack={order.indexOf('me') > 0 ? back : undefined} onNext={saveMe} busy={busy}
                  canNext={!!fullName.trim() && !!role.trim() && !!help.trim()} step={num('me')} total={total} /></Bar>
              </>
            )}

            {step === 'token' && (
              <>
                <StepHeader step={num('token')} title="Connect Claude" subtitle="Your coworker runs on your own Claude plan. The token is stored encrypted on your server and never leaves it." />
                <Body>
                  <label className={labelCls}>Claude token</label>
                  <input type="password" className={cn(inputCls, 'mt-2 font-mono')} value={token} onChange={(e) => setToken(e.target.value)} placeholder="sk-ant-oat01-…" spellCheck={false} autoComplete="off" />
                  <div className="mt-3"><TokenHelp /></div>
                  <ErrorLine error={error} />
                </Body>
                <Bar><NavRow onBack={back} onNext={saveToken} busy={busy} canNext={!!token.trim()} step={num('token')} total={total} /></Bar>
              </>
            )}

            {step === 'building' && (
              <>
                <Building stages={stages} />
                {error && (
                  <div className="px-12 pb-8">
                    <ErrorLine error={error} />
                    <div className="mt-3 flex gap-2">
                      <button type="button" className="text-[12.5px] font-medium text-foreground/80 underline" onClick={() => { setError(null); startResearch(); }}>Try again</button>
                      {admin && needsToken && <button type="button" className="text-[12.5px] text-muted-foreground underline" onClick={() => go('token')}>Check the token</button>}
                    </div>
                  </div>
                )}
              </>
            )}

            {step === 'found' && findings && (
              <>
                <StepHeader step={num('found')} title="What we found" subtitle="Fix or remove anything that's off."
                  tabs={tabs ? <TextTabs value={tab} onChange={setTab} items={[{ id: 'company', label: findings.company.name || 'Company' }, { id: 'you', label: 'You' }]} /> : null} />
                <Body>
                  {findings.company && (!tabs || tab === 'company') && (
                    <section>
                      <ul className="divide-y divide-border/50">
                        {findings.company.facts.map((f, i) => (
                          <FoundLine key={`${f.source}-${i}`} text={f.text} src={f.source}
                            favicon={sameSite(f.source, findings.company.site) ? findings.company.favicon : null}
                            onChange={(t) => editLine('company', i, t)} onRemove={() => dropLine('company', i)} />
                        ))}
                      </ul>
                      {findings.company.tools?.length > 0 && (
                        <div className="mt-6">
                          <div className="mb-2 text-[12px] text-muted-foreground/70">Tools we spotted on {hostOf(findings.company.site)}</div>
                          <ToolPills tools={findings.company.tools.map((t) => ({ ...t, ...(catalogEntry(catalog, t.id)) }))} />
                        </div>
                      )}
                    </section>
                  )}
                  {findings.person && (!tabs || tab === 'you') && (
                    <ul className="divide-y divide-border/50">
                      {findings.person.facts.map((f, i) => (
                        <FoundLine key={`${f.source}-${i}`} text={f.text} src={f.source}
                          onChange={(t) => editLine('person', i, t)} onRemove={() => dropLine('person', i)} />
                      ))}
                    </ul>
                  )}
                  <ErrorLine error={error} />
                </Body>
                <Bar><NavRow onBack={undefined} onNext={confirm} busy={busy} nextLabel="Looks right" step={num('found')} total={total} /></Bar>
              </>
            )}

            {step === 'plan' && (
              <>
                <StepHeader step={num('plan')} title="Your starter plan"
                  subtitle={admin ? `Picked for ${company.trim() || onb?.company?.name || 'you'} and what you want first. Connect now or any time later.` : 'Picked for your role and what you want help with.'} />
                <Body>
                  {!plan ? <PlanSkeleton /> : (
                    <>
                      {!admin && <TeamConnections tools={team} botName={who} />}
                      {plan.integrations.length > 0 && (
                        <>
                          <SectionTitle>{admin ? 'Connect first' : 'Connect yours'}</SectionTitle>
                          <div className="divide-y divide-border/50">{plan.integrations.map((i) => <PlanIntegration key={i.id} item={i} onConnect={(id) => connect(id).then((ok) => { if (ok) setJustConnected((prev) => new Set([...prev, id])); return ok; })} />)}</div>
                        </>
                      )}
                      {plan.routines.length > 0 && (
                        <>
                          <SectionTitle>Routines for you</SectionTitle>
                          <div className="divide-y divide-border/50">{plan.routines.map((r) => <PlanRoutine key={r.id} item={r} ready={routineReady(r)} onAdd={addRoutine} />)}</div>
                        </>
                      )}
                    </>
                  )}
                  <ErrorLine error={error} />
                </Body>
                <Bar><NavRow onNext={finish} busy={busy} nextLabel="Open workspace" step={num('plan')} total={total} /></Bar>
              </>
            )}

          </div>
        </Card>
      </div>
    </div>
  );
}

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url || ''); } }
function sameSite(a, b) { return !!a && !!b && hostOf(a) === hostOf(b); }
function catalogEntry(catalog, id) { const e = catalog.find((x) => x.id === id); return e ? { label: e.label, logo: e.logo } : {}; }
