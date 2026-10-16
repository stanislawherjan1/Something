/**
 * Tools a website shows it uses, read from its HTML in code (no model): each
 * signature names a catalog integration id and what on the page gave it away.
 * Only ids that exist in integrations.catalog.json belong here — the starter
 * plan offers what the catalog has, nothing else.
 */

const SIGNATURES = [
  { id: 'shopify',     seen: 'The store runs on it',      re: /cdn\.shopify\.com|\.myshopify\.com|Shopify\.theme/i },
  { id: 'wix',         seen: 'The site is built on it',    re: /static\.wixstatic\.com|static\.parastorage\.com/i },
  { id: 'webflow',     seen: 'The site is built on it',    re: /data-wf-site=|assets\.website-files\.com|webflow\.com\/css/i },
  { id: 'stripe',      seen: 'Payments on the site',       re: /js\.stripe\.com|buy\.stripe\.com|checkout\.stripe\.com/i },
  { id: 'paypal',      seen: 'Payments on the site',       re: /paypal\.com\/sdk\/js|paypalobjects\.com/i },
  { id: 'mailchimp',   seen: 'Newsletter form',            re: /list-manage\.com|chimpstatic\.com|mc\.us\d+\.list-manage/i },
  { id: 'klaviyo',     seen: 'Newsletter and email flows', re: /static\.klaviyo\.com|klaviyo\.com\/onsite/i },
  { id: 'calendly',    seen: 'Meetings booked through it', re: /calendly\.com\/[a-z0-9_-]+/i },
  { id: 'calcom',      seen: 'Meetings booked through it', re: /(?:^|["'\s/])cal\.com\/[a-z0-9_-]+/i },
  { id: 'tally',       seen: 'Forms on the site',          re: /tally\.so\/(?:r|embed)\//i },
  { id: 'ga4',         seen: 'Visitor analytics',          re: /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i },
  { id: 'google-ads',  seen: 'Ads conversion tracking',    re: /googleadservices\.com|gtag\(\s*['"]config['"]\s*,\s*['"]AW-/i },
  { id: 'meta-ads',    seen: 'Meta pixel on the site',     re: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(\s*['"]init['"]/i },
  { id: 'notion',      seen: 'Pages published from it',    re: /\.notion\.site\b/i },
];

/** The catalog ids a page's HTML gives away, each once, with what gave it away. */
export function detectTools(html) {
  if (typeof html !== 'string' || !html) return [];
  const out = [];
  for (const s of SIGNATURES) if (s.re.test(html)) out.push({ id: s.id, seen: s.seen });
  return out;
}

/** Merge the tools found on several pages: first sighting wins, no duplicates. */
export function mergeTools(lists) {
  const seen = new Map();
  for (const list of lists) for (const t of list || []) if (!seen.has(t.id)) seen.set(t.id, t);
  return [...seen.values()];
}

export const SIGNATURE_IDS = SIGNATURES.map((s) => s.id);
