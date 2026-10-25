/**
 * A registered group's id — the one string that names a group in
 * `.team-config.json` (`groups`), `.group-watcher/<id>-history.jsonl`,
 * `memory/groups/<id>/` and the `group:<id>` memory scope.
 *
 * A Telegram group is its bare negative chat id (supergroups are -100…), kept
 * as is so nothing on disk moves. A surface added later namespaces its own
 * ids (`slack-C0123ABCD`), so one helper decides what is a group id and the
 * file paths the id lands in stay safe — the same check used to live as six
 * copies of one regex.
 */

const TELEGRAM_RE = /^-\d{4,20}$/;
const SLACK_RE    = /^slack-[A-Z][A-Z0-9]{5,20}$/;   // a Slack conversation id (C…, G…) behind a fixed prefix

/** 'telegram' | 'slack' for a group id, null for anything else. */
export function groupIdKind(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (TELEGRAM_RE.test(s)) return 'telegram';
  if (SLACK_RE.test(s)) return 'slack';
  return null;
}

export function isGroupId(v) {
  return groupIdKind(v) !== null;
}

/** The canonical id string, or null when the value is not a group id. */
export function normalizeGroupId(v) {
  return isGroupId(v) ? String(v).trim() : null;
}
