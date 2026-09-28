/**
 * Hand-off from an Act turn to the integrations.
 *
 * An Act turn reads the user's tab, and a page can carry injected instructions,
 * so that turn holds only the tab tools and read-only workspace access (see
 * runClaudeTurn's actTurn). When the task is better done through an API — an
 * event on a calendar tab, a board on a Miro tab, an email — it calls
 * use_integrations, and workspace-api runs a SECOND turn from here:
 *
 *   - its request is the user's own message, as workspace-api stored it when the
 *     panel turn started — never text from the model that read the page;
 *   - it gets the tab's address and title as the panel reported them, the chat's
 *     dialogue (user and assistant text, never tool results) and the full
 *     toolbox minus the tools that deliver messages (its reply is relayed);
 *   - it gets no tab token and no Act flag, so it cannot see or operate the page
 *     and cannot hand off again, and it never resumes the panel's session, whose
 *     transcript holds page content.
 *
 * So the model that saw the page decides only WHETHER to hand off; what is done
 * comes from the user.
 */

// Tools that put a message in front of a person: the hand-off's reply is
// relayed through the panel turn, so there is exactly one delivery path.
export const HANDOFF_DENIED_TOOLS = [
  'mcp__web_channel__web_send_message',
  'mcp__plugin_telegram_telegram__sendMessage',
  'mcp__plugin_telegram_telegram__reply',
  'mcp__workspace-api__fix_sent_message',
];

export const HANDOFF_TIMEOUT_MS = 120_000;

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, n);

/**
 * The hand-off turn's prompt. `history` is the chat's replay (buildResumeContext
 * output) or null; a trailing copy of the request is dropped from it, since the
 * request follows on its own.
 */
export function buildHandoffMessage({ request, url, title, history }) {
  const req = String(request || '').trim();
  const lines = [
    '[Hand-off from the browser panel. The user is looking at the tab below and asked for the request at the end. '
    + 'Do it through your tools and integrations: the item it is about is usually identified in the address. '
    + 'You cannot see or operate the page itself. If the request needs something only the page shows, or you cannot tell '
    + 'which item is meant, say so plainly instead of guessing. Before anything with consequences for other people or money '
    + '(sending, paying, deleting, publishing), say what you would do and ask, unless the request already asks for exactly that. '
    + 'Answer briefly: what you did, or what you need.]',
    `Tab: ${title ? `"${clip(title, 300)}" — ` : ''}${clip(url, 2000)}`,
  ];
  let past = typeof history === 'string' ? history.trim() : '';
  const tail = `user: ${req}`;
  if (past.endsWith(tail)) past = past.slice(0, -tail.length).trim();
  if (past) lines.push('', '[Earlier in this chat:]', past);
  lines.push('', '---', '[The user\'s request:]', req);
  return lines.join('\n');
}

/**
 * Run one hand-off. `runTurn` is runClaudeTurn (injected for tests); `turn` is
 * the panel turn's record from routes/tab.js. Resolves { ok, reply } or
 * { ok: false, error }; never rejects. Returns { done, kill }.
 */
export function runHandoff({ runTurn, turn, timeoutMs = HANDOFF_TIMEOUT_MS }) {
  let proc = null;
  let settle;
  const done = new Promise((resolve) => { settle = resolve; });
  let finished = false;
  const finish = (result) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    settle(result);
  };
  const emit = (event, data) => { try { turn.onEvent?.(event, data); } catch { /* the chat went away */ } };
  let reply = '';
  const timer = setTimeout(() => {
    try { proc?.kill?.('SIGTERM'); } catch { /* gone */ }
    finish({ ok: false, error: `The hand-off took longer than ${Math.round(timeoutMs / 1000)} s and was stopped.` });
  }, timeoutMs);

  try {
    proc = runTurn({
      message: buildHandoffMessage({ request: turn.message, url: turn.url, title: turn.title, history: turn.history?.() }),
      actor: turn.actor,
      actorName: turn.actorName,
      actorIsAdmin: turn.actorIsAdmin,
      teammates: turn.teammates,
      disallowedTools: HANDOFF_DENIED_TOOLS,
      onText: (t) => { reply += t; },
      onToolStart: (info) => emit('tool_start', info),
      onToolEnd: (info) => emit('tool_end', info),
      onImage: (img) => emit('image', img),
      onError: (msg) => finish({ ok: false, error: String(msg || 'The hand-off failed.').slice(0, 400) }),
      onDone: () => finish({ ok: true, reply: reply.trim() }),
    });
  } catch (err) {
    finish({ ok: false, error: `The hand-off could not start (${err.message}).` });
  }
  return { done, kill: () => { try { proc?.kill?.('SIGTERM'); } catch { /* gone */ } finish({ ok: false, error: 'The hand-off was stopped.' }); } };
}
