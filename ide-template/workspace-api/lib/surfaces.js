/**
 * Where a person can be reached — the surfaces a roster entry may prefer.
 *
 * The roster used to hold one word, `preferredSurface: web | telegram | both`,
 * and every consumer compared it to 'telegram' or 'both' by hand. A third
 * surface does not fit in that word, so the preference is a SET of surfaces
 * (`['web', 'telegram']`). The old word is still read from disk and still
 * offered to the API and the UI (`legacySurface`), so nothing that speaks the
 * old shape breaks; the set is the truth.
 */

export const SURFACES = ['web', 'telegram', 'slack'];
const KNOWN = new Set(SURFACES);

/**
 * The stored value (a legacy word or an array of surface names) as a sorted,
 * deduplicated array in SURFACES order — or null when it is unset, empty, or
 * not something we recognise. Never throws: a roster read must not fail on
 * one odd entry.
 */
export function normalizeSurfaces(v) {
  if (v === undefined || v === null || v === '') return null;
  let names;
  if (Array.isArray(v)) names = v;
  else if (typeof v === 'string') names = v.trim().toLowerCase() === 'both' ? ['web', 'telegram'] : v.split(',');
  else return null;
  const set = new Set(names.map(s => String(s).trim().toLowerCase()).filter(Boolean));
  if (!set.size || [...set].some(s => !KNOWN.has(s))) return null;
  return SURFACES.filter(s => set.has(s));
}

/**
 * A value typed in by a person or sent by a client, checked strictly: a
 * recognised word or array → the set; '' or null → null (cleared); anything
 * else throws with a message fit for a 400.
 */
export function parseSurfaces(v) {
  if (v === undefined || v === null || v === '') return null;
  const out = normalizeSurfaces(v);
  if (!out) throw new Error(`Preferred surface must be one or more of ${SURFACES.join(', ')} (or "both" for web and Telegram).`);
  return out;
}

/** Does this person want to be reached on `surface`? Unset = no preference stated. */
export function prefers(member, surface) {
  const set = normalizeSurfaces(member?.surfaces ?? member?.preferredSurface);
  return !!set && set.includes(surface);
}

/**
 * The set as the one word the API offered before: 'both' when web and
 * Telegram are both in, else 'web' / 'telegram', else null. A surface the old
 * word cannot name is simply not in it — the `surfaces` array next to it is.
 */
export function legacySurface(v) {
  const set = normalizeSurfaces(v);
  if (!set) return null;
  const web = set.includes('web'), tg = set.includes('telegram');
  if (web && tg) return 'both';
  if (tg) return 'telegram';
  if (web) return 'web';
  return null;
}

/** For a roster card: "prefers web and Slack". */
export function describeSurfaces(v) {
  const set = normalizeSurfaces(v);
  if (!set) return null;
  const label = { web: 'web', telegram: 'Telegram', slack: 'Slack' };
  return set.map(s => label[s]).join(' and ');
}
