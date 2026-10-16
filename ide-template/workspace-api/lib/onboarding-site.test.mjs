/**
 * Reading a company's website for onboarding, against a fake site served from
 * memory: which addresses count as a website, which pages get read, that a
 * redirect never leaves the site, the limits, the tools the HTML gives away and
 * the favicon. Run: node lib/onboarding-site.test.mjs
 */
import { normalizeSite, readSite, pageText, worthLinks, LIMITS } from './onboarding/site.js';
import { detectTools } from './onboarding/signatures.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

// ─── what counts as a website ────────────────────────────────────────────────
ok('a bare domain becomes its https home page', normalizeSite('Fieldcraft.co') === 'https://fieldcraft.co/');
ok('a full address keeps its scheme and drops the path', normalizeSite('http://www.fieldcraft.co/about?x=1') === 'http://www.fieldcraft.co/');
for (const bad of ['localhost', 'http://127.0.0.1', '10.0.0.5', 'http://[::1]/', 'intranet', 'files.corp', 'egress-proxy:3130', 'ftp://fieldcraft.co', 'https://user:pw@fieldcraft.co', 'https://fieldcraft.co:8443', 'javascript:alert(1)', ''])
  ok(`not a website: ${JSON.stringify(bad)}`, normalizeSite(bad) === null, normalizeSite(bad));

// ─── a fake site ─────────────────────────────────────────────────────────────
const page = (body, head = '') => `<html><head><title>Fieldcraft</title>${head}</head><body>${body}</body></html>`;
const SITE = {
  'https://fieldcraft.co/': { html: page(`
      <nav><a href="/about">About us</a> <a href="/collections/tents">Shop</a> <a href="/wholesale">Wholesale</a>
      <a href="/blog/2024/new-tent">Blog</a> <a href="https://elsewhere.example/about">Partner</a> <a href="/brochure.pdf">Brochure</a>
      <a href="/kontakt">Kontakt</a> <a href="/pricing">Prices</a></nav>
      <h1>Outdoor gear</h1><p>Tents, packs &amp; cookware.</p>
      <script>var secret = "never in the text";</script>
      <script src="https://cdn.shopify.com/s/files/theme.js"></script>
      <form action="https://fieldcraft.us21.list-manage.com/subscribe/post"></form>`,
      '<meta name="description" content="Gear for hikers"><link rel="icon" href="https://cdn.shopify.com/fav.png">') },
  'https://fieldcraft.co/about': { html: page('<p>Six people, founded by Mara and Jonas.</p>') },
  'https://fieldcraft.co/collections/tents': { html: page('<p>Tents</p>') },
  'https://fieldcraft.co/wholesale': { html: page('<p>Clubs book a call: <a href="https://calendly.com/fieldcraft/wholesale">book</a></p>') },
  'https://fieldcraft.co/kontakt': { redirect: 'https://evil.example/steal' },
  'https://fieldcraft.co/pricing': { redirect: '/prices' },
  'https://fieldcraft.co/prices': { html: page('<p>Free shipping from 50 EUR</p>') },
  'https://cdn.shopify.com/fav.png': { body: Buffer.from([0x89, 0x50, 0x4e, 0x47]), type: 'image/png' },
};
const fetched = [];
const fakeFetch = async (url) => {
  fetched.push(url);
  const hit = SITE[url];
  const headers = new Map();
  const mk = (status, body = '', type = 'text/html; charset=utf-8', location) => ({
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? location : k.toLowerCase() === 'content-type' ? type : headers.get(k)) },
    body: { getReader() { let done = false; return { read: async () => (done ? { done: true } : (done = true, { done: false, value: new Uint8Array(Buffer.isBuffer(body) ? body : Buffer.from(body)) })), cancel: async () => {} }; } },
  });
  if (!hit) return mk(404);
  if (hit.redirect) return mk(302, '', 'text/html', hit.redirect);
  if (hit.body) return mk(200, hit.body, hit.type);
  return mk(200, hit.html);
};

const r = await readSite('fieldcraft.co', { fetchImpl: fakeFetch });
ok('the home page is read first', r.pages[0]?.url === 'https://fieldcraft.co/', r.pages.map((p) => p.url));
ok('at most five pages', r.pages.length <= LIMITS.pages, r.pages.length);
ok('pages that say what the company is are read', ['https://fieldcraft.co/about', 'https://fieldcraft.co/wholesale'].every((u) => r.pages.some((p) => p.url === u)), r.pages.map((p) => p.url));
ok('a redirect within the site is followed', r.pages.some((p) => p.url === 'https://fieldcraft.co/prices'), r.pages.map((p) => p.url));
ok('a redirect off the site is not', !fetched.includes('https://evil.example/steal'), fetched);
ok('another site\'s link is never fetched', !fetched.includes('https://elsewhere.example/about'), fetched);
ok('files are not pages', !fetched.some((u) => u.endsWith('.pdf')), fetched);
ok('the deep blog post is not picked over shallow pages', !fetched.includes('https://fieldcraft.co/blog/2024/new-tent'), fetched);
ok('scripts never reach the text', !r.pages.some((p) => p.text.includes('never in the text')));
ok('entities are decoded', r.pages[0].text.includes('Tents, packs & cookware.'), r.pages[0].text);
ok('title and description are kept', r.pages[0].title === 'Fieldcraft' && r.pages[0].description === 'Gear for hikers', r.pages[0]);
ok('tools from every page, once each', ['shopify', 'mailchimp', 'calendly'].every((id) => r.tools.some((t) => t.id === id)) && new Set(r.tools.map((t) => t.id)).size === r.tools.length, r.tools);
ok('the favicon comes along, even from a CDN', r.favicon?.type === 'image/png' && r.favicon.data === Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), r.favicon);

// ─── limits and failures ─────────────────────────────────────────────────────
const big = 'word '.repeat(5000);
const pt = pageText(`<p>${big}</p>`);
ok('(setup) a long page', pt.text.length > LIMITS.textPerPage);
const many = Object.fromEntries(['', 'about', 'team', 'products', 'services', 'contact', 'pricing'].map((p) => [`https://long.example/${p}`, { html: `<a href="/about">a</a><a href="/team">t</a><a href="/products">p</a><a href="/services">s</a><a href="/contact">c</a><a href="/pricing">pr</a><p>Page ${p || 'home'}. ${big}</p>` }]));
const r2 = await readSite('long.example', { fetchImpl: async (url) => fakeFetchFor(many)(url) });
ok('text is capped per page and in total', r2.pages.every((p) => p.text.length <= LIMITS.textPerPage) && r2.pages.reduce((n, p) => n + p.text.length, 0) <= LIMITS.textTotal, r2.pages.map((p) => p.text.length));
ok('still five pages at most', r2.pages.length === LIMITS.pages, r2.pages.length);
const r3 = await readSite('down.example', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
ok('a site that does not answer gives no pages, no error', r3.site === 'https://down.example/' && r3.pages.length === 0 && r3.tools.length === 0);
const r4 = await readSite('localhost', { fetchImpl: async () => { throw new Error('must not be called'); } });
ok('not a website: nothing is fetched', r4.site === null && r4.pages.length === 0);
const r5 = await readSite('pdf.example', { fetchImpl: async () => ({ status: 200, ok: true, headers: { get: (k) => (k === 'content-type' ? 'application/pdf' : null) }, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) } }) });
ok('a home page that is not HTML gives no pages', r5.pages.length === 0);

// ─── a site whose menu is built in the browser ───────────────────────────────
const spaHome = '<html><head><title>App</title></head><body><div id="root"></div><p>We build decision tools.</p></body></html>';
const SPA = {
  'https://spa.example/': spaHome,
  'https://spa.example/sitemap.xml': '<urlset><url><loc>https://spa.example/company</loc></url><url><loc>https://spa.example/blog/a/b/c</loc></url><url><loc>https://other.example/about</loc></url></urlset>',
  'https://spa.example/company': '<html><body><p>Founded in 2021 in Krakow.</p></body></html>',
  'https://spa.example/o-nas': '<html><body><p>Zespol pieciu osob.</p></body></html>',
};
const spaFetched = [];
const r6 = await readSite('spa.example', { fetchImpl: async (url) => {
  spaFetched.push(url);
  // Like a real single-page app: every unknown address answers 200 with the home page.
  const body = Buffer.from(SPA[url] ?? spaHome);
  const type = url.endsWith('.xml') ? 'application/xml' : 'text/html';
  return { status: 200, ok: true, headers: { get: (k) => (k === 'content-type' ? type : null) },
    body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : (d = true, { done: false, value: new Uint8Array(body) })), cancel: async () => {} }; } } };
} });
ok('no links: the sitemap\'s pages are read', r6.pages.some((p) => p.url === 'https://spa.example/company'), r6.pages.map((p) => p.url));
ok('...and the usual addresses are tried', r6.pages.some((p) => p.url === 'https://spa.example/o-nas'), r6.pages.map((p) => p.url));
ok('...a sitemap entry on another site is not', !spaFetched.includes('https://other.example/about'), spaFetched);
ok('the app answering every address with its home page adds no copies', r6.pages.filter((p) => p.text === r6.pages[0].text).length === 1, r6.pages.map((p) => p.url));
ok('still five pages at most, and a bounded number of tries', r6.pages.length <= LIMITS.pages && spaFetched.length <= 2 + LIMITS.pages * 2 + 2, spaFetched.length);

// ─── links and signatures in isolation ───────────────────────────────────────
const links = worthLinks('<a href="/o-nas">O nas</a><a href="/x">Our story</a><a href="/careers">Jobs</a><a href="#top">Top</a>', 'https://firma.example/');
ok('links are chosen by address or by their text', links.includes('https://firma.example/o-nas') && links.includes('https://firma.example/x') && !links.includes('https://firma.example/careers'), links);
ok('no signatures in plain text', detectTools('<p>We love shopify and calendly</p>').length === 0);
ok('a Meta pixel is read as Meta Ads', detectTools("<script>fbq('init', '123')</script>").some((t) => t.id === 'meta-ads'));
ok('GA4 and Google Ads are told apart', (() => { const t = detectTools("gtag('config', 'G-ABC123'); gtag('config','AW-999')").map((x) => x.id); return t.includes('ga4') && t.includes('google-ads'); })());

function fakeFetchFor(map) {
  return async (url) => {
    const hit = map[url];
    const body = hit ? Buffer.from(hit.html) : Buffer.alloc(0);
    return { status: hit ? 200 : 404, ok: !!hit, headers: { get: (k) => (k === 'content-type' ? 'text/html' : null) },
      body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : (d = true, { done: false, value: new Uint8Array(body) })), cancel: async () => {} }; } } };
  };
}

console.log(`onboarding-site: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
