/**
 * Onboarding's state, in workspace-api's own store (never the project tree, so no
 * turn can read another person's answers): the company — once, by the first
 * admin — and each person's own answers, findings and plan.
 *
 *   <store>/onboarding/company.json          name, sentence, site, findings, confirmed
 *   <store>/onboarding/people/<slug>.json    answers, findings, plan, dismissed, done
 *
 * Research runs in the background, one job per person; its stages are what the
 * setting-up screen shows. Findings are drafts until the person confirms them.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_DIR } from '../config.js';
import { readSite } from './site.js';
import { draftCompany, lookupPerson, lookupCompany, MAX_COMPANY_FACTS } from './profile.js';
import { hasClaudeToken } from '../setup.js';

const DIR = () => join(process.env.WSAPI_STORE_DIR || join(PROJECT_DIR, '.integrations'), 'onboarding');
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function ensure(sub = '') {
  const d = join(DIR(), sub);
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
function readJson(path, fallback) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback; } catch { return fallback; }
}
function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* best effort */ }
  renameSync(tmp, path);
}

const companyPath = () => join(ensure(), 'company.json');
const personPath = (slug) => {
  if (!SLUG_RE.test(slug)) throw new Error('bad slug');
  return join(ensure('people'), `${slug}.json`);
};

/**
 * When this workspace got onboarding. A workspace already set up when it first
 * ran this version starts from now — everyone on it then is past onboarding; a
 * fresh install starts from the beginning of time, so everyone goes through it.
 */
export function onboardingSince(setupComplete) {
  const p = join(ensure(), 'since.json');
  const have = readJson(p, null);
  if (have?.at) return have.at;
  const at = setupComplete ? new Date().toISOString() : '1970-01-01T00:00:00.000Z';
  writeJson(p, { at });
  return at;
}

export const RESEARCH_RUNS_PER_DAY = 3;
/** Count one research run for a person today; false when they used today's runs. */
export function takeResearchRun(slug, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const p = readPerson(slug) || {};
  const runs = p.runs?.day === day ? p.runs.n : 0;
  if (runs >= RESEARCH_RUNS_PER_DAY) return false;
  writePerson(slug, { runs: { day, n: runs + 1 } });
  return true;
}

export function readCompany() { return readJson(companyPath(), null); }
export function writeCompany(patch) {
  const next = { ...(readCompany() || {}), ...patch, updatedAt: new Date().toISOString() };
  writeJson(companyPath(), next);
  return next;
}
export function readPerson(slug) { return readJson(personPath(slug), null); }
export function writePerson(slug, patch) {
  const next = { ...(readPerson(slug) || {}), ...patch, updatedAt: new Date().toISOString() };
  writeJson(personPath(slug), next);
  return next;
}

// ─── the research job ────────────────────────────────────────────────────────

const jobs = new Map();   // slug → { stages, done, error, startedAt }
let testHooks = {};
/** Tests: replace the site reader and the drafts for every job. */
export function configureHooks(h) { testHooks = h || {}; }
/** Whether the model can be reached: a Claude token is saved. */
export function claudeReady() { return testHooks.claudeReady ? testHooks.claudeReady() : hasClaudeToken(); }

/** The stages for this person: what the setting-up screen lists, in order. */
export function stagesFor({ admin, company, person, botName }) {
  const s = [];
  if (admin) s.push({ id: 'claude', label: 'Connecting to Claude' });
  else s.push({ id: 'you', label: 'Getting to know you' });
  if (admin && company?.name) s.push({ id: 'web', label: `Looking up ${company.name}` });
  if (admin && company?.site) s.push({ id: 'site', label: `Reading ${new URL(company.site).hostname.replace(/^www\./, '')}` });
  if (person?.lookup) s.push({ id: 'lookup', label: `Looking up ${person.fullName || 'you'}` });
  s.push({ id: 'ready', label: `Getting ${botName || 'your coworker'} ready${admin ? '' : ' for you'}` });
  return s.map((x) => ({ ...x, state: 'waiting' }));
}

export function jobOf(slug) { return jobs.get(slug) || null; }

/**
 * Start (or return the running) research for one person. `admin`: also reads the
 * company's website, once. `checkClaude`: resolves when the model can be reached.
 * `hooks` (tests): replace the site reader and the drafts.
 */
export function startResearch({ slug, admin, botName, checkClaude = async () => {}, hooks = {} }) {
  const running = jobs.get(slug);
  if (running && !running.done) return running;
  const company = readCompany();
  const person = readPerson(slug) || {};
  const job = { stages: stagesFor({ admin, company, person, botName }), done: false, error: null, startedAt: Date.now() };
  jobs.set(slug, job);
  const set = (id, state) => { const st = job.stages.find((x) => x.id === id); if (st) st.state = state; };
  const read = hooks.readSite || testHooks.readSite || readSite;
  const draft = hooks.draftCompany || testHooks.draftCompany || draftCompany;
  const lookup = hooks.lookupPerson || testHooks.lookupPerson || lookupPerson;
  const lookupCo = hooks.lookupCompany || testHooks.lookupCompany || lookupCompany;

  (async () => {
    try {
      const first = job.stages[0].id;
      set(first, 'running');
      if (first === 'claude') await checkClaude();
      set(first, 'done');

      if (admin && company?.name) {
        // The web first: search results describe a company even when its own site is
        // an empty app shell, and they can name the site when none was given.
        set('web', 'running');
        let web = { website: null, facts: [] };
        try { web = await lookupCo({ name: company.name, sentence: company.sentence, site: company.site, person }); } catch { /* nothing found is an answer too */ }
        set('web', 'done');
        let siteUrl = company.site;
        if (!siteUrl && web.website) {
          siteUrl = web.website;
          writeCompany({ site: siteUrl, siteFound: true });
          job.stages.splice(job.stages.findIndex((x) => x.id === 'web') + 1, 0,
            { id: 'site', label: `Reading ${new URL(siteUrl).hostname.replace(/^www\./, '')}`, state: 'waiting' });
        }
        let found = { facts: [], tools: [], favicon: null, pages: 0 };
        if (siteUrl) {
          set('site', 'running');
          try {
            const site = await read(siteUrl);
            const facts = await draft({ name: company.name, sentence: company.sentence, pages: site.pages }).catch(() => []);
            found = { facts, tools: site.tools, favicon: site.favicon ? `data:${site.favicon.type};base64,${site.favicon.data}` : null, pages: site.pages.length };
          } catch { /* a site that can't be read gives no findings, not a failed setup */ }
          set('site', 'done');
        }
        // The site's own lines first, then the web's; no repeats; capped.
        const seen = new Set(found.facts.map((f) => f.text.toLowerCase()));
        const merged = [...found.facts, ...web.facts.filter((f) => !seen.has(f.text.toLowerCase()))].slice(0, MAX_COMPANY_FACTS);
        writeCompany({ findings: { ...found, facts: merged, readAt: new Date().toISOString() } });
      }

      if (job.stages.some((x) => x.id === 'lookup')) {
        set('lookup', 'running');
        let facts = [];
        // Once per person: a second run keeps what the first found, so the
        // look-up can't be pointed at one name after another.
        const prev = readPerson(slug)?.lookedUp;
        if (prev) facts = prev.facts || [];
        else {
          try {
            facts = await lookup({ fullName: person.fullName, role: person.role, help: person.help, company: company?.name, site: company?.site });
          } catch { /* nothing found is an answer too */ }
          writePerson(slug, { lookedUp: { name: person.fullName, facts, at: new Date().toISOString() } });
        }
        writePerson(slug, { findings: { facts, readAt: new Date().toISOString() } });
        set('lookup', 'done');
      }

      set('ready', 'running');
      set('ready', 'done');
    } catch (err) {
      job.error = err.message;
      for (const st of job.stages) if (st.state !== 'done') st.state = 'failed';
    } finally {
      job.done = true;
    }
  })();
  return job;
}

/** What a person has to confirm: the company's findings (admin) and their own. */
export function findingsFor(slug, { admin }) {
  const company = readCompany();
  const person = readPerson(slug) || {};
  const out = {};
  if (admin && company?.findings && (company.findings.facts?.length || company.findings.tools?.length)) {
    out.company = { name: company.name, site: company.site, facts: company.findings.facts || [], tools: company.findings.tools || [], favicon: company.findings.favicon || null };
  }
  if (person.findings?.facts?.length) out.person = { facts: person.findings.facts };
  return out;
}

export function _resetJobs() { jobs.clear(); }
