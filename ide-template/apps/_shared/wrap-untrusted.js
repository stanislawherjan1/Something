/**
 * wrap-untrusted — prepend the `<untrusted-content>` spotlight delimiter
 * around any text that arrived from outside the user's direct input.
 *
 * Rationale: the bot's system prompt + `security` skill tell the agent to
 * treat anything wrapped in these tags as data, never as instructions. The
 * wrapper is the load-bearing convention that makes that rule actionable —
 * without it, prompt-injection attempts embedded in emails / PDFs / web
 * pages are indistinguishable from genuine user requests.
 *
 * Coverage today (v1): email-mcp (IMAP body returns). Future entry points
 * (PDF extractors, URL fetch endpoints, drag-in file content extraction)
 * should call `wrapUntrusted()` at the moment they hand text to the agent.
 *
 * Pure function, no IO. Idempotent at the call site — call it once per
 * chunk; nested wraps are not unwrapped and would confuse the rule.
 */

/**
 * Escape attribute values so an embedded `"` or `<` in the source-id /
 * timestamp can't break out of the tag. Mirrors Jan's escapeAttr in
 * absorb-pipeline.js — keep behaviourally identical.
 */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Wrap `text` in `<untrusted-content source="..." absorbed_at="...">…
 * </untrusted-content>`.
 *
 * @param {string} text     The untrusted content. Plain string; any
 *                          embedded `</untrusted-content>` is escaped to
 *                          prevent early termination.
 * @param {object} opts
 * @param {string} opts.source        Short identifier for the origin,
 *                                    e.g. `email:<message-id>`,
 *                                    `url:https://...`, `pdf:report.pdf`.
 * @param {string} [opts.absorbedAt]  ISO timestamp; defaults to now.
 * @returns {string}
 */
export function wrapUntrusted(text, { source, absorbedAt } = {}) {
  const ts = absorbedAt || new Date().toISOString();
  const src = source || 'unknown';
  // Defensive: an attacker-controlled chunk could contain a literal
  // `</untrusted-content>` to escape the wrap. Replace the close-tag
  // marker so the agent always sees a single, well-formed envelope.
  const safe = String(text == null ? '' : text)
    .replace(/<\/untrusted-content>/gi, '<\\/untrusted-content>');
  return `<untrusted-content source="${escapeAttr(src)}" absorbed_at="${escapeAttr(ts)}">\n${safe}\n</untrusted-content>`;
}
