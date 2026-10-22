/**
 * The room a reminder may be aimed at, as the group registry keys it: a
 * Telegram group's chat id (a negative number) or a Slack channel's
 * `slack-C…` — a bare `C…` as Slack shows it is taken too. Anything else is
 * no room (the reminder then goes to a person). The registry, not this, is
 * what authorises the send when it fires.
 */
export function roomTarget(value) {
  const v = String(value == null ? '' : value).trim();
  if (/^-?\d{4,20}$/.test(v)) return v;
  const m = v.match(/^(?:slack-)?([CG][A-Z0-9]{5,20})$/i);
  return m ? `slack-${m[1].toUpperCase()}` : null;
}

/**
 * The one registered room the words name, or null: a Slack channel by its
 * `#name` (as the registry titles it), a Telegram group by its whole title,
 * case-insensitively. Names are data from the registry, in whatever language
 * the team writes them — no word of any language is matched here. Two rooms
 * named, or none: null (the reminder then goes where its `chat` says, or to
 * a person).
 */
export function roomNamedIn(text, rooms = []) {
  const hay = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ')} `;
  const hits = [];
  for (const r of rooms) {
    const title = String(r?.title || '').trim().toLowerCase();
    if (!title || !r?.chatId) continue;
    const esc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // A channel's "#name" stands on its own; a group's title is a whole phrase.
    const re = title.startsWith('#') ? new RegExp(`(^|[^\\w#])${esc}(?![\\w-])`) : new RegExp(`(^|[^\\w])${esc}(?![\\w])`);
    if (re.test(hay)) hits.push(r);
  }
  return hits.length === 1 ? hits[0] : null;
}
