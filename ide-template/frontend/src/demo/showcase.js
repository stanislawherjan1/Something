// The landing page's replay: one conversation played through the real app.
// ?showcase=<id> loads the demo at the conversation's page (the board, the
// team, nothing open), the real composer gets the question typed into it and
// sent, and the in-browser server answers with the turn below as server-sent
// events, as workspace-api does: the steps (tool_start / tool_end with real
// tool names, so the chat shows them the way it shows any turn) and the reply
// in markdown. When the reply is done the page tells its parent, which moves
// on to the next conversation. Demo build only.

import { SHOWCASE } from './flags.js';

// Each turn: where the app opens, the question, the steps (groups of real tool
// names), what is said between groups, the reply, and where the app goes when
// it's written (the file it just wrote).
export const SCRIPTS = {
  founder: {
    route: '/tasks',
    ask: 'What needs me today?',
    steps: [['mcp__gcalendar__list_events', 'mcp__email__search_emails', 'mcp__tasks__list_tasks', 'mcp__reminders__list_reminders']],
    reply: 'Three things need you today:\n\n1. **Sign off the new pricing page.** Mara’s newsletter review is waiting on it.\n2. **Decide on the shipping rule.** Since orders under €50 lost free shipping, checkouts dropped; rolling it back is on your board.\n3. **The 10:00 investor call.** Your notes are in investor-prep.md.\n\nEverything else is handled or scheduled.',
  },
  shop: {
    route: '/',
    ask: 'Why did sales drop yesterday?',
    steps: [['mcp__shopify__list_orders', 'mcp__ga4__run_report', 'mcp__meta__get_insights'], ['mcp__shopify__get_shipping_rules']],
    between: ['Traffic looks normal, so it isn’t the ads. Checking the checkout…\n\n'],
    reply: 'Traffic held. The checkout didn’t.\n\n| | Yesterday | Week avg |\n|---|---|---|\n| Sessions | 4,812 | 4,950 |\n| Orders | 142 | 198 |\n| Checkout conversion | 1.9% | 3.1% |\n\nA shipping rule changed at 14:20: orders under €50 now pay €9 instead of free shipping. Drop-offs start exactly then. Want me to roll it back?',
  },
  marketing: {
    route: '/',
    ask: 'Draft this week’s newsletter from what we shipped.',
    steps: [['Skill', 'Grep', 'Read', 'Write']],
    reply: 'Draft saved to newsletter-this-week.md in Marketing, in our usual voice. Three stories: the Breakfast Bundle, the Tide mugs back in stock and a customer photo from Thursday.\n\nSubject line options:\n- “Breakfast, sorted: the new bundle”\n- “The Tide mugs are back”\n\nI’ll schedule it once you approve.',
    then: '/files/Marketing/newsletter-this-week.md',
  },
  sales: {
    route: '/files/Wholesale/cafe-demo-plan.md',
    ask: 'Follow up with everyone from Tuesday’s demo.',
    steps: [['mcp__gcalendar__list_events', 'mcp__email__search_emails', 'Read'], ['mcp__email__create_draft', 'mcp__reminders__set_reminder']],
    between: ['Got the four buyers from the plan and your notes. Drafting…\n\n'],
    reply: 'Ines already asked about pricing, so her reply has the price sheet attached. The other **3 follow-ups are drafted** in your inbox.\n\nIf anyone stays quiet, I’ll remind you on Friday.',
  },
  team: {
    route: '/team',
    ask: 'Remind the team about Friday’s inventory count.',
    steps: [['mcp__workspace-api__memory_now'], ['mcp__reminders__set_reminder', 'mcp__reminders__set_reminder', 'mcp__reminders__set_reminder']],
    between: ['Lena, Tom and Ivy are on the count. Setting a reminder for each of them…\n\n'],
    reply: 'Done. Everyone gets a ping on Friday at 9:00: **Lena and Tom on Telegram**, **Ivy in the workspace**, since she isn’t on Telegram.\n\nI’ll collect the counts as they come in.',
  },
};

// A smaller team and board than the full demo, so each screen reads at a glance.
export const SHOWCASE_PEOPLE = ['nora', 'lena', 'tom', 'ivy'];
export const SHOWCASE_TASKS = ['Decide: roll back the shipping rule', 'Draft the spring campaign budget', 'Sign off the new pricing page', 'Friday newsletter', 'Prepare the Brewline reorder', 'Monday stock count'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The conversation playing now: the page loads once (?showcase=<id> or
// ?showcase=idle) and the landing page asks for each next one with
// postMessage({ type: 'showcase:play', id }), so switching never reloads.
let current = SHOWCASE;
const enc = new TextEncoder();
const sse = (event, data) => enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** The scripted turn, as the server streams a real one. */
export function showcaseTurn() {
  const s = SCRIPTS[current];
  const id = current;
  const stream = new ReadableStream({
    async start(ctl) {
      const say = async (text) => {
        for (const w of text.split(/(?<= )/)) { ctl.enqueue(sse('message', w)); await sleep(28); }
      };
      await sleep(250);
      let n = 0;
      for (let g = 0; g < (s?.steps || []).length; g++) {
        for (const name of s.steps[g]) {
          const id = `sc_${++n}`;
          ctl.enqueue(sse('tool_start', { id, name }));
          await sleep(650);
          ctl.enqueue(sse('tool_end', { id, ok: true }));
          await sleep(150);
        }
        if (s.between?.[g]) await say(s.between[g]);
      }
      await say(s?.reply || '');
      ctl.enqueue(sse('settled', {}));
      ctl.enqueue(sse('done', {}));
      ctl.close();
      if (s?.then) setTimeout(() => go(s.then), 500);
      setTimeout(() => window.parent?.postMessage({ type: 'showcase:done', id }, '*'), 900);
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

// The router follows the address bar on popstate, as on Back.
function go(path) {
  const base = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
  history.pushState(null, '', `${base}${path}${location.search}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

const visible = (sel) => [...document.querySelectorAll(sel)].find((el) => el.offsetParent);
const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;

/** One conversation: a fresh chat, the page it belongs to, the question typed and sent. */
async function play(id) {
  const s = SCRIPTS[id];
  if (!s) return;
  current = id;
  // A fresh chat, through the chat's own "New chat" button (when the chat is open).
  const fresh = visible('button[title="New chat"]');
  if (fresh) { fresh.click(); await sleep(250); }
  go(s.route);
  let box = null;
  for (let i = 0; i < 60 && !box; i++) { await sleep(100); box = visible('textarea'); }
  if (!box || current !== id) return;
  await sleep(500);
  box.focus();
  for (let k = 1; k <= s.ask.length; k++) {
    if (current !== id) return;
    setValue.call(box, s.ask.slice(0, k));
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(s.ask[k - 1] === ' ' ? 55 : 32);
  }
  await sleep(420);
  if (current !== id) return;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
}

/** Once the app is up: say so to the landing page, play what the URL names, then take requests. */
export async function startShowcase() {
  // A picture of the app, not an app to use: nothing scrolls, nothing takes a
  // click or a key (the question is typed by this script, not the keyboard).
  const style = document.createElement('style');
  style.textContent = '*{scrollbar-width:none!important;pointer-events:none!important;user-select:none!important}*::-webkit-scrollbar{display:none!important}';
  document.head.appendChild(style);
  for (const t of ['keydown', 'keypress', 'wheel', 'touchmove', 'mousedown', 'pointerdown']) {
    window.addEventListener(t, (e) => { if (e.isTrusted) { e.preventDefault(); e.stopPropagation(); } }, { capture: true, passive: false });
  }
  // The file view loads its editor on first open: fetch it now, so no screen ever shows loading.
  import('../components/workspace/MarkdownEditor.jsx').catch(() => {});
  for (let i = 0; i < 100 && !visible('textarea'); i++) await sleep(100);
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'showcase:play' && SCRIPTS[e.data.id]) play(e.data.id);
  });
  window.parent?.postMessage({ type: 'showcase:ready' }, '*');
  if (SCRIPTS[SHOWCASE]) play(SHOWCASE);
}
