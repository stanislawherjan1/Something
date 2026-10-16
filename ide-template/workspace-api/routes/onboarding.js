/**
 * Onboarding: the company (first admin, once), the person (everyone, once), the
 * research behind the setting-up screen, confirming what was found, and the
 * starter plan.
 *
 *   GET  /onboarding                 where this person is
 *   POST /onboarding/company         admin: name, sentence, website
 *   POST /onboarding/me              full name, role, what they need help with, look-up
 *   POST /onboarding/research        start reading the site / looking the person up
 *   GET  /onboarding/research        the stages, then the findings
 *   POST /onboarding/confirm         the lines kept (edited or not) → memory
 *   GET  /onboarding/plan            the starter plan
 *   POST /onboarding/plan/dismiss    never offer this one again
 *   POST /onboarding/done            setup finished for this person
 *
 * Memory is written only through the memory engine: the company to the shared
 * "About the company" card, the person to their own "About you" (private in a
 * team). Nothing found is kept unless the person confirms it.
 */
import { Router } from 'express';
import { requireActor } from '../lib/auth.js';
import { getUser, getTeamMode, primaryAdminSlug, setProfile } from '../lib/team.js';
import { resolve as resolveBranding } from '../lib/branding.js';
import { remember as engineRemember } from '../lib/memory-engine.js';
import { status as setupStatus } from '../lib/setup.js';
import { isUsable as integrationUsable, personalKey } from '../lib/integrations/store.js';
import * as integrationsCatalog from '../lib/integrations/catalog.js';
import { readRoutines } from '../lib/routines-store.js';
import { routinesOwner } from '../lib/memory-v4-writes.js';
import { flushWaiting, readWaiting } from '../lib/routines-add.js';
import { normalizeSite } from '../lib/onboarding/site.js';
import { buildPlan } from '../lib/onboarding/plan.js';
import * as state from '../lib/onboarding/state.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LIMITS = { name: 80, sentence: 300, fullName: 120, role: 80, help: 600, fact: 180 };

function viewer(req) {
  if (!req.actor) return null;
  const u = getUser(req.actor);
  const team = getTeamMode();
  const slug = u?.slug || (team ? null : primaryAdminSlug());
  if (!slug || slug === 'default' || !SLUG_RE.test(slug)) return null;
  // Solo: the one person is the admin of their workspace.
  return { slug, isAdmin: team ? u?.role === 'admin' : true, team };
}

function handler(fn) {
  return async (req, res) => {
    const v = viewer(req);
    if (!v) return res.status(403).json({ ok: false, error: 'not on this workspace\'s team' });
    res.set('Cache-Control', 'no-store');
    try { return await fn(req, res, v); } catch (err) {
      process.stderr.write(`[onboarding] ${req.method} ${req.path}: ${err.stack || err}\n`);
      return res.status(500).json({ ok: false, error: err.message });
    }
  };
}

// A few writes a minute per person is plenty for a wizard.
const hits = new Map();
function limited(slug, max = 30, bucket = 'writes') {
  const key = `${bucket}:${slug}`;
  const now = Date.now();
  const h = (hits.get(key) || []).filter((t) => now - t < 60_000);
  h.push(now); hits.set(key, h);
  return h.length > max;
}

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The company step happens once, for the first admin; everyone else skips it.
const companyNeeded = (v) => v.isAdmin && !state.readCompany()?.confirmed;

const usableFor = (slug) => (id) => integrationUsable(id) || integrationUsable(personalKey(id, slug));

export default function onboardingRouter() {
  const router = Router();

  router.get('/onboarding', requireActor, handler(async (req, res, v) => {
    const company = state.readCompany();
    const person = state.readPerson(v.slug) || {};
    // Who goes through it: a fresh install's admin; anyone who started and hasn't
    // finished; anyone added after this workspace got onboarding. People already
    // using a workspace when it was updated are never sent back to the start.
    let setupComplete = true;
    try { setupComplete = !!setupStatus()?.complete; } catch { /* treat as set up */ }
    const since = state.onboardingSince(setupComplete);
    const addedAt = getUser(req.actor)?.addedAt || null;
    const show = !person.done && (
      (v.isAdmin && !setupComplete)
      || !!person.fullName
      || (!!addedAt && addedAt > since)
      || (!v.team && !setupComplete));
    res.json({
      ok: true, show,
      admin: v.isAdmin, team: v.team,
      steps: { company: companyNeeded(v), person: !person.confirmed, done: !!person.done },
      company: company ? { name: company.name || '', sentence: company.sentence || '', site: company.site || '', confirmed: !!company.confirmed } : null,
      person: { fullName: person.fullName || '', role: person.role || '', help: person.help || '', lookup: !!person.lookup, confirmed: !!person.confirmed },
    });
  }));

  router.post('/onboarding/company', requireActor, handler(async (req, res, v) => {
    if (!v.isAdmin) return res.status(403).json({ ok: false, error: 'the company is set up by an admin' });
    if (limited(v.slug)) return res.status(429).json({ ok: false, error: 'too many changes, try again in a minute' });
    const name = str(req.body?.name, LIMITS.name);
    const sentence = str(req.body?.sentence, LIMITS.sentence);
    if (!name || !sentence) return res.status(400).json({ ok: false, error: 'the company\'s name and one sentence on what it does are needed' });
    const rawSite = str(req.body?.site, 300);
    const site = rawSite ? normalizeSite(rawSite) : null;
    if (rawSite && !site) return res.status(400).json({ ok: false, error: 'that is not a public website address' });
    state.writeCompany({ name, sentence, site, findings: null, confirmed: false });
    res.json({ ok: true });
  }));

  router.post('/onboarding/me', requireActor, handler(async (req, res, v) => {
    if (limited(v.slug)) return res.status(429).json({ ok: false, error: 'too many changes, try again in a minute' });
    const before = state.readPerson(v.slug) || {};
    // Onboarding is about the person, once: after they confirmed, it is closed —
    // their profile is theirs to change on the Memory screen, not here.
    if (before.confirmed) return res.status(409).json({ ok: false, error: 'you have already been set up' });
    const fullName = str(req.body?.fullName, LIMITS.fullName);
    const role = str(req.body?.role, LIMITS.role);
    const help = str(req.body?.help, LIMITS.help);
    if (!fullName || !role || !help) return res.status(400).json({ ok: false, error: 'your name, your role and what you need help with are needed' });
    // The web look-up is about the person themselves, and runs once: after it
    // has run, the name it ran on is kept for it — changing the name later does
    // not buy another look-up of someone else.
    const lookup = req.body?.lookup === true;
    state.writePerson(v.slug, { fullName, role, help, lookup, findings: null, confirmed: false, plan: null });
    // The name they gave is the name the workspace shows (team list, menu,
    // relays) — not the one the sign-in provider happened to carry.
    try { setProfile(req.actor, { displayName: fullName }); }
    catch (err) { process.stderr.write(`[onboarding] display name: ${err.message}\n`); }
    res.json({ ok: true });
  }));

  router.post('/onboarding/research', requireActor, handler(async (req, res, v) => {
    if (limited(v.slug, 10, 'research')) return res.status(429).json({ ok: false, error: 'too many tries, wait a minute' });
    const me = state.readPerson(v.slug);
    if (!me?.fullName) return res.status(400).json({ ok: false, error: 'tell us about you first' });
    if (me.confirmed) return res.status(409).json({ ok: false, error: 'you have already been set up' });
    // A few runs a day is plenty for one person's setup; more is not setup.
    if (!state.takeResearchRun(v.slug)) return res.status(429).json({ ok: false, error: 'That is enough tries for today. Carry on without it, or try again tomorrow.' });
    if (companyNeeded(v) && !state.readCompany()?.name) return res.status(400).json({ ok: false, error: 'set up the company first' });
    const job = state.startResearch({
      slug: v.slug,
      admin: companyNeeded(v),
      botName: resolveBranding()?.botName,
      checkClaude: async () => { if (!state.claudeReady()) throw new Error('Claude is not connected yet'); },
    });
    res.json({ ok: true, stages: job.stages, done: job.done });
  }));

  router.get('/onboarding/research', requireActor, handler(async (req, res, v) => {
    const job = state.jobOf(v.slug);
    if (!job) return res.json({ ok: true, stages: [], done: true, findings: state.findingsFor(v.slug, { admin: companyNeeded(v) }) });
    res.json({
      ok: true, stages: job.stages, done: job.done, error: job.error,
      ...(job.done ? { findings: state.findingsFor(v.slug, { admin: companyNeeded(v) }) } : {}),
    });
  }));

  // What the person kept. Each line must come from the drafts (its source is one
  // the research found) — text may be edited, nothing new can be slipped in.
  router.post('/onboarding/confirm', requireActor, handler(async (req, res, v) => {
    if (limited(v.slug)) return res.status(429).json({ ok: false, error: 'too many changes, try again in a minute' });
    const person = state.readPerson(v.slug);
    if (!person?.fullName) return res.status(400).json({ ok: false, error: 'tell us about you first' });
    if (person.confirmed) return res.status(409).json({ ok: false, error: 'you have already been set up' });
    const kept = (list, allowed) => (Array.isArray(list) ? list : [])
      .map((f) => ({ text: str(f?.text, LIMITS.fact), source: String(f?.source || '') }))
      .filter((f) => f.text && allowed.has(f.source));
    const written = { company: 0, person: 0 };
    const failed = [];

    if (companyNeeded(v)) {
      const company = state.readCompany();
      const allowed = new Set((company.findings?.facts || []).map((f) => f.source));
      // Who the company is first — its name, what it does in the owner's words,
      // its website — then what was found about it.
      const host = company.site ? new URL(company.site).hostname.replace(/^www\./, '') : null;
      const lines = [
        { text: `Name: ${company.name}`, source: 'setup' },
        { text: `What it does: ${company.sentence}`, source: 'setup' },
        ...(host ? [{ text: `Website: ${host}`, source: 'setup' }] : []),
        ...kept(req.body?.company, allowed),
      ];
      for (const l of lines) {
        const out = engineRemember({ actor: v.slug, scope: 'shared', card: 'MISSION', section: 'About the company', text: l.text, source: l.source });
        if (out?.ok) written.company++;
        else if (!/already/i.test(out?.error || '')) failed.push(out?.error || 'not written');
      }
      if (!failed.length) state.writeCompany({ confirmed: true, spotted: company.findings?.tools || [], confirmedAt: new Date().toISOString() });
    }

    const allowedMe = new Set((person.findings?.facts || []).map((f) => f.source));
    // Into the card's own places: name and role fill its Identity fields, what
    // they need help with is what they are focused on, the look-up is background.
    const meLines = [
      { text: `Name: ${person.fullName}`, source: 'setup', section: 'Identity' },
      { text: `Roles: ${person.role}`, source: 'setup', section: 'Identity' },
      { text: `Needs help with: ${person.help}`, source: 'setup', section: 'Currently focused on' },
      ...kept(req.body?.person, allowedMe).map((f) => ({ ...f, section: 'Background' })),
    ];
    for (const l of meLines) {
      const out = engineRemember({
        // Always the person's own card: the engine puts it under users/ in a
        // team and flat in solo, where the prefix reads it.
        actor: v.slug, scope: 'private', owner: v.slug,
        card: 'USER_PROFILE', section: l.section, text: l.text, source: l.source,
      });
      if (out?.ok) written.person++;
      else if (!/already/i.test(out?.error || '')) failed.push(out?.error || 'not written');
    }
    // Memory refused something: say so, and leave the step open to try again —
    // a setup that "worked" with nothing in memory is the worst outcome.
    if (failed.length) {
      process.stderr.write(`[onboarding] confirm for ${v.slug}: ${failed.join('; ')}\n`);
      return res.status(500).json({ ok: false, error: 'Memory could not be written, so nothing was saved. Try again in a moment.', written });
    }
    state.writePerson(v.slug, { confirmed: true, kept: meLines.slice(3).map(({ text, source }) => ({ text, source })), confirmedAt: new Date().toISOString() });
    res.json({ ok: true, written });
  }));

  router.get('/onboarding/plan', requireActor, handler(async (req, res, v) => {
    const person = state.readPerson(v.slug) || {};
    // What of the plan is already theirs: added, or waiting for its integration.
    const owner = routinesOwner(v.slug);
    let added = new Set(), waiting = new Set();
    try {
      flushWaiting(owner);
      added = new Set(readRoutines(owner).routines.filter((r) => !r.retired && r.catalogId).map((r) => r.catalogId));
      waiting = new Set(readWaiting(owner).map((w) => w.id));
    } catch { /* no routines yet */ }
    const marked = (plan) => ({ ...plan, routines: plan.routines.map((r) => ({ ...r, state: added.has(r.id) ? 'added' : waiting.has(r.id) ? 'waiting' : null })) });
    const usable = usableFor(v.slug);
    const connected = new Set(integrationsCatalog.listAll().map((e) => e.id).filter(usable));
    const team = [...connected].filter((id) => integrationUsable(id)).map((id) => ({ id, label: integrationsCatalog.get(id)?.label, logo: integrationsCatalog.get(id)?.logo }));
    if (person.plan && req.query.fresh !== '1') return res.json({ ok: true, plan: marked(person.plan), team });
    const company = state.readCompany() || {};
    const dismissed = new Set(person.dismissed || []);
    const plan = await buildPlan({
      profile: {
        company: { name: company.name, sentence: company.sentence, facts: (company.findings?.facts || []) },
        person: { role: person.role, help: person.help, facts: person.kept || [] },
        spotted: company.spotted || company.findings?.tools || [],
      },
      connected, dismissed, added: new Set([...added, ...waiting]),
      personal: v.team && !v.isAdmin,
    });
    state.writePerson(v.slug, { plan });
    res.json({ ok: true, plan: marked(plan), team });
  }));

  router.post('/onboarding/plan/dismiss', requireActor, handler(async (req, res, v) => {
    const id = String(req.body?.id || '');
    if (!/^[a-z0-9-]{1,64}$/.test(id)) return res.status(400).json({ ok: false, error: 'id required' });
    const person = state.readPerson(v.slug) || {};
    const dismissed = [...new Set([...(person.dismissed || []), id])];
    const plan = person.plan ? {
      integrations: person.plan.integrations.filter((i) => i.id !== id),
      routines: person.plan.routines.filter((r) => r.id !== id),
    } : null;
    state.writePerson(v.slug, { dismissed, plan });
    res.json({ ok: true });
  }));

  router.post('/onboarding/done', requireActor, handler(async (req, res, v) => {
    state.writePerson(v.slug, { done: true, doneAt: new Date().toISOString() });
    res.json({ ok: true });
  }));

  return router;
}
