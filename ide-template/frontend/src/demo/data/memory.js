// The demo's memory: what Aria remembers about Saltmarsh Ceramics, as the
// Memory screen reads it from /api/memory/v4/* and /api/routines.
//
// Written as conversations (records) that each gave a few facts; every view
// (facts, topics, timelines, right now, sharing, changes, search) is derived
// from that one list for the person looking, so they always agree and a
// private fact never reaches anyone else's screen. Scopes are stored the way
// the engine stores them ('shared', 'user:nora', 'user:mara') and shown the way
// the API shows them ('shared' / 'private').
//
// Everything is invented, and every date is relative to today.

import { at, day, when, nextWeekday } from '../time.js';
import { PEOPLE, BOT } from './cast.js';

/* ────────────────────────────── dates ────────────────────────────── */

const NOW = Date.now();
/** at(), but never in the future: a "today 09:10" opened at 07:00 reads as just now. */
const ts = (days, hhmm) => {
  const iso = at(days, hhmm);
  return Date.parse(iso) > NOW ? new Date(NOW - 5 * 60_000).toISOString() : iso;
};
const weekday = new Date().getDay();
/** Days from today to the next given weekday (0 = Sunday); 0 when it is today. */
const next = (wd) => (wd - weekday + 7) % 7;
/** Days back to the last given weekday; 0 when it is today. */
const last = (wd) => -((weekday - wd + 7) % 7);
const THU = next(4);
// The Ember shoot: the next Thursday after today (the files and the board use the same day).
const SHOOT = nextWeekday(4);
const FRI = next(5);
const MON_LAST = last(1);
const MON_NEXT = next(1) || 7;
/** 'Tuesday 20 October' — how a fact writes a day. */
const spoken = (days) => new Date(`${day(days)}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
/** '1 November' — the first of next month. */
const firstOfNextMonth = (() => {
  const d = new Date(); d.setMonth(d.getMonth() + 1, 1);
  return { iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`, text: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) };
})();
const daysToFirst = Math.round((Date.parse(`${firstOfNextMonth.iso}T12:00:00`) - Date.parse(`${day(0)}T12:00:00`)) / 86400_000);

/* ────────────────────────────── the board and the integrations ────────────────────────────── */

const TASKS = {
  t_ember_launch:      { title: 'Ember collection launch',             status: 'in_progress', deadline: day(12),     priority: 'high',   owner: 'leo' },
  t_brewline_reorder:  { title: 'Prepare Brewline reorder',            status: 'in_progress', deadline: day(5),      priority: 'high',   owner: 'tom' },
  t_ostra_credit:      { title: "Get Ostra's credit note",             status: 'in_progress', deadline: day(2),      priority: 'medium', owner: 'jonas' },
  t_newsletter:        { title: 'Friday newsletter: Breakfast Bundle', status: 'in_progress', deadline: day(FRI),    priority: 'high',   owner: 'mara' },
  t_photo_shoot:       { title: 'Ember photo shoot Thursday',          status: 'backlog',     deadline: day(SHOOT),  priority: 'medium', owner: 'ivy' },
  t_stock_count:       { title: 'Monday stock count',                  status: 'backlog',     deadline: day(MON_NEXT), priority: 'low',  owner: 'lena' },
  t_pricing_page:      { title: 'Sign off the new pricing page',       status: 'backlog',     deadline: day(1),      priority: 'high',   owner: 'nora' },
  t_shipping_rule:     { title: 'Roll back the €9 shipping rule',      status: 'backlog',     deadline: day(0),      priority: 'high',   owner: 'nora' },
};
function taskOf(id) {
  const t = TASKS[id];
  if (!t) return null;
  const p = PEOPLE[t.owner];
  return { id, title: t.title, status: t.status, deadline: t.deadline, priority: t.priority, owner: t.owner, ownerName: p?.name || t.owner, ownerAvatar: p?.avatar || null };
}

const GRANOLA = { id: 'granola', label: 'Granola', logo: '/integrations/granola.svg' };
const MEETING_SOURCES = {
  fathom:    { id: 'fathom',    label: 'Fathom',    logo: '/integrations/fathom.svg' },
  fireflies: { id: 'fireflies', label: 'Fireflies', logo: '/integrations/fireflies.svg' },
  otter:     { id: 'otter',     label: 'Otter.ai',  logo: '/integrations/otter.svg' },
  readai:    { id: 'readai',    label: 'Read AI',   logo: '/integrations/readai.svg' },
  krisp:     { id: 'krisp',     label: 'Krisp',     logo: '/integrations/krisp.svg' },
};
const MEETING_WHAT = "your meetings' notes and transcripts, each night";

/* ────────────────────────────── topics ────────────────────────────── */

// The names that make tiles. `who` is the overnight profile line: written to
// be true for anyone on the team (never built from a private conversation).
const TOPICS = [
  { name: 'Brewline Cafés',      kind: 'company', who: 'A café chain with 9 locations; buys Tide mugs and pour-over drippers wholesale every six weeks. Tom owns the account.' },
  { name: 'Ostra Clay Supply',   kind: 'company', who: 'Supplies the studio’s clay and glazes; delivers on Wednesdays. Jonas handles the account.' },
  { name: 'Boxwell Packaging',   kind: 'company', who: 'Makes the shipping boxes; prices go up 8% from next month.' },
  { name: 'Ember collection',    kind: 'project', who: null },
  { name: 'Breakfast Bundle',    kind: 'project', who: null },
  { name: 'Paula Reyes',         kind: 'person',  who: 'Freelance product photographer; shooting the Ember collection for Ivy.' },
  { name: 'Tide Mug Set',        kind: 'project', who: 'The best seller: four mugs for €48, never discounted below €39.' },
  { name: 'Shipping rule change', kind: 'project', who: null },
];
/** One key per spelling family, accents folded so URLs stay plain ("Brewline Cafés" → brewlinecafes). */
const keyOf = (name) => String(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const TOPIC_BY_KEY = Object.fromEntries(TOPICS.map((t) => [keyOf(t.name), { ...t, key: keyOf(t.name) }]));
const TOPIC_MIN = 2;

/* ────────────────────────────── the conversations ────────────────────────────── */

// Each record is one conversation (or one imported meeting) and the facts it
// gave. A fact may carry: ref (to point at it), title, text, kind, names
// (topics), when/until/expires/about (a status on "Right now"), importance,
// task, files, evidence, concerns, updates [{ from, days, hhmm, text }],
// also (other record ids that said it again), replacedBy/why (an older version).
const NORA = 'user:nora';
const MARA = 'user:mara';
const J = BOT.name;

const RECORDS = [
  /* ── shared: wholesale ── */
  {
    id: 'r01brewline', days: -9, hhmm: '10:05', source: 'web', scope: 'shared', origin: NORA,
    messages: [['Nora', 'Brewline reorders roughly every six weeks, all nine cafés in one order. Tom runs it.'], [J, 'Noted. I will remind Tom a week before each reorder is due.']],
    facts: [
      { ref: 'brewlineCycle', title: 'Brewline reorders every six weeks', text: 'Brewline Cafés reorders every six weeks, one order for all 9 locations; Tom owns the account.', names: ['Brewline Cafés'], importance: 2, files: ['Wholesale/brewline-cafes.md'], evidence: 'Brewline reorders roughly every six weeks', concerns: 'a company or project' },
    ],
  },
  {
    id: 'r02breworder', days: -6, hhmm: '16:40', source: 'group', scope: 'shared',
    messages: [['Tom', 'Brewline last order: 240 Tide mugs and 60 pour-over drippers. Delivered Tuesday.'], ['Lena', 'That leaves us thin on Tide. I will count on Monday.']],
    facts: [
      { title: "Brewline's last order", text: 'Brewline Cafés’ last order was 240 Tide mugs and 60 pour-over drippers.', names: ['Brewline Cafés', 'Tide Mug Set'], files: ['Wholesale/brewline-cafes.md', 'Wholesale/price-list.md'], evidence: '240 Tide mugs and 60 pour-over drippers' },
      { ref: 'brewlineDue', title: 'Brewline reorder due', text: `Brewline Cafés’ next reorder is due on ${spoken(5)}; Tom is preparing it.`, kind: 'status', about: 'deadline', when: day(5), expires: day(5), names: ['Brewline Cafés'], task: 't_brewline_reorder', also: ['r01brewline'] },
    ],
  },
  {
    id: 'r03brewmeet', days: -4, hhmm: '15:00', source: 'integration', scope: 'shared', origin: NORA,
    meeting: { item: 'g-7702', title: 'Brewline quarterly check-in', participants: ['Nora', 'Tom', 'Brewline buyer'], kind: 'notes' },
    messages: [['', 'Brewline asked about the Ember glaze for their next mug order. They would switch if the price stays within €2 of Tide.'], ['', 'Leo owns the spring campaign budget; he brings a draft split to the next review.']],
    facts: [
      { title: 'Brewline interested in Ember', text: 'Brewline Cafés would take the Ember glaze on their next mug order if the price stays within €2 a mug of Tide.', names: ['Brewline Cafés', 'Ember collection'], evidence: 'They would switch if the price stays within €2 of Tide', importedAt: [-3, '02:04'] },
      { title: 'Leo owns the spring budget', text: 'Leo owns the spring campaign budget and brings a draft split to the next ads review.', names: ['Ember collection'], evidence: 'Leo owns the spring campaign budget', importedAt: [-3, '02:04'] },
    ],
  },

  /* ── shared: suppliers ── */
  {
    id: 'r04ostra', days: -7, hhmm: '11:20', source: 'telegram', scope: 'shared', origin: NORA,
    messages: [['Nora', 'Do not pay Ostra’s invoice OC-2291 yet. The pallet from the last delivery came in damaged and we are owed a credit note.'], [J, 'Understood, OC-2291 stays on hold until the credit note arrives. I told Jonas.']],
    facts: [
      { ref: 'ostraHold', title: 'Ostra invoice on hold', text: 'Ostra Clay Supply’s invoice OC-2291 is 6 days overdue on purpose: it waits for the credit note for the pallet that arrived damaged. Jonas is chasing it.', kind: 'status', about: 'waiting', names: ['Ostra Clay Supply'], task: 't_ostra_credit', files: ['Suppliers/ostra-clay.md'], evidence: 'Do not pay Ostra’s invoice OC-2291 yet', also: ['r05ostracall'],
        updates: [{ from: 'r05ostracall', days: -1, hhmm: '12:15', text: 'Ostra confirmed the credit note by phone; the written copy is promised by Friday. OC-2291 gets paid the day it arrives.' }] },
    ],
  },
  {
    id: 'r05ostracall', days: -1, hhmm: '12:15', source: 'group', scope: 'shared',
    messages: [['Jonas', 'Ostra called back. Credit note confirmed, paper copy by Friday. I will pay OC-2291 the same day.'], ['Jonas', 'Reminder: they only deliver on Wednesdays, 500 kg minimum.']],
    facts: [
      { title: 'Ostra delivery days', text: 'Ostra Clay Supply delivers on Wednesdays only, with a 500 kg minimum order.', names: ['Ostra Clay Supply'], files: ['Suppliers/ostra-clay.md'], evidence: 'they only deliver on Wednesdays, 500 kg minimum' },
    ],
  },
  {
    id: 'r06boxrumour', days: -14, hhmm: '09:40', source: 'group', scope: 'shared',
    messages: [['Jonas', 'Heard from Boxwell’s rep that box prices might go up, around 5%.']],
    facts: [
      { ref: 'boxwell5', title: 'Boxwell may raise prices', text: 'Boxwell Packaging may raise box prices by about 5% later this year.', names: ['Boxwell Packaging'], replacedBy: 'boxwell8', why: 'replaced', replacedDays: [-4, '14:30'] },
    ],
  },
  {
    id: 'r07boxconfirm', days: -4, hhmm: '14:30', source: 'web', scope: 'shared', origin: NORA,
    messages: [['Nora', `Boxwell sent the letter: boxes go up 8% from ${firstOfNextMonth.text}. Can Jonas get a second quote?`], [J, 'Yes. I added it to Jonas’s list and saved the letter’s numbers to the supplier file.']],
    facts: [
      { ref: 'boxwell8', title: 'Boxwell prices up 8%', text: `Boxwell Packaging raises box prices by 8% from ${firstOfNextMonth.text}.`, names: ['Boxwell Packaging'], importance: 2, files: ['Suppliers/boxwell-packaging.md'], evidence: 'boxes go up 8%' },
      { title: 'Second packaging quote', text: 'Jonas is getting a second packaging quote before Boxwell’s new prices start.', kind: 'status', about: 'deadline', when: day(daysToFirst - 1), expires: day(daysToFirst - 1), names: ['Boxwell Packaging'] },
    ],
  },

  /* ── shared: Ember, the shoot, the studio ── */
  {
    id: 'r08ember', days: -11, hhmm: '17:10', source: 'web', scope: 'shared',
    messages: [['Leo', 'Ember is live on Meta and Google Ads as of this morning. I will watch it daily for the first two weeks.'], [J, 'I will keep the daily numbers in the Ember campaign report.']],
    facts: [
      { title: 'Ember ads are live', text: 'The Ember glaze collection launched on Meta and Google Ads; Leo watches the campaign daily for its first two weeks.', names: ['Ember collection'], task: 't_ember_launch', files: ['Products/ember-launch-plan.md', 'Marketing/ad-plan-autumn.md'] },
    ],
  },
  {
    id: 'r09emberweek', days: -3, hhmm: '09:30', source: 'group', scope: 'shared',
    messages: [['Leo', 'Ember week one: Meta 3.4x return, Google 2.1x. Moving €300 from Google to Meta.']],
    facts: [
      { title: 'Ember week one results', text: 'After its first week the Ember campaign returned 3.4× on Meta and 2.1× on Google Ads; Leo moved €300 from Google to Meta.', names: ['Ember collection'], files: ['Reports/ember-campaign.md'], evidence: 'Meta 3.4x return, Google 2.1x' },
    ],
  },
  {
    id: 'r10shootplan', days: -10, hhmm: '13:00', source: 'group', scope: 'shared',
    messages: [['Ivy', 'Pencilling the Ember shoot for Wednesday, photographer to confirm.']],
    facts: [
      { ref: 'shootWed', title: 'Ember shoot on Wednesday', text: 'The Ember photo shoot was planned for Wednesday.', names: ['Ember collection'], replacedBy: 'shootThu', why: 'superseded', replacedDays: [-5, '10:45'] },
    ],
  },
  {
    id: 'r11shootbooked', days: -5, hhmm: '10:45', source: 'web', scope: 'shared',
    messages: [['Ivy', `Booked Paula Reyes for ${spoken(SHOOT)}, 09:00 at the studio, for the Ember shoot. Her day rate is €650 with edits.`], [J, 'Saved. I put the shot list in the shoot brief.']],
    facts: [
      { ref: 'shootThu', title: 'Ember shoot with Paula Reyes', text: `Ivy booked photographer Paula Reyes for ${spoken(SHOOT)} at 09:00 in the studio to shoot the Ember collection.`, kind: 'status', about: 'meeting', when: when(SHOOT, '09:00'), expires: day(SHOOT), names: ['Paula Reyes', 'Ember collection'], task: 't_photo_shoot', files: ['Marketing/shoot-brief-ember.md'], evidence: 'Booked Paula Reyes' },
      { title: 'Paula Reyes’s day rate', text: 'Paula Reyes is a freelance product photographer; her day rate is €650, edits included.', names: ['Paula Reyes'], evidence: 'Her day rate is €650 with edits' },
    ],
  },
  {
    id: 'r12paula', days: -2, hhmm: '18:05', source: 'telegram', scope: 'shared', origin: MARA,
    messages: [['Mara', 'Paula wants the Ember pieces glazed and fired by Wednesday night so she can style them in the morning.'], [J, 'I will tell Lena; the Tuesday firing covers it.']],
    facts: [
      { title: 'Paula needs fired pieces', text: 'Paula Reyes needs the Ember pieces fired by Wednesday night to style them on the morning of the shoot.', names: ['Paula Reyes', 'Ember collection'], concerns: 'a company or project' },
    ],
  },
  {
    id: 'r13kiln', days: -8, hhmm: '08:50', source: 'group', scope: 'shared',
    messages: [['Lena', 'Kiln is down until the element is replaced, back by the weekend.'], ['Lena', 'Glaze firings stay Tuesdays and Fridays after that.']],
    facts: [
      { title: 'Kiln down for repair', text: 'The kiln was down until its element was replaced.', kind: 'status', about: 'other', expires: day(-5) },
      { title: 'Glaze firing days', text: 'Glaze firings run on Tuesdays and Fridays; Lena keeps the kiln schedule.', kind: 'routine', files: ['Studio/kiln-schedule.md'] },
    ],
  },

  /* ── shared: products, stock, pricing ── */
  {
    id: 'r14pricing', days: -12, hhmm: '11:00', source: 'web', scope: 'shared', origin: NORA,
    messages: [['Nora', 'Rule for every sale and code: the Tide Mug Set never goes below €39. It is €48.'], [J, 'Got it. I will check every discount against €39 before anything goes live.']],
    facts: [
      { title: 'Tide Mug Set price floor', text: 'The Tide Mug Set sells at €48 and is never discounted below €39.', names: ['Tide Mug Set'], importance: 2, files: ['Products/pricing.md', 'Products/copy/tide-mug-set.md'], evidence: 'never goes below €39' },
    ],
  },
  {
    id: 'r15stock', days: MON_LAST, hhmm: '09:20', source: 'group', scope: 'shared',
    messages: [['Lena', 'Stock count done. Tide sets down to 34 after Brewline. Harbour bowls fine, Speckle plates fine.'], ['Lena', 'Next count Monday as usual.']],
    facts: [
      { title: 'Tide Mug Set running low', text: 'Tide Mug Sets are down to 34 after the Brewline order; Lena flagged it in the Monday count.', kind: 'status', about: 'stock', expires: day(MON_NEXT), names: ['Tide Mug Set'], task: 't_stock_count', files: ['Studio/stock-count.md'], evidence: 'Tide sets down to 34' },
      { title: 'Monday stock count', text: 'Lena runs the stock count every Monday morning.', kind: 'routine', files: ['Studio/stock-count.md'] },
    ],
  },
  {
    id: 'r16bundle', days: -3, hhmm: '15:25', source: 'web', scope: 'shared', origin: MARA,
    messages: [['Mara', 'Breakfast Bundle is 2 mugs and 2 bowls for €79. It leads this Friday’s newsletter.'], [J, 'Saved the copy draft next to the product copy.']],
    facts: [
      { title: 'Breakfast Bundle in Friday’s newsletter', text: `The Breakfast Bundle (2 mugs + 2 bowls, €79) launches in the newsletter on ${spoken(FRI)}.`, kind: 'status', about: 'deadline', when: day(FRI), expires: day(FRI), names: ['Breakfast Bundle'], task: 't_newsletter', files: ['Products/copy/breakfast-bundle.md', 'Marketing/newsletter-this-week.md'], evidence: '2 mugs and 2 bowls for €79', concerns: 'a company or project' },
      { title: 'Bundle uses Tide mugs', text: 'The Breakfast Bundle is built from Tide mugs and Harbour Bowls, so it draws on the same Tide stock.', names: ['Breakfast Bundle', 'Tide Mug Set'], concerns: 'a company or project' },
    ],
  },
  {
    id: 'r17newsletter', days: -13, hhmm: '10:10', source: 'web', scope: 'shared', origin: MARA,
    messages: [['Mara', 'The newsletter goes every Friday at 9. Brand voice notes are in Marketing.']],
    facts: [
      { title: 'Friday newsletter', text: 'Mara sends the newsletter every Friday at 09:00, written to the brand voice notes.', kind: 'routine', names: ['Breakfast Bundle'], files: ['Marketing/brand-voice.md'], concerns: 'the team’s work' },
    ],
  },
  {
    id: 'r18pricingpage', days: -2, hhmm: '11:45', source: 'group', scope: 'shared',
    messages: [['Mara', 'Still can’t review the pricing page, it needs Nora’s sign-off first.']],
    facts: [
      { title: 'Pricing page waits for sign-off', text: 'The new pricing page waits for Nora’s sign-off; Mara’s review is blocked until then.', kind: 'status', about: 'waiting', task: 't_pricing_page', files: ['Products/pricing.md'], evidence: 'it needs Nora’s sign-off first' },
    ],
  },
  {
    id: 'r19telegram', days: -16, hhmm: '12:30', source: 'web', scope: 'shared', origin: NORA,
    messages: [['Nora', 'If something needs Mara quickly, Telegram. She answers there in minutes, email can take a day.']],
    facts: [
      { title: 'Mara answers fastest on Telegram', text: 'Mara answers fastest on Telegram; email can take her a day.', kind: 'preference', concerns: 'another person', subject: 'Mara' },
    ],
  },

  /* ── shared: the shipping rule ── */
  {
    id: 'r20shipping', days: -1, hhmm: '17:30', source: 'email', scope: 'shared', origin: NORA,
    messages: [['', 'Shopify: shipping rule "Under €50" changed at 14:20 — rate €0.00 → €9.00.'], [J, 'Checkout conversion since the change: 1.9%, down from 3.1%. Flagged to Nora; the rollback is ready.']],
    facts: [
      { title: 'Shipping rule changed', text: 'A Shopify shipping rule changed yesterday at 14:20: orders under €50 now pay €9 shipping instead of free.', names: ['Shipping rule change'], files: ['Reports/weekly-sales.md'], evidence: 'rate €0.00 → €9.00', tsAt: [-1, '14:20'] },
      { title: 'Shipping rollback waits for Nora', text: 'Checkout conversion fell from 3.1% to 1.9% after the €9 shipping rule; the rollback is ready and waits for Nora’s yes.', kind: 'status', about: 'waiting', expires: day(1), names: ['Shipping rule change'], task: 't_shipping_rule', evidence: 'Checkout conversion since the change: 1.9%, down from 3.1%' },
    ],
  },
  {
    id: 'r21shipcheck', days: 0, hhmm: '08:10', source: 'review', scope: 'shared',
    messages: [['', 'Daily review: 14 orders under €50 yesterday afternoon, 6 abandoned at the shipping step.']],
    facts: [
      { title: 'Abandoned at shipping', text: 'Since the shipping change, 6 of 14 orders under €50 were abandoned at the shipping step.', names: ['Shipping rule change'], evidence: '6 abandoned at the shipping step' },
    ],
  },

  /* ── Nora, private ── */
  {
    id: 'r30investor', days: -6, hhmm: '19:20', source: 'telegram', scope: NORA, origin: NORA,
    messages: [['Nora', `Thursday call with the angels again, 10:00. Prep is in my investor-prep file. I want Ember spend against Ember revenue in it.`], [J, 'I will update the prep file Wednesday evening with the Ember numbers.']],
    facts: [
      { title: 'Investor call Thursday', text: `Nora has her call with the angel investors on ${spoken(THU)} at 10:00; the prep lives in her investor-prep file.`, kind: 'status', about: 'meeting', when: when(THU, '10:00'), expires: day(THU), files: ['users/nora/investor-prep.md'], evidence: 'Thursday call with the angels again, 10:00' },
      { title: 'Ember numbers for investors', text: 'Nora wants Ember ad spend against Ember revenue in the investor prep.', names: ['Ember collection'], files: ['users/nora/investor-prep.md'] },
    ],
  },
  {
    id: 'r31hiring', days: -2, hhmm: '21:05', source: 'web', scope: NORA, origin: NORA,
    messages: [['Nora', 'Thinking about hiring a second potter in spring. Wholesale alone would keep them busy. Nothing decided.'], [J, 'I started a note with the numbers you gave me.']],
    facts: [
      { ref: 'potter', title: 'Second potter in spring', text: 'Nora is thinking about hiring a second potter in spring; nothing is decided.', files: ['users/nora/hiring-thoughts.md'], concerns: 'the person themselves', evidence: 'Thinking about hiring a second potter in spring' },
    ],
  },
  {
    id: 'r32brewline', days: -1, hhmm: '20:40', source: 'telegram', scope: NORA, origin: NORA,
    messages: [['Nora', 'Between us: I think Brewline might be shopping around for a cheaper supplier. Their buyer asked twice about volume pricing.'], [J, 'Kept to you. Want me to prepare a volume price for Tom’s next call?']],
    facts: [
      { ref: 'brewlineShop', title: 'Brewline may be shopping around', text: 'Nora suspects Brewline Cafés might be shopping around for a cheaper supplier; their buyer asked twice about volume pricing.', names: ['Brewline Cafés'], concerns: 'a company or project', evidence: 'Brewline might be shopping around for a cheaper supplier' },
    ],
  },
  {
    id: 'r33summary', days: -15, hhmm: '07:55', source: 'telegram', scope: NORA, origin: NORA,
    messages: [['Nora', 'One summary in the morning on Telegram please, not pings all day. And never send anything to a wholesale client without my OK.'], [J, 'Will do: one morning summary, and nothing goes to a wholesale client without you.']],
    facts: [
      { title: 'One morning summary', text: 'Nora wants one morning summary on Telegram rather than pings through the day.', kind: 'preference', concerns: 'the person themselves' },
    ],
    rules: ['Never send anything to a wholesale client without my OK.'],
  },
  {
    id: 'r34tideprice', days: -5, hhmm: '22:10', source: 'web', scope: NORA, origin: NORA,
    messages: [['Nora', 'Not raising Tide before Christmas after all. Revisit in January.']],
    facts: [
      { title: 'Tide price stays until January', text: 'Nora decided not to raise the Tide Mug Set price before Christmas; she revisits it in January.', names: ['Tide Mug Set'], files: ['Products/pricing.md'], concerns: 'a company or project' },
    ],
  },

  /* ── Mara, private ── */
  {
    id: 'r40sendtime', days: -4, hhmm: '16:15', source: 'telegram', scope: MARA, origin: MARA,
    messages: [['Mara', 'I want to test sending at 7:30 instead of 9. Half the list each, two weeks.'], [J, 'I will set up the split for the next two Fridays and compare opens.']],
    facts: [
      { title: 'Test a 07:30 send', text: 'Mara wants to test a 07:30 newsletter send against 09:00, half the list each, for two weeks.', kind: 'preference', files: ['users/mara/newsletter-ideas.md'], concerns: 'the person themselves' },
    ],
  },
  {
    id: 'r41ideas', days: -7, hhmm: '14:00', source: 'web', scope: MARA, origin: MARA,
    messages: [['Mara', 'November ideas: a studio diary series, a care guide for the speckle glaze, a gift guide under €50.'], [J, 'Saved to your ideas file.']],
    facts: [
      { title: 'November newsletter ideas', text: 'Mara’s November ideas: a studio diary series, a care guide for the speckle glaze and a gift guide under €50.', files: ['users/mara/newsletter-ideas.md'] },
    ],
  },
  {
    id: 'r42copy', days: -1, hhmm: '18:30', source: 'telegram', scope: MARA, origin: MARA,
    messages: [['Mara', 'I need the bundle copy final by Thursday 5pm or I can’t schedule Friday’s send.'], [J, 'I will nudge you Thursday at 15:00 if it is still open.']],
    facts: [
      { title: 'Bundle copy final by Thursday', text: `Mara needs the Breakfast Bundle copy final by ${spoken(THU)} at 17:00 to schedule Friday’s newsletter.`, kind: 'status', about: 'deadline', when: when(THU, '17:00'), expires: day(THU), names: ['Breakfast Bundle'], files: ['Products/copy/breakfast-bundle.md'] },
    ],
  },
  {
    id: 'r43hero', days: 0, hhmm: '09:05', source: 'web', scope: MARA, origin: MARA,
    messages: [['Mara', 'The bundle hero photo is too dark for email. I would rather use Ivy’s alternate shot from the window table.'], [J, 'Noted in your notes; I can swap it in the draft when you say.']],
    facts: [
      { title: 'Lighter hero photo', text: 'Mara finds the Breakfast Bundle hero photo too dark for email and prefers Ivy’s alternate window-table shot.', names: ['Breakfast Bundle'], files: ['users/mara/notes.md'] },
    ],
  },
  {
    id: 'r44offday', days: -2, hhmm: '19:50', source: 'telegram', scope: MARA, origin: MARA,
    messages: [['Mara', `I am off on ${spoken(FRI + 7)}. That week the newsletter should go out Thursday.`]],
    facts: [
      { ref: 'maraOff', title: 'Mara off next Friday', text: `Mara is off on ${spoken(FRI + 7)}; that week’s newsletter goes out on Thursday instead.`, kind: 'status', about: 'travel', when: day(FRI + 7), expires: day(FRI + 7), concerns: 'the person themselves' },
    ],
  },
  {
    id: 'r45subjects', days: -10, hhmm: '11:30', source: 'web', scope: MARA, origin: MARA,
    messages: [['Mara', 'Always give me subject lines in threes so I can pick.'], [J, 'Will do.']],
    facts: [
      { title: 'Subject lines in threes', text: 'Mara wants newsletter subject lines drafted in threes so she can pick one.', kind: 'preference', concerns: 'the person themselves' },
    ],
    rules: ['Draft subject lines in threes.'],
  },
];

/* ────────────────────────────── the facts store ────────────────────────────── */

const RECORD_BY_ID = Object.fromEntries(RECORDS.map((r) => [r.id, r]));
const recTs = (r) => ts(r.days, r.hhmm);

// Every fact, with its id, record, time and links resolved.
const FACTS = [];
const BY_REF = {};
for (const r of RECORDS) {
  r.facts.forEach((f, i) => {
    const fact = {
      ...f, id: `${r.id}:${i}`, record: r.id, scope: r.scope, origin: r.origin || null,
      said: f.tsAt ? ts(...f.tsAt) : recTs(r),
      at: f.importedAt ? ts(...f.importedAt) : (f.tsAt ? ts(...f.tsAt) : recTs(r)),
      kind: f.kind || 'fact',
      sources: [r.id, ...(f.also || []).filter((x) => x !== r.id)],
    };
    FACTS.push(fact);
    if (f.ref) BY_REF[f.ref] = fact;
  });
}
for (const f of FACTS) {
  if (f.replacedBy) {
    f.replacedById = BY_REF[f.replacedBy].id;
    f.replacedAt = ts(...f.replacedDays);
  }
}
const FACT_BY_ID = Object.fromEntries(FACTS.map((f) => [f.id, f]));

/* ────────────────────────────── the viewer ────────────────────────────── */

const whereOf = (scope) => (scope === 'shared' ? 'shared' : String(scope).startsWith('group:') ? 'group' : 'private');
const TODAY = day(0);

function viewerOf(who) {
  const slug = who === 'member' ? 'mara' : 'nora';
  const p = PEOPLE[slug];
  const own = `user:${slug}`;
  return { slug, name: p.name, own, read: ['shared', own], isAdmin: p.role === 'admin' };
}
const canRead = (v, scope) => v.read.includes(scope);
const isOwned = (v, x) => x.scope === v.own || x.origin === v.own;
const canManage = (v, x) => isOwned(v, x) || (v.isAdmin && !String(x.scope).startsWith('user:'));
const isPast = (f) => !!f.replacedById || (f.kind === 'status' && f.expires && f.expires < TODAY);

/** A fact as GET /memory/v4/facts writes it. */
function factItem(v, f) {
  const r = RECORD_BY_ID[f.record];
  const past = isPast(f);
  const replaced = !!f.replacedById;
  // The versions it replaced, oldest first: its own timeline.
  const history = [];
  if (!replaced) {
    let cur = f;
    for (let i = 0; i < 10; i++) {
      const older = FACTS.find((x) => x.replacedById === cur.id && canRead(v, x.scope));
      if (!older) break;
      history.unshift({ id: older.id, ts: older.at, until: older.replacedAt, title: older.title || null, text: older.text, updates: [], why: older.why || 'replaced' });
      cur = older;
    }
  }
  return {
    id: f.id, recordId: f.record, ts: f.at, said: f.said, title: f.title || null, text: f.text,
    kind: f.kind, importance: f.importance || null, expires: f.expires || null, past,
    superseded: replaced ? f.replacedAt : null, sources: f.sources.length,
    supersededBy: f.replacedById || null, supersededWhy: replaced ? (f.why || 'replaced') : null,
    supersededByTitle: replaced ? (FACT_BY_ID[f.replacedById]?.title || null) : null,
    updates: (f.updates || []).map((u) => ({ ts: ts(u.days, u.hhmm), text: u.text, recordId: u.from })),
    history,
    ended: null, evidence: f.evidence || null, undated: false, unverified: false,
    scope: whereOf(f.scope), source: r.source, review: r.source === 'review',
    integration: r.meeting ? { ...GRANOLA, title: r.meeting.title } : null,
    mine: canManage(v, f), owned: isOwned(v, f),
    task: f.task ? taskOf(f.task) : null,
    files: (f.files || []).map((path) => ({ path, exists: true })),
    names: f.names || [],
  };
}

const visibleFacts = (v) => FACTS.filter((f) => canRead(v, f.scope));
const newestFirst = (a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);
const factItems = (v, { history }) => visibleFacts(v).filter((f) => history || !isPast(f)).map((f) => factItem(v, f)).sort(newestFirst);

/* ────────────────────────────── per-viewer pieces ────────────────────────────── */

// "What I'm keeping track of": each person's own overnight list.
const DIGEST = {
  nora: [
    { name: 'Shipping rule change', state: 'active', line: 'Under-€50 orders pay €9 since yesterday 14:20; conversion 3.1% → 1.9%. Rollback waits for your yes.', date: day(-1) },
    { name: 'Brewline Cafés', state: 'active', line: `Reorder due ${spoken(5)}; they asked about Ember within €2 of Tide.`, date: day(-4) },
    { name: 'Ember collection', state: 'active', line: `Week one: Meta 3.4×, Google 2.1×; €300 moved to Meta. Shoot with Paula on ${spoken(SHOOT)}.`, date: day(-3) },
    { name: 'Ostra credit note', state: 'active', line: 'Credit note confirmed by phone, paper copy by Friday; OC-2291 is paid when it lands.', date: day(-1) },
    { name: 'Breakfast Bundle', state: 'active', line: `2 mugs + 2 bowls at €79, launching in the newsletter on ${spoken(FRI)}.`, date: day(-3) },
    { name: 'Boxwell Packaging', state: 'active', line: `Boxes up 8% from ${firstOfNextMonth.text}; Jonas is getting a second quote.`, date: day(-4) },
    { name: 'Second potter', state: 'paused', line: 'You are weighing a second potter for spring; nothing decided.', date: day(-2) },
  ],
  mara: [
    { name: 'Breakfast Bundle', state: 'active', line: `Leads the newsletter on ${spoken(FRI)}; copy final by Thursday 17:00, lighter hero photo wanted.`, date: day(0) },
    { name: 'Send-time test', state: 'active', line: '07:30 against 09:00, half the list each, for the next two Fridays.', date: day(-4) },
    { name: 'Ember collection', state: 'active', line: `Ads live on Meta and Google; Paula Reyes shoots it on ${spoken(SHOOT)}.`, date: day(-3) },
    { name: 'Pricing page review', state: 'paused', line: 'Blocked until Nora signs the page off.', date: day(-2) },
    { name: 'November newsletter', state: 'active', line: 'Studio diary, speckle care guide, gift guide under €50.', date: day(-7) },
  ],
};

const PROFILE = {
  nora: {
    about: ['Nora founded Saltmarsh Ceramics and throws most of the Tide and Harbour pieces herself.', 'Nora works from the studio in Lisbon: mornings at the wheel, admin after 14:00.'],
    likes: ['Short answers in chat; the detail in a file.', 'Money in euros, rounded to the euro.'],
  },
  mara: {
    about: ['Mara runs marketing and writes the Friday newsletter.', 'Mara works remotely and answers fastest on Telegram.'],
    likes: ['Drafts in the brand voice: warm, plain, no exclamation marks.', 'Links to the file rather than pasted copy.'],
  },
};
const TEAM_RULES = [
  'Nothing goes to a wholesale client or a supplier without the owner of that account saying yes.',
  'Discounts never take the Tide Mug Set below €39.',
  'Prices on the shop change only after Nora signs off.',
];
const COMPANY_LINES = [
  'Saltmarsh Ceramics makes handmade tableware in a small studio in Lisbon.',
  'It sells on its Shopify shop, wholesale to cafés, and at two seasonal markets.',
  'Best sellers: the Tide Mug Set, Harbour Bowl and Speckle Dinner Plate; the Ember glaze collection is this autumn’s launch.',
];
const kb = (lines) => Math.round(lines.join('\n').length / 102.4) / 10;

const ASKS = {
  nora: [
    { id: 'a_potter_spring', ts: ts(-2, '21:06'), text: 'Thinking about hiring a second potter in spring.', question: 'Share that you are thinking about a second potter with the team?', source: 'web',
      fact: { title: 'Second potter in spring', text: 'Nora is thinking about hiring a second potter in spring; nothing is decided.', kind: 'fact', subject: null, concerns: 'the person themselves', evidence: 'Thinking about hiring a second potter in spring' },
      reason: 'about you', key: 'second potter in spring', aboutPerson: true },
    { id: 'a_brewline_cheaper', ts: ts(-1, '20:41'), text: 'Brewline might be shopping around for a cheaper supplier.', question: 'Share with the team that Brewline may be looking for a cheaper supplier?', source: 'telegram',
      fact: { title: 'Brewline may be shopping around', text: 'Brewline Cafés might be shopping around for a cheaper supplier; their buyer asked twice about volume pricing.', kind: 'status', subject: 'Brewline Cafés', concerns: 'a company or project', evidence: 'Brewline might be shopping around for a cheaper supplier', entities: [{ name: 'Brewline Cafés', kind: 'company' }] },
      reason: 'about Brewline Cafés', key: 'brewline may be shopping around', aboutPerson: false },
    { id: 'a_ember_investors', ts: ts(-6, '19:21'), text: 'I want Ember spend against Ember revenue in the investor prep.', question: 'Share that the Ember numbers go into the investor prep?', source: 'telegram',
      fact: { title: 'Ember numbers for investors', text: 'Nora wants Ember ad spend against Ember revenue in the investor prep.', kind: 'fact', subject: 'Ember collection', concerns: 'a company or project', evidence: 'I want Ember spend against Ember revenue in it', entities: [{ name: 'Ember collection', kind: 'project' }] },
      reason: 'about Ember collection', key: 'ember numbers for investors', aboutPerson: false },
  ],
  mara: [
    { id: 'a_mara_off', ts: ts(-2, '19:51'), text: `I am off on ${spoken(FRI + 7)}.`, question: 'Share your day off with the team?', source: 'telegram',
      fact: { title: 'Mara off next Friday', text: `Mara is off on ${spoken(FRI + 7)}; that week’s newsletter goes out on Thursday instead.`, kind: 'status', subject: null, concerns: 'the person themselves', evidence: `I am off on ${spoken(FRI + 7)}` },
      reason: 'about you', key: 'mara off next friday', aboutPerson: true },
  ],
};
const SHARING_RULES = {
  nora: [
    { subject: 'Ostra Clay Supply', decision: 'share', at: ts(-20, '10:00') },
    { subject: 'Angel investors', decision: 'keep', at: ts(-18, '18:30') },
  ],
  mara: [
    { subject: 'Breakfast Bundle', decision: 'share', at: ts(-3, '15:30') },
  ],
};
const ERASED = {
  nora: [{ ts: ts(-9, '22:15'), by: 'you', removed: 1 }],
  mara: [],
};

const ROUTINES = {
  nora: [
    { id: 'r_watch_inbox', title: 'Watch the inbox', summary: 'Flags what needs you: client replies, money, anything with a date.', description: 'Every hour, read the shop inbox and flag what needs Nora: wholesale replies, supplier invoices and anything with a deadline. Everything else waits for the morning summary.', icon: 'mail', tags: ['email', 'email-imap'] },
    { id: 'r_new_leads', title: 'Reply to new leads fast', summary: 'A café or shop asks about wholesale: a draft reply within the hour.', description: 'When a café or shop writes in about wholesale, draft a reply within the hour with the price list attached, and hand it to Tom to send.', icon: 'message', tags: ['wholesale', 'email'] },
    { id: 'r_stuck_orders', title: 'Stuck orders', summary: 'Orders unshipped after two days, each with what is holding it.', description: 'Each morning, list Shopify orders that are paid but unshipped after two days, with what is holding each one (stock, address, payment).', icon: 'tasks', tags: ['shop', 'shopify'] },
    { id: 'r_ads_review', title: 'Weekly ads review', summary: 'Monday: spend, return and what to move, for Meta and Google.', description: 'Every Monday, compare last week’s spend and return on Meta and Google Ads, call out the Ember campaign, and suggest what to move. Leo decides.', icon: 'trend', tags: ['ads', 'meta-ads', 'google-ads'] },
    { id: 'r_meeting_prep', title: 'Meeting prep', summary: 'The day before a meeting: notes, numbers and open questions.', description: 'The day before a meeting on the calendar, put together the notes from last time, the numbers it needs and the open questions, in one file.', icon: 'users', tags: ['meetings', 'google-workspace'] },
    { id: 'r_clients_risk', title: 'Clients at risk', summary: 'Wholesale clients that went quiet or ordered less than usual.', description: 'Every Friday, check wholesale clients against their usual rhythm and flag anyone late on a reorder or ordering less than usual, with a suggested next step for Tom.', icon: 'warning', tags: ['wholesale', 'shopify'] },
  ],
  mara: [
    { id: 'r_newsletter_draft', title: 'Friday newsletter draft', summary: 'Wednesday: a first draft of Friday’s newsletter from the week’s news.', description: 'Every Wednesday, draft Friday’s newsletter from what launched or changed this week, with three subject lines, and save it in Marketing.', icon: 'megaphone', tags: ['newsletter', 'klaviyo'] },
    { id: 'r_day_plan', title: 'Day plan at 8:00', summary: 'What is due today, what is waiting on others, one line each.', description: 'Each weekday at 8:00, a short plan for Mara: what is due today, what waits on someone else, and anything the team asked of her overnight.', icon: 'sun', tags: ['planning'] },
    { id: 'r_post_ideas', title: 'Post ideas', summary: 'Three post ideas a week from the studio’s photos and news.', description: 'Every Tuesday, three social post ideas from Ivy’s latest photos and the week’s news, each with a caption in the brand voice.', icon: 'star', tags: ['social', 'content'] },
  ],
};

/* ────────────────────────────── derived views ────────────────────────────── */

function overview(v) {
  const now = [];
  for (const f of visibleFacts(v)) {
    if (f.kind !== 'status' || isPast(f)) continue;
    if (!f.when && !f.expires && f.about !== 'waiting') continue;
    now.push({
      id: f.id, key: `${f.about || 'other'}|${(f.when || f.expires || '').slice(0, 10)}|${(f.names || [])[0] || ''}`.toLowerCase(),
      text: f.text, ...(f.title ? { title: f.title } : {}), ...(f.about ? { about: f.about } : {}), ...(f.when ? { when: f.when } : {}),
      ...(f.until ? { until: f.until } : {}), ...(f.sources.length > 1 ? { sources: f.sources.length } : {}),
      expires: f.expires || null, recordId: f.record, scope: f.scope, ts: f.said,
    });
  }
  const dayOf = (x) => (x.when || x.expires || '').slice(0, 10) || '9999-12-31';
  const rank = (s) => (s.startsWith('user:') ? 0 : s.startsWith('group:') ? 1 : 2);
  now.sort((a, b) => (dayOf(a) < dayOf(b) ? -1 : dayOf(a) > dayOf(b) ? 1 : rank(a.scope) - rank(b.scope)));
  return { ok: true, mode: 'on', now: now.slice(0, 10), digest: { at: ts(0, '02:40'), items: DIGEST[v.slug] } };
}

/** The topics a viewer sees, from the facts they can read. */
function topicStats(v) {
  const out = [];
  for (const t of Object.values(TOPIC_BY_KEY)) {
    const fs = visibleFacts(v).filter((f) => (f.names || []).some((n) => keyOf(n) === t.key));
    if (fs.length < TOPIC_MIN) continue;
    const times = fs.map((f) => f.at).sort();
    out.push({ t, facts: fs, first: times[0], last: times[times.length - 1] });
  }
  return out.sort((a, b) => (a.last < b.last ? 1 : -1));
}

function topics(v) {
  const digest = DIGEST[v.slug];
  const items = topicStats(v).map(({ t, facts, first, last }) => {
    const d = digest.find((x) => keyOf(x.name) === t.key);
    const latest = facts.filter((f) => !isPast(f)).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    return {
      name: t.name, key: t.key, kind: t.kind, aliases: [], n: facts.length, convs: new Set(facts.map((f) => f.record)).size,
      first, last, who: t.who, whoAt: t.who ? ts(-1, '02:40') : null, edited: false, suggested: null,
      line: t.who || d?.line || latest?.text || '', state: d && d.state !== 'active' ? d.state : null,
    };
  });
  return { ok: true, items };
}

function timeline(v, stat) {
  const { t, facts } = stat;
  const items = facts.slice().sort((a, b) => (a.at < b.at ? 1 : -1)).map((f) => ({
    ts: f.at, factId: f.id, recordId: f.record, source: RECORD_BY_ID[f.record].source, scope: whereOf(f.scope),
    text: f.text, updates: (f.updates || []).map((u) => ({ ts: ts(u.days, u.hhmm), text: u.text })),
    kind: f.kind, undated: false, past: !!f.replacedById, supersededWhy: f.replacedById ? (f.why || 'replaced') : null, mine: canManage(v, f),
  }));
  return {
    ok: true, name: t.name, kind: t.kind, n: facts.length, aliases: [],
    who: t.who ? { line: t.who, evidence: null, recordId: null, updatedAt: ts(-1, '02:40'), edited: false, suggested: null } : null,
    first: [], items, total: items.length,
  };
}

/** The notes of a record, as the record view and the search hits list them. */
const notesOf = (v, r) => FACTS.filter((f) => f.record === r.id || f.sources.includes(r.id) || (f.updates || []).some((u) => u.from === r.id))
  .filter((f) => canRead(v, f.scope))
  .map((f) => ({ title: f.title || null, text: f.text, kind: f.kind, ...(f.expires ? { expires: f.expires } : {}), ...(f.importance ? { importance: f.importance } : {}) }));
const messagesOf = (r) => r.messages.map(([who, text]) => ({ who, text }));

function record(v, r) {
  return {
    ok: true, id: r.id, ts: recTs(r), source: r.source, scope: whereOf(r.scope),
    meeting: r.meeting ? { ...r.meeting, integration: GRANOLA, at: recTs(r), url: `https://notes.granola.ai/d/${r.meeting.item}` } : null,
    messages: messagesOf(r), notes: notesOf(v, r), mine: canManage(v, r), owned: isOwned(v, r),
  };
}

function prefs(v) {
  const p = PROFILE[v.slug];
  const rules = RECORDS.filter((r) => r.scope === v.own && r.rules).flatMap((r) => r.rules.map((text) => ({ text, date: day(r.days), recordId: r.id, scope: v.own })));
  return {
    ok: true,
    about: { lines: p.about, kb: kb(p.about), budgetKb: 2 },
    likes: { lines: p.likes, kb: kb(p.likes), budgetKb: 3 },
    rules,
    team: { lines: TEAM_RULES, kb: kb(TEAM_RULES), budgetKb: 3, editable: v.isAdmin },
    company: { lines: COMPANY_LINES, kb: kb(COMPANY_LINES), budgetKb: 3, editable: v.isAdmin },
  };
}

const ENTITY = (name) => ({ name, kind: TOPIC_BY_KEY[keyOf(name)]?.kind || 'topic' });
const aboutAPerson = (f) => f.kind === 'preference' || f.concerns === 'the person themselves' || f.concerns === 'another person';

function privacy(v) {
  // What this person shared from their own chats, one row per fact.
  const sharedFromMe = FACTS.filter((f) => f.scope === 'shared' && f.origin === v.own && !f.replacedById)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .map((f) => ({
      id: f.id, recordId: f.record, ts: f.at, source: RECORD_BY_ID[f.record].source, title: f.title || null, text: f.text, kind: f.kind,
      subject: f.subject || (f.names || [])[0] || null, concerns: f.concerns || 'a company or project', aboutPerson: aboutAPerson(f),
      entities: (f.names || []).map(ENTITY),
    }));
  return {
    ok: true, teamMode: true, mode: 'ask', rules: SHARING_RULES[v.slug], asks: ASKS[v.slug],
    sharedFromMe, hidden: [], erased: ERASED[v.slug], mentionedAt: null,
  };
}

function changes(v) {
  const since = NOW - 14 * 86400_000;
  const items = [];
  for (const r of RECORDS) {
    if (!canRead(v, r.scope) || Date.parse(recTs(r)) < since) continue;
    const mineRec = isOwned(v, r);
    const fs = FACTS.filter((f) => f.record === r.id && canRead(v, f.scope));
    const titles = fs.map((f) => f.title).filter(Boolean);
    const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
    if (r.meeting) {
      items.push({ ts: fs[0]?.at || recTs(r), op: 'import', scope: whereOf(r.scope), by: mineRec ? 'you' : null, label: 'Imported a meeting from Granola', preview: r.meeting.title, detail: `${plural(r.messages.length, 'excerpt')}, ${plural(fs.length, 'fact')}` });
    } else if (r.origin && r.origin !== v.own && r.scope === 'shared') {
      // Someone else's conversation reaches this person only as what they shared.
      items.push({ ts: recTs(r), op: 'share', scope: 'shared', by: PEOPLE[r.origin.slice(5)]?.name || null, label: 'Shared with the team', preview: titles.join(' · ') || null, recordId: r.id, undo: null });
    } else {
      const shared = r.scope === 'shared' && r.origin === v.own;
      const asked = (ASKS[v.slug] || []).some((a) => fs.some((f) => f.title === a.fact?.title));
      const nRules = (r.rules || []).length;
      items.push({
        ts: recTs(r), op: 'file', scope: whereOf(r.scope), by: mineRec ? 'you' : null, label: 'Remembered a conversation',
        detail: `${plural(1, 'excerpt')}, ${plural(fs.length, 'fact')}${nRules ? `, ${plural(nRules, 'rule')}` : ''}${shared ? ', part shared with the team' : ''}${asked ? ', a question for you' : ''}`,
        preview: titles.join(' · ') || null, source: r.source,
      });
    }
  }
  if (v.slug === 'nora') {
    items.push({ ts: ts(-13, '18:20'), op: 'source', scope: 'private', by: 'you', label: 'Switched on Granola as a memory source' });
    items.push({ ts: ts(-3, '08:05'), op: 'keep_private', scope: 'private', by: 'you', label: 'Kept private' });
  } else {
    items.push({ ts: ts(-5, '17:40'), op: 'keep_private', scope: 'private', by: 'you', label: 'Kept private' });
  }
  items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  return { ok: true, days: 14, items };
}

function sources(v) {
  const dayAgo = NOW - 86400_000;
  const own = RECORDS.filter((r) => r.scope === v.own && Date.parse(recTs(r)) >= dayAgo);
  const sum = (src) => {
    const rs = own.filter((r) => r.source === src);
    return { records: rs.length, facts: rs.reduce((n, r) => n + r.facts.length, 0) };
  };
  const builtin = [
    { id: 'web', label: 'Web chat', what: 'every conversation here, once it has gone quiet', ...sum('web') },
    { id: 'telegram', label: 'Telegram', what: 'every conversation with me on Telegram, once it has gone quiet', ...sum('telegram') },
  ];
  const connected = v.slug === 'nora'
    ? [{ ...GRANOLA, kind: 'meetings', what: MEETING_WHAT, on: true, lastRun: ts(0, '02:04'), lastItems: 0, lastFacts: 0, lastError: null, cursor: ts(-3, '02:04') }]
    : [];
  const available = Object.values(v.slug === 'nora' ? MEETING_SOURCES : { granola: GRANOLA, ...MEETING_SOURCES })
    .map((s) => ({ ...s, kind: 'meetings', what: MEETING_WHAT }));
  return { ok: true, hour: 2, items: connected, builtin, available };
}

function routines(v) {
  const created = ts(-21, '09:00');
  return {
    ok: true, mode: 'on',
    routines: ROUTINES[v.slug].map((r) => ({ ...r, retired: false, source: 'bot', createdAt: created, updatedAt: created })),
    unparsed: [],
  };
}

/* ────────────────────────────── search ────────────────────────────── */

const words = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9€]+/).filter((w) => w.length > 2);
const near = (a, b) => a === b || (a.length > 3 && b.startsWith(a)) || (b.length > 3 && a.startsWith(b));

/** GET /memory/v4/search?q= for one viewer: topics, facts and conversation hits, best first. */
export function searchFor(who, q) {
  const v = viewerOf(who);
  const query = String(q || '').trim();
  if (!query) return { ok: true, total: 0, topics: [], facts: [], hits: [] };
  const qw = words(query);
  const hitsOn = (text) => qw.filter((w) => words(text).some((x) => near(w, x))).length;
  const topicsHit = topicStats(v).filter(({ t }) => hitsOn(t.name) > 0)
    .map(({ t, facts }) => ({ name: t.name, key: t.key, kind: t.kind, aliases: [], n: facts.length }));
  const facts = factItems(v, { history: false })
    .map((f) => ({ f, s: hitsOn(`${f.text} ${f.updates.map((u) => u.text).join(' ')} ${f.names.join(' ')}`) + hitsOn(f.title || '') }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s || (a.f.ts < b.f.ts ? 1 : -1)).slice(0, 40).map((x) => x.f);
  const hits = RECORDS.filter((r) => canRead(v, r.scope))
    .map((r) => ({ r, s: hitsOn(r.messages.map((m) => m[1]).join(' ')) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 10)
    .map(({ r }) => ({ id: r.id, ts: recTs(r), source: r.source, scope: whereOf(r.scope), messages: messagesOf(r), notes: notesOf(v, r) }));
  return { ok: true, total: hits.length, topics: topicsHit, facts, hits };
}

/* ────────────────────────────── the API, per viewer ────────────────────────────── */

/**
 * Every memory response the demo serves for one viewer ('admin' = Nora, the
 * founder; 'member' = Mara), keyed by API path without the leading /api.
 * Search is a function of the query: searchFor(viewer, q).
 */
export function memoryFor(who) {
  const v = viewerOf(who);
  const all = factItems(v, { history: true });
  const current = all.filter((f) => !f.past);
  const out = {
    '/memory/v4/overview': overview(v),
    '/memory/v4/facts': { ok: true, total: current.length, items: current.slice(0, 200) },
    '/memory/v4/facts?history=1&limit=500': { ok: true, total: all.length, items: all.slice(0, 500) },
    '/memory/v4/facts?limit=1': { ok: true, total: current.length, items: current.slice(0, 1) },
    '/memory/v4/topics': topics(v),
    '/memory/v4/prefs': prefs(v),
    '/memory/v4/privacy': privacy(v),
    '/memory/v4/changes': changes(v),
    '/memory/v4/sources': sources(v),
    '/routines': routines(v),
  };
  for (const stat of topicStats(v)) {
    const tl = timeline(v, stat);
    out[`/memory/v4/topics/${stat.t.key}/timeline`] = tl;
    out[`/memory/v4/topics/${stat.t.key}/timeline?all=1`] = tl;
  }
  for (const r of RECORDS) if (canRead(v, r.scope)) out[`/memory/v4/records/${r.id}`] = record(v, r);
  // One ready-made search, as the fixture had; any other query goes through searchFor.
  out['/memory/v4/search?q=Brewline'] = searchFor(who, 'Brewline');
  return out;
}
