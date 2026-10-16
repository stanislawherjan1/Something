/**
 * Reads a company's own website for onboarding: the home page and up to four of
 * its own pages that say what the company is (about, products, pricing, contact,
 * wholesale…), as plain text, plus the tools its HTML gives away and its favicon.
 *
 * Everything goes out through the egress listener (egress-proxy:3130 — public
 * addresses on 80/443 only), and the host is checked here as well: a website is a
 * public hostname, never an IP, localhost or an internal name. Pages are data:
 * nothing read here is ever followed as an instruction.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { detectTools, mergeTools } from './signatures.js';

const PROXY_URL = process.env.ONBOARDING_PROXY_URL ?? process.env.MCP_OAUTH_PROXY_URL ?? 'http://egress-proxy:3130';
const dispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;

export const LIMITS = {
  pages: 5,                 // the home page and four more
  bytesPerPage: 512 * 1024, // what is read of one response
  textPerPage: 6000,        // characters kept per page
  textTotal: 20000,         // characters kept across all pages
  timeoutMs: 10_000,
  redirects: 3,
  faviconBytes: 64 * 1024,
};

// Words in a link's address or text that point at a page worth reading. Several
// languages, because the sites are; this only picks pages, it judges nothing.
const WORTH = /about|team|company|story|who-we-are|o-nas|o-firmie|ueber-uns|uber-uns|qui-sommes|chi-siamo|sobre|products?|produkt|shop|store|sklep|services?|uslugi|leistungen|pricing|prices?|cennik|preise|tarifs|contact|kontakt|wholesale|hurt|b2b|partners?/i;

/** "Fieldcraft.co", "https://fieldcraft.co/about" → https://fieldcraft.co/ ; null when it isn't a public website. */
export function normalizeSite(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 300) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!isPublicHostname(host)) return null;
  return `${u.protocol}//${host}/`;
}

export function isPublicHostname(host) {
  if (!host || !host.includes('.')) return false;                  // localhost, internal names
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':')) return false; // IPv4 / IPv6 literals
  if (/\.(local|internal|localhost|lan|home|corp|intranet)$/.test(host)) return false;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host);
}

// Same site: the same host, or it with/without "www.".
function sameSite(a, b) {
  const strip = (h) => h.replace(/^www\./, '');
  return strip(a) === strip(b);
}

async function readCapped(res, cap) {
  const reader = res.body?.getReader?.();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { chunks.push(Buffer.from(value).subarray(0, cap - (size - value.byteLength))); await reader.cancel().catch(() => {}); break; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** GET one URL of the site; redirects followed by hand and only within the site. */
async function get(url, origin, fetchImpl, { accept = 'text/html', cap = LIMITS.bytesPerPage } = {}) {
  let current = url;
  for (let hop = 0; hop <= LIMITS.redirects; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LIMITS.timeoutMs);
    try {
      const res = await fetchImpl(current, {
        redirect: 'manual', signal: ctrl.signal, dispatcher,
        headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; workspace-onboarding/1.0)' },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) return null;
        const next = new URL(loc, current);
        if (!/^https?:$/.test(next.protocol) || !sameSite(next.hostname, new URL(origin).hostname)) return null;
        current = next.toString();
        continue;
      }
      if (!res.ok) return null;
      const type = res.headers.get('content-type') || '';
      if (accept === 'text/html' && !/text\/html|application\/xhtml/i.test(type)) return null;
      return { url: current, type, body: await readCapped(res, cap) };
    } catch { return null; }
    finally { clearTimeout(timer); }
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The page as readable text, with its title and description first. */
export function pageText(html) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
  const desc = decode(html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1]
    || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] || '').trim();
  const body = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|section|article|header|footer|tr|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decode(body).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  return { title, description: desc, text };
}

/** Links on the page that stay on the site and look worth reading, best first. */
export function worthLinks(html, base) {
  const origin = new URL(base);
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let u; try { u = new URL(decode(m[1]), base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !sameSite(u.hostname, origin.hostname)) continue;
    if (/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3)$/i.test(u.pathname)) continue;
    u.hash = ''; u.search = '';
    const key = u.toString();
    if (key === origin.toString() || out.has(key)) continue;
    const label = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (WORTH.test(u.pathname) || WORTH.test(label)) out.set(key, u.pathname.split('/').filter(Boolean).length);
  }
  // Shallow pages first ("/about" before "/blog/2024/about-our-new-tent").
  return [...out.entries()].sort((a, b) => a[1] - b[1]).map(([u]) => u);
}

/** Where the page says its icon is; /favicon.ico otherwise. */
export function faviconHref(html, base) {
  const m = html.match(/<link\b[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/i)?.[0]
    || html.match(/<link\b[^>]*rel=["']apple-touch-icon["'][^>]*>/i)?.[0];
  const href = m?.match(/href=["']([^"']+)["']/i)?.[1];
  try { return new URL(href ? decode(href) : '/favicon.ico', base).toString(); } catch { return null; }
}


// The usual addresses of the pages that say what a company is, in a few languages.
const GUESSES = ['/about', '/about-us', '/o-nas', '/o-firmie', '/company', '/team', '/contact', '/kontakt', '/oferta', '/uslugi', '/services', '/pricing', '/cennik'];

/** Pages the sitemap lists that look worth reading, shallow first. */
async function sitemapLinks(base, site, fetchImpl) {
  const res = await get(new URL('/sitemap.xml', base).toString(), site, fetchImpl, { accept: 'application/xml', cap: 256 * 1024 });
  if (!res) return [];
  const xml = res.body.toString('utf8');
  const origin = new URL(base);
  const urls = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1])
    .filter((u) => { try { const x = new URL(u); return sameSite(x.hostname, origin.hostname) && WORTH.test(x.pathname); } catch { return false; } });
  return urls.sort((a, b) => new URL(a).pathname.split('/').length - new URL(b).pathname.split('/').length).slice(0, 8);
}

/**
 * Read a site. Returns { site, pages: [{ url, title, description, text }], tools,
 * favicon: { url, type, data } | null } — or { site: null } when the address is not
 * a public website, and pages: [] when nothing could be read.
 */
export async function readSite(input, { fetchImpl = undiciFetch } = {}) {
  const site = normalizeSite(input);
  if (!site) return { site: null, pages: [], tools: [], favicon: null };
  const home = await get(site, site, fetchImpl);
  if (!home) return { site, pages: [], tools: [], favicon: null };
  const homeHtml = home.body.toString('utf8');
  const pages = [{ url: home.url, ...pageText(homeHtml) }];
  const tools = [detectTools(homeHtml)];
  let links = worthLinks(homeHtml, home.url);
  // A site whose menu is built in the browser shows no links in its HTML: try its
  // sitemap, then the usual addresses for "about" and "contact".
  if (links.length < 2) links = [...links, ...(await sitemapLinks(home.url, site, fetchImpl)), ...GUESSES.map((p) => new URL(p, home.url).toString())];
  links = [...new Set(links)].filter((u) => u !== home.url);
  let tries = 0;
  for (const link of links) {
    if (pages.length >= LIMITS.pages || tries++ >= LIMITS.pages * 2) break;
    const page = await get(link, site, fetchImpl);
    if (!page || pages.some((p) => p.url === page.url)) continue;
    const html = page.body.toString('utf8');
    const read = pageText(html);
    // A single-page app answers every address with its home page: not a page of its own.
    if (read.text === pages[0].text) continue;
    pages.push({ url: page.url, ...read });
    tools.push(detectTools(html));
  }
  // Keep the text within bounds: each page capped, then the total.
  let budget = LIMITS.textTotal;
  for (const p of pages) {
    p.text = p.text.slice(0, Math.min(LIMITS.textPerPage, Math.max(0, budget)));
    budget -= p.text.length;
  }
  let favicon = null;
  const iconUrl = faviconHref(homeHtml, home.url);
  // The icon may live on a CDN (cdn.shopify.com…): any public host, image only, small.
  if (iconUrl && isPublicHostname(new URL(iconUrl).hostname)) {
    const icon = await get(iconUrl, iconUrl, fetchImpl, { accept: 'image/*', cap: LIMITS.faviconBytes });
    if (icon && /^image\//i.test(icon.type) && icon.body.length) favicon = { url: icon.url, type: icon.type.split(';')[0], data: icon.body.toString('base64') };
  }
  return { site, pages, tools: mergeTools(tools), favicon };
}
