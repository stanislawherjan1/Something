// The demo workspace: Saltmarsh Ceramics' files, chats, board, reminders,
// notifications, skills, integrations and branding. Everything is invented and
// every date is relative to the day the page is opened (see ../time.js), so
// "yesterday at 14:20" is always yesterday.
//
// Figures agree across files and chats: if you change a price, a stock count
// or a conversion rate here, change it everywhere it appears.

import { at, day, inMinutes, nextWeekday } from '../time.js';

// The Ember shoot: the next Thursday after today (memory uses the same day).
const SHOOT = nextWeekday(4);
import { PEOPLE, COMPANY, BOT } from './cast.js';

// ── Date helpers for prose ──────────────────────────────────────────────────
// Dates in documents read like a person wrote them: "14 Oct". No weekday
// names on relative dates (the demo can be opened on any day of the week).
const nice = (n) => new Date(`${day(n)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const monthName = (offset) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset);
  return d.toLocaleDateString('en-GB', { month: 'long' });
};
const NEXT_MONTH = monthName(1);
const ago = (min) => inMinutes(-min);
const BASE = (import.meta.env?.BASE_URL ?? '/');
const P = '/home/coder/project/';   // chat replies link files by absolute path → file chips

// ── Files ───────────────────────────────────────────────────────────────────

const FILE_PATHS = [
  'Products/catalog.md',
  'Products/pricing.md',
  'Products/ember-launch-plan.md',
  'Products/copy/tide-mug-set.md',
  'Products/copy/breakfast-bundle.md',
  'Products/copy/ember-collection.md',
  'Wholesale/brewline-cafes.md',
  'Wholesale/price-list.md',
  'Wholesale/cafe-demo-plan.md',
  'Suppliers/ostra-clay.md',
  'Suppliers/boxwell-packaging.md',
  'Marketing/newsletter-this-week.md',
  'Marketing/ad-plan-autumn.md',
  'Marketing/brand-voice.md',
  'Marketing/shoot-brief-ember.md',
  'Reports/weekly-sales.md',
  'Reports/ember-campaign.md',
  'Studio/kiln-schedule.md',
  'Studio/stock-count.md',
  'users/nora/investor-prep.md',
  'users/nora/hiring-thoughts.md',
  'users/mara/newsletter-ideas.md',
  'users/mara/notes.md',
];

/** Flat tree, dirs included (parents before children). Private trees live under users/<slug>/. */
export const FILES = (() => {
  const out = [];
  const seen = new Set();
  for (const p of FILE_PATHS) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!seen.has(dir)) { seen.add(dir); out.push({ path: dir, type: 'dir', name: parts[i - 1] }); }
    }
    out.push({ path: p, type: 'file', name: parts.at(-1) });
  }
  return out;
})();

export const FILE_CONTENT = {
  'Products/catalog.md': `# Catalog

Everything we sell online, at the markets and (where marked) wholesale. Stock figures are from Lena's count on ${nice(-3)}; the live numbers are in Shopify.

## Core range

| Product | SKU | Price | What it is | Stock |
|---|---|---|---|---|
| Tide Mug Set | SM-TIDE-4 | €48 | Four 300 ml mugs, blue-grey tide glaze | 21 sets |
| Harbour Bowl | SM-HARB | €22 | 16 cm bowl, cereal to ramen | 71 |
| Speckle Dinner Plate | SM-SPEC | €26 | 27 cm plate, oatmeal speckle | 48 |
| Pour-over Set | SM-POUR | €64 | Dripper + 600 ml carafe | 17 sets |

## Ember collection (launched ${nice(-12)})

A warm iron-red glaze that breaks to amber on the rims. Fired in small batches, so every piece is a little different.

| Product | SKU | Price | Stock |
|---|---|---|---|
| Ember Mug | SM-EMB-MUG | €18 | 50 |
| Ember Bowl | SM-EMB-BWL | €24 | 34 |
| Ember Plate | SM-EMB-PLT | €30 | 22 |

## Bundles

| Product | SKU | Price | Contents | Status |
|---|---|---|---|---|
| Breakfast Bundle | SM-BFB | €79 | 2 Tide mugs + 2 Harbour Bowls, gift-boxed | Launches in this week's newsletter; 30 packed |

## Wholesale only

- **Tide mug, single** — sold to cafés by the piece (see Wholesale/price-list.md)
- **Pour-over dripper, single** — cafés buy the dripper without the carafe

## Notes

- Every piece is food-safe, dishwasher-safe and made in our Lisbon studio.
- Seconds (small glaze flaws) go to the markets only, never online.
- Product copy lives in Products/copy/, one file per product page.
`,

  'Products/pricing.md': `# Pricing

The prices on the shop, the floors we never go under, and the shipping rules. Locked: changes go through Nora.

## Retail prices

| Product | Price | Floor | Unit cost | Margin at list |
|---|---|---|---|---|
| Tide Mug Set (4) | €48 | **€39** | €14.20 | 70% |
| Harbour Bowl | €22 | €18 | €6.40 | 71% |
| Speckle Dinner Plate | €26 | €21 | €7.90 | 70% |
| Pour-over Set | €64 | €52 | €19.50 | 70% |
| Ember Mug | €18 | €15 | €5.10 | 72% |
| Ember Bowl | €24 | €20 | €7.00 | 71% |
| Ember Plate | €30 | €25 | €8.80 | 71% |
| Breakfast Bundle | €79 | €69 | €24.10 | 69% |

## Rules

- **Never discount the Tide Mug Set below €39**, in any channel, for any campaign. It is the product people judge us by.
- Discounts are for the newsletter list and the markets, not for ads.
- The Breakfast Bundle is a gift product, not a discount: it is priced for the box and the pairing, and the copy never says "save".
- Wholesale prices are in Wholesale/price-list.md and are never shown on the shop.

## Shipping (Portugal and EU)

| Basket | Shipping | Since |
|---|---|---|
| Under €50 | €4.90 | spring |
| €50 and over | free | spring |

> **Pending decision.** Yesterday at 14:20 the under-€50 rate was changed to €9 in Shopify. Checkout conversion fell from 3.1% to 1.9% the same day. Rollback is on Nora's board. The new pricing page shows €4.90 and can't be signed off until this is decided.

## The pricing page

The shop's new "Prices & shipping" page goes live with the Breakfast Bundle. Checklist before sign-off:

- [x] Bundle price and contents match the catalog
- [x] Floors removed from the public version
- [ ] Shipping line matches the rule actually live in Shopify
- [ ] Nora's sign-off (Mara's newsletter review is waiting on it)
`,

  'Wholesale/cafe-demo-plan.md': `# Café buyers demo

Owner: Nora, with Tom. Tuesday ${nice(-3)}, 10:00 at the studio. Goal: two cafés on a standing order before the winter menu.

## Who's coming

| Buyer | Café | Wants to see |
|---|---|---|
| Ines | Brewline Cafés, 6 sites | Tide mugs in volume |
| Sam | Field & Flour | A glaze with their logo |
| Rosa | Harbour Roasters | Delivery to two sites |
| Jamie | Little Kiln Café | A sample set |

## Running order

| Time | What | Who |
|---|---|---|
| 10:00 | The studio and the kiln | Lena |
| 10:20 | The range, with wholesale prices | Tom |
| 10:45 | Custom glazes and lead times | Nora |
`,

  'Products/ember-launch-plan.md': `# Ember launch plan

Owner: Leo (ads), with Ivy (content) and Mara (newsletter). Launched ${nice(-12)}; the paid push runs four weeks, to ${nice(16)}.

## Goal

Sell through the first two kiln batches (about 300 pieces) in four weeks without discounting, and find out whether the Ember glaze earns a permanent place in the range.

## Timeline

| When | What | Who | Status |
|---|---|---|---|
| ${nice(-14)} | Pack shots in the studio | Ivy | Done |
| ${nice(-12)} | Shop pages live, Meta + Google Ads on | Leo | Done |
| ${nice(-12)} | Newsletter announcement | Mara | Done (open rate 48%) |
| ${nice(1)} | Week-two mention in the newsletter | Mara | Drafted |
| ${nice(4)} | Third Ember glaze firing (60 mugs) | Lena | Scheduled |
| ${nice(SHOOT)} | Lifestyle shoot with Paula Reyes | Ivy | Booked |
| ${nice(SHOOT + 2)} | New creatives from the shoot into ads | Leo | Planned |
| ${nice(16)} | Paid push ends; keep-or-retire decision | Nora | — |

## Budget

| Channel | Four weeks | Spent so far |
|---|---|---|
| Meta Ads | €1,200 | €560 |
| Google Ads | €800 | €330 |
| **Total** | **€2,000** | **€890** |

## How we'll judge it

- Blended ROAS of 3.0 or better over the four weeks (currently 3.2, see Reports/ember-campaign.md)
- At least 70% of the first two batches sold by ${nice(16)}
- Return rate under 3%

## Risks

- Ember mugs sell about 4 a day; the third firing has to land on ${nice(4)} or the mug sells out mid-campaign.
- Iron-red glazes vary batch to batch. Copy says so; photos must show the range, not one perfect piece.
`,

  'Products/copy/tide-mug-set.md': `# Tide Mug Set — product page

**Price:** €48 for four · **SKU:** SM-TIDE-4

## Headline

Four mugs the colour of low tide.

## Short description

A set of four 300 ml stoneware mugs in our blue-grey tide glaze, thrown and glazed by hand in Lisbon. Heavy enough to feel solid, light enough for the second coffee.

## Long description

The tide glaze pools darker where the mug curves and thins to pale grey on the rim, so no two mugs in a set are quite the same. The handle fits three fingers. The base is left raw so you can feel the clay.

They're the same mugs nine Brewline cafés pour their flat whites into every day, so they're built for the dishwasher and the busy morning.

## Details

- Four mugs, 300 ml each, 9.5 cm tall
- Stoneware, fired to 1,240 °C
- Dishwasher and microwave safe
- Made in our studio in Lisbon
- Each mug is unique: glaze and size vary slightly

## Care

Dishwasher is fine. Avoid sudden temperature jumps (straight from the freezer into a hot oven, for example).

## SEO

- Title: Tide Mug Set — four handmade stoneware mugs | Saltmarsh Ceramics
- Meta description: Four handmade 300 ml stoneware mugs in a blue-grey tide glaze. Made in Lisbon, dishwasher safe. €48 for the set.
`,

  'Products/copy/breakfast-bundle.md': `# Breakfast Bundle — product page

**Price:** €79 · **SKU:** SM-BFB · **Launches:** in this week's newsletter (${nice(1)})

## Headline

Breakfast for two, in a box.

## Short description

Two Tide mugs and two Harbour Bowls, packed in our gift box with a handwritten card. The slow-morning set, ready to give.

## Long description

We put together the two pieces people buy for each other most: the Tide mug for coffee, the Harbour Bowl for everything else. They come nested in a recycled-card gift box, wrapped in tissue, with a card you can write on (or we can, just tell us at checkout).

## What's in the box

- 2 Tide mugs, 300 ml, blue-grey tide glaze
- 2 Harbour Bowls, 16 cm
- Gift box, tissue and a card

## Notes for whoever edits this

- It's a gift product. Never say "save" or compare it to buying the pieces separately (see Products/pricing.md).
- Ships free: the bundle is over the €50 threshold.
- 30 bundles are packed for launch. Lena can pack 15 more a day from shelf stock.

## SEO

- Title: Breakfast Bundle — handmade mugs and bowls gift set | Saltmarsh Ceramics
- Meta description: Two handmade Tide mugs and two Harbour Bowls in a gift box. Made in Lisbon. €79, free shipping.
`,

  'Products/copy/ember-collection.md': `# Ember collection — collection page

**Launched:** ${nice(-12)} · Mug €18 · Bowl €24 · Plate €30

## Headline

Ember: fired red, cooled to amber.

## Intro

Our first new glaze in two years. Iron-rich and fired hot, it comes out of the kiln a deep red that breaks to amber wherever the glaze runs thin, on rims, handles and edges. It's a glaze that refuses to be uniform, so we stopped trying.

## Per-product lines

**Ember Mug — €18**
A 300 ml mug with the amber break on the rim and handle. The one people pick up first at the market.

**Ember Bowl — €24**
16 cm, for soup, salad or a pile of clementines. The red pools darkest in the well.

**Ember Plate — €30**
A 24 cm side plate. Looks best with something green on it.

## The honest bit (keep this on the page)

Every Ember piece is different. Some are redder, some show more amber, a few have tiny dark speckles where the iron came through. The photos show a range of real pieces, not one perfect one.

## Details

- Stoneware, fired to 1,260 °C
- Dishwasher safe; the glaze is food-safe and lab-tested
- Small batches of about 150 pieces

## Ad copy (Leo's variants, in use)

1. Fired red, cooled to amber. The Ember collection, handmade in Lisbon.
2. No two alike. Ember mugs from €18.
3. The mug people pick up first. Ember, out now.
`,

  'Wholesale/brewline-cafes.md': `# Brewline Cafés

Our biggest wholesale account. Owner: Tom.

## The account

| | |
|---|---|
| Locations | 9 cafés (6 in Lisbon, 3 in Porto) |
| Contact | Sofia Marques, operations lead |
| Orders | Every six weeks, by email to Tom |
| Terms | 30 days; they pay in about 24 |
| Share of wholesale | About 23% of our wholesale revenue |
| Since | Two years |

## Order history

| Date | Tide mugs | Pour-over drippers | Total (ex VAT) | Paid |
|---|---|---|---|---|
| ${nice(-37)} | 240 | 60 | €3,000 | in 24 days |
| ${nice(-79)} | 216 | 48 | €2,604 | in 26 days |
| ${nice(-121)} | 240 | 36 | €2,616 | in 22 days |

Prices on the last order: Tide mug €8.50 each, dripper €16 each (see Wholesale/price-list.md).

## Next order

- **Due:** around ${nice(5)} (six weeks after the last one)
- **Expect:** the same as last time, 240 mugs + 60 drippers. Sofia mentioned a tenth café opening in the new year, so the order after this one may grow.
- **Stock:** 86 loose Tide mugs on the shelf; two extra glaze firings (120 each) land ${nice(1)} and ${nice(3)}. Drippers: 40 on the shelf + 24 from the ${nice(2)} firing. See Studio/kiln-schedule.md.

## How they like it

- One delivery per city, not per café. Tom splits the boxes by location (labels by café name).
- Mugs packed in sixes, drippers in fours.
- Invoice to the head office, never to a café.
- They want a heads-up a week ahead if anything will be short.

## Prep checklist (Tom)

- [ ] Confirm quantities with Sofia
- [ ] Check the kiln plan covers 240 mugs + 60 drippers
- [ ] Draft the order confirmation
- [ ] Book the two courier pickups (Lisbon, Porto)
- [ ] Invoice from Stripe the day it ships
`,

  'Wholesale/price-list.md': `# Wholesale price list

For cafés, restaurants and shops. Prices ex VAT, delivered in mainland Portugal. Locked: changes go through Nora.

## Prices

| Item | Price | Minimum | Pack |
|---|---|---|---|
| Tide mug, 300 ml | €8.50 | 48 | sixes |
| Pour-over dripper | €16.00 | 12 | fours |
| Harbour Bowl | €11.00 | 24 | sixes |
| Speckle Dinner Plate | €13.00 | 24 | sixes |
| Ember Mug | €10.00 | 24 | sixes |

## Volume

- 300+ pieces in one order: 5% off the whole order.
- Standing reorder (every 4–8 weeks, agreed in writing): prices held for 12 months.

## Terms

- Payment: 30 days from invoice.
- Delivery: 10 working days from confirmation, or sooner if we have the stock.
- Breakage in transit: photo within 48 hours and we replace it on the next delivery.
- Seconds are never sold wholesale.

## Lead times we can promise

| Order size | Lead time |
|---|---|
| Up to 120 pieces | 5 working days |
| 120–300 pieces | 10 working days |
| 300+ pieces | agree with Lena first (kiln time) |

## Who's on it

| Account | Owner | Cadence |
|---|---|---|
| Brewline Cafés (9) | Tom | every 6 weeks |
| Cais Bakery | Tom | monthly |
| Two small shops in Porto | Tom | ad hoc |
`,

  'Suppliers/ostra-clay.md': `# Ostra Clay Supply

Our stoneware clay and most glaze materials. Owner: Jonas.

## Contacts

| Who | What |
|---|---|
| Rui | Sales, orders and anything about the clay itself |
| Rita | Accounts; sends the payment reminders |

## Open: invoice OC-2291

| | |
|---|---|
| Issued | ${nice(-36)} |
| Due | ${nice(-6)} (**6 days overdue**) |
| Amount | €2,860 |
| Status | **On hold** until the credit note arrives |

What's on it:

| Line | Amount |
|---|---|
| 48 bags stoneware clay, 25 kg, at €45 | €2,160 |
| Glaze materials (iron oxide, feldspar, kaolin) | €520 |
| Delivery | €180 |
| **Total** | **€2,860** |

### The damaged pallet

One pallet arrived with 8 bags split and soaked, unusable. Photos sent to Rui the same day. He agreed a credit note for the 8 bags (**€360**) on the phone. It hasn't been issued yet.

### What we're doing

- Holding payment until the credit note arrives, then paying the balance: **€2,500**.
- Jonas has chased Rui twice (${nice(-9)} and ${nice(-4)}).
- Rita sent a second payment reminder this morning. A reply explaining the hold is drafted and waiting for Nora's yes.

## Ordering

- Lead time: 5 working days.
- We order about 50 bags every five weeks; next order around ${nice(10)}.
- Ask for the clay to be palletised in shrink-wrap (the split bags came on an unwrapped pallet).

## History

- Reliable for three years, always on time. This is the first damaged delivery.
`,

  'Suppliers/boxwell-packaging.md': `# Boxwell Packaging

Our mailer boxes, gift boxes and paper void fill. Owner: Jonas.

## Price increase from 1 ${NEXT_MONTH}

Boxwell wrote on ${nice(-8)}: prices go up **8%** from 1 ${NEXT_MONTH} (card and energy costs).

| Item | Now | From 1 ${NEXT_MONTH} | We use / month |
|---|---|---|---|
| Small mailer (mugs, bowls) | €1.15 | €1.24 | 650 |
| Large mailer (sets, plates) | €1.60 | €1.73 | 220 |
| Gift box (Breakfast Bundle) | €2.40 | €2.59 | ~60 at launch |
| Paper void fill, 10 kg | €18.00 | €19.44 | 3 |

**What it costs us:** about **€90 a month** more.

## Options

1. **Order three months ahead at today's price** before 1 ${NEXT_MONTH}. Saves about €270; needs shelf space in the back room (Lena says yes, if it's on two pallets).
2. Get a quote from a second supplier for the small mailers only.
3. Pass it on in shipping. (Tried yesterday: under-€50 shipping went to €9 and checkout conversion dropped from 3.1% to 1.9%. Not this.)

Recommendation: option 1 now, option 2 in the new year.

## Ordering

- Lead time: 7 working days.
- Minimum order: 500 mailers.
- Contact: Daniel, account manager. Prefers email.

## Notes

- Gift box print run takes 10 days; reorder when we're down to 40.
- They take back the pallets on the next delivery.
`,

  'Marketing/newsletter-this-week.md': `# Newsletter — this week

**Goes out:** ${nice(1)}, 08:00 · **List:** 4,860 subscribers · **Owner:** Mara · **Status:** drafted, review waiting on the pricing page sign-off

## Subject line (A/B test)

- A: Breakfast for two, in a box
- B: The slow-morning set is here

## Preheader

Two mugs, two bowls, one gift box. Plus week two of Ember.

---

## 1. The Breakfast Bundle

Two Tide mugs and two Harbour Bowls, nested in our gift box with a card you can write on. It's the pairing people buy for each other most, so we boxed it.

**€79, ships free.** → Shop the Breakfast Bundle

(Links to the bundle page and to the new "Prices & shipping" page.)

## 2. Ember, week two

The iron-red glaze went out twelve days ago and the mugs are going fastest. Lena has another firing in the kiln next week, so if your colour of choice is gone, it's coming back.

→ See the Ember collection

## 3. From the studio

Two extra Tide firings this week, both for a café order. The kiln has barely cooled.

See you at the winter market. Dates in next week's issue.

---

## What shipped this week (for the draft)

- Breakfast Bundle page built, 30 bundles packed
- Ember: 48 mugs, 22 bowls and 14 plates sold since launch
- Two Tide glaze firings for Brewline

## Review checklist

- [x] Prices match Products/pricing.md
- [x] No "save" language on the bundle
- [ ] Pricing page signed off (Nora)
- [ ] Links tested
- [ ] Final read by Mara
`,

  'Marketing/ad-plan-autumn.md': `# Ad plan — autumn

Owner: Leo. Runs from the Ember launch (${nice(-12)}) to the winter market.

## Budget

| Campaign | Channel | Budget | Period |
|---|---|---|---|
| Ember launch | Meta Ads | €1,200 | 4 weeks |
| Ember launch | Google Ads (Shopping + Search) | €800 | 4 weeks |
| Breakfast Bundle — gifting | Meta Ads | €600 | from ${nice(1)}, 3 weeks |
| Always-on brand search | Google Ads | €150 / month | ongoing |

Leo also owns the spring campaign budget; the draft is due ${nice(21)}.

## Audiences

- **Ember:** lookalike of past buyers (1%), interest in ceramics, slow living, specialty coffee; Lisbon and Porto first, then the EU.
- **Bundle:** gift buyers 25–55, retargeting of everyone who viewed a Tide mug or Harbour Bowl in the last 30 days.
- **Exclude:** wholesale contacts, last-7-day buyers.

## Creative

| Ad | Format | Status |
|---|---|---|
| "Kiln glow" — opening the kiln | Reel, 12 s | Live, best performer |
| Ember range on the table | Carousel | Live |
| No two alike | Static | Live, fatiguing |
| Lifestyle (from the ${nice(SHOOT)} shoot) | Reel + static | Planned for ${nice(SHOOT + 2)} |

## Rules

- No discount codes in ads. Ever. Discounts are for the list.
- Never show the Tide Mug Set under €39.
- Pause any ad set below ROAS 1.5 after €100 spend.

## Weekly check (Leo, Mondays)

- Spend vs. pacing per campaign
- ROAS by ad set; pause the losers
- Frequency over 3 → rotate creative
- Numbers go into Reports/ember-campaign.md
`,

  'Marketing/brand-voice.md': `# Brand voice

How Saltmarsh sounds, everywhere: the shop, the newsletter, ads, replies to customers. Locked: changes go through Nora.

## In one line

A potter talking about her work to someone she likes: warm, plain, a little dry.

## We are

- **Tactile.** We describe how a thing feels and behaves: heavy in the hand, cool on the lip, pools darker in the curve.
- **Plain.** Short sentences. Ordinary words. No "elevate", "curated", "artisanal", "luxurious".
- **Honest.** Handmade means variation; we say so before anyone asks.
- **Specific.** 300 ml, 16 cm, 1,240 °C. Numbers beat adjectives.

## We are not

- Salesy. No countdowns, no "only 3 left!" unless it's literally true and useful.
- Precious. It's a mug. A good one.
- Cute. One joke per newsletter, maximum.

## Words

| Use | Avoid |
|---|---|
| handmade, thrown, glazed | artisanal, crafted |
| mug, bowl, plate | drinkware, tableware solutions |
| ships free | FREE SHIPPING!!! |
| every piece is different | imperfections |

## Examples

**Good:** "The tide glaze pools darker where the mug curves and thins to pale grey on the rim."

**Not us:** "Elevate your morning ritual with our artisanal, ocean-inspired drinkware."

## Replying to customers

- First name, no "Dear".
- Say what we'll do and by when.
- A broken piece in transit: apologise once, replace it, don't ask for it back.
`,

  'Marketing/shoot-brief-ember.md': `# Shoot brief — Ember lifestyle

**When:** ${nice(SHOOT)}, 09:00–15:00 · **Where:** the studio + Nora's kitchen · **Photographer:** Paula Reyes · **Owner:** Ivy

## Why

The Ember pack shots are clean but cold. Ads need the glaze in use: morning light, food, hands. These replace the fatiguing "No two alike" static from ${nice(SHOOT + 2)}.

## Shot list

| # | Shot | Format | For |
|---|---|---|---|
| 1 | Hands around an Ember mug, steam, window light | 4:5 + 9:16 | Meta, newsletter |
| 2 | Ember bowl with soup, linen, top-down | 1:1 | Shop, Meta |
| 3 | Three mugs side by side showing the colour range | 4:5 | Collection page |
| 4 | Ember plate with figs or something green | 1:1 | Shop |
| 5 | Kiln opening, red glow (repeat of the reel, better light) | 9:16 video, 15 s | Reels |
| 6 | Breakfast table: Ember + Tide together | 16:9 | Newsletter header |
| 7 | Close-up of the amber break on a rim | 1:1 | Ads, macro |

## Look

- Natural light only. No styling props with logos.
- Show variation: at least one redder and one more amber piece in every group shot.
- Warm, not orange. Paula has the colour reference from the pack shots.

## Bring

- [ ] 6 Ember mugs, 4 bowls, 3 plates (pick from the third firing, ${nice(4)})
- [ ] 2 Tide mugs, 2 Harbour Bowls for shot 6
- [ ] Linen, wooden board, fresh figs, bread
- [ ] Lena on standby 11:00 for the kiln shot

## After

- Selects to Ivy by ${nice(SHOOT + 1)}, finals by ${nice(SHOOT + 2)}
- Leo picks two for ads; Mara gets shot 6 for the newsletter header
- Usage: web, social, ads and print for two years (agreed with Paula)
`,

  'Reports/weekly-sales.md': `# Weekly sales

Last seven days, ${nice(-7)} to ${nice(-1)}. Shopify (orders, revenue) and GA4 (sessions). Online shop only; wholesale and markets are separate.

## Summary

| | This week | Last week | Change |
|---|---|---|---|
| Revenue | €22,060 | €22,480 | −2% |
| Orders | 379 | 392 | −3% |
| Sessions | 12,945 | 12,880 | +1% |
| Conversion | 2.9% | 3.0% | −0.1 pt |
| Average order | €58 | €57 | +2% |

## By day

| Day | Sessions | Conversion | Orders | Revenue |
|---|---|---|---|---|
| ${nice(-7)} | 1,790 | 3.0% | 54 | €3,110 |
| ${nice(-6)} | 1,860 | 3.2% | 60 | €3,420 |
| ${nice(-5)} | 1,880 | 3.1% | 58 | €3,370 |
| ${nice(-4)} | 1,820 | 3.1% | 56 | €3,250 |
| ${nice(-3)} | 1,905 | 3.0% | 57 | €3,300 |
| ${nice(-2)} | 1,850 | 3.2% | 59 | €3,440 |
| ${nice(-1)} | 1,840 | **1.9%** | **35** | **€2,170** |

## What happened yesterday

Traffic held; checkout didn't. At **14:20** the shipping rate for orders under €50 changed from €4.90 to **€9**. Before 14:20 the day converted at 3.1%; after, 0.7%. Carts abandoned at the shipping step went from 11 (morning) to 47 (afternoon). Rollback is waiting on Nora.

## Top products

| Product | Units | Revenue |
|---|---|---|
| Tide Mug Set | 96 sets | €4,608 |
| Harbour Bowl | 141 | €3,102 |
| Ember Mug | 28 | €504 |
| Pour-over Set | 22 | €1,408 |
| Speckle Dinner Plate | 51 | €1,326 |

## Notes

- Ember is about a fifth of orders since launch; full numbers in Reports/ember-campaign.md.
- Next report: drafted by Aria from Shopify + GA4 on Friday.
`,

  'Reports/ember-campaign.md': `# Ember campaign

Day 12 of 28. Spend and attributed revenue through ${nice(-1)}. Owner: Leo.

## Overall

| | Meta Ads | Google Ads | Total |
|---|---|---|---|
| Budget (4 weeks) | €1,200 | €800 | €2,000 |
| Spent | €560 | €330 | €890 |
| Pacing | on track | slightly under | — |
| Attributed revenue | €1,960 | €860 | €2,820 |
| ROAS | **3.5** | **2.6** | **3.2** |

Attributed revenue counts the whole basket, so it includes Tide mugs and bowls bought alongside Ember.

## Ember units sold since launch

| Product | Sold | Left | Pace |
|---|---|---|---|
| Ember Mug | 48 | 38 | ~4 / day |
| Ember Bowl | 22 | 34 | ~2 / day |
| Ember Plate | 14 | 22 | ~1 / day |

At this pace the mugs run out in about nine days. The third firing (60 mugs, ${nice(4)}) covers it.

## Meta, by ad

| Ad | Spend | CTR | ROAS | Call |
|---|---|---|---|---|
| Kiln glow reel | €260 | 2.4% | 4.6 | Keep, raise budget 20% |
| Range carousel | €190 | 1.6% | 3.1 | Keep |
| No two alike static | €110 | 0.9% | 1.9 | Replace after the shoot |

## Google, by campaign

| Campaign | Spend | ROAS | Note |
|---|---|---|---|
| Shopping — Ember | €240 | 2.9 | Fine |
| Search — "handmade mug" | €90 | 1.8 | Watch; pause under 1.5 |

## Next

- Lifestyle creatives from the ${nice(SHOOT)} shoot go live ${nice(SHOOT + 2)}.
- The shipping change yesterday hit Ember too: Ember mugs alone are under €50.
`,

  'Studio/kiln-schedule.md': `# Kiln schedule

Two kilns: the big one (K1, 1.2 m³) and the test kiln (K2). Owner: Lena. A glaze firing takes a day to fire and a day to cool; unload the morning after next.

## Next seven days

| Load | Kiln | What | Pieces | Unload | For |
|---|---|---|---|---|---|
| ${nice(0)} | K1 | Glaze: Tide mugs | 120 | ${nice(1)} | Brewline |
| ${nice(1)} | K2 | Glaze: pour-over drippers | 24 | ${nice(2)} | Brewline |
| ${nice(1)} | K1 | Glaze: Tide mugs | 120 | ${nice(3)} | Brewline |
| ${nice(3)} | K1 | Glaze: Ember mugs | 60 | ${nice(4)} | Shop (Ember) |
| ${nice(4)} | K1 | Bisque: bowls + plates | ~140 | ${nice(5)} | Shop |
| ${nice(5)} | K2 | Glaze tests: spring colours | 18 tiles | ${nice(6)} | — |

## Brewline check

| | Needed | Shelf | From firings | Total |
|---|---|---|---|---|
| Tide mugs | 240 | 86 | 240 | 326 |
| Drippers | 60 | 40 | 24 | 64 |

Covered, but drippers leave only 4 spare: if a dripper firing has losses over 15%, Tom tells Sofia a week ahead.

## Rules

- Never open K1 above 150 °C. Ember cracks if it cools too fast.
- Ember goes on the middle shelves only (the top runs hot and turns it brown).
- Log every firing: cone, peak temperature, losses.

## Losses this month

| Firing | Loaded | Lost | Why |
|---|---|---|---|
| Ember #1 | 150 | 9 | glaze crawl on bowls |
| Ember #2 | 150 | 6 | two cracked plates, four drips |
| Tide (wholesale) | 240 | 7 | normal |
`,

  'Studio/stock-count.md': `# Stock count

Every Monday morning, before the studio opens. Owner: Lena. Last count: ${nice(-3)}.

## Count

| Item | Count | Reorder at | Status |
|---|---|---|---|
| Tide mugs, loose | 86 | 300 | **Low** (Brewline needs 240) |
| Tide Mug Sets, boxed | 21 | 15 | OK |
| Harbour Bowl | 71 | 30 | OK |
| Speckle Dinner Plate | 48 | 30 | OK |
| Pour-over drippers, loose | 40 | 60 | **Low** |
| Pour-over Sets, boxed | 17 | 10 | OK |
| Ember Mug | 50 | 40 | Watch (selling ~4 / day) |
| Ember Bowl | 34 | 20 | OK |
| Ember Plate | 22 | 15 | OK |
| Breakfast Bundles, packed | 30 | — | Launch stock |
| Seconds (market box) | 64 | — | For the winter market |

## Packaging

| Item | Count | Reorder at |
|---|---|---|
| Small mailers | 620 | 400 |
| Large mailers | 210 | 150 |
| Gift boxes | 70 | 40 |
| Void fill (10 kg bags) | 4 | 2 |

## Actions from this count

- [x] Two extra Tide glaze firings booked (see Studio/kiln-schedule.md)
- [x] Dripper firing moved up to ${nice(1)}
- [ ] Ember mug firing on ${nice(4)}; confirm glaze stock with Jonas
- [ ] Shopify inventory updated after the Tide firings unload

## Differences from Shopify

- Harbour Bowl: Shopify said 73, shelf had 71. Two in the breakage box; written off.
- Everything else matched.
`,

  'users/nora/investor-prep.md': `# Investor call — prep

**Today, 10:00** · North Quay Angels, the regular check-in · Private: only Nora sees this file.

## The three numbers they'll ask for

| | Number | vs. last call |
|---|---|---|
| Trailing 12-month revenue | **€412k** | +€19k |
| September revenue | €38.2k | best September yet |
| Gross margin | 61% | flat |

## Revenue mix (trailing 12 months)

| Channel | Revenue | Share |
|---|---|---|
| Online shop | €264k | 64% |
| Wholesale (14 accounts) | €111k | 27% |
| Markets (2 a year) | €37k | 9% |

## What to tell them

1. **Ember launch is working.** Day 12 of 28: €890 spent, €2,820 attributed, ROAS 3.2. Mugs sell about 4 a day.
2. **Wholesale is steady.** Brewline (9 cafés) reorders every six weeks like clockwork, about €3,000 an order; next one in about five days. A tenth café opens in the new year.
3. **Breakfast Bundle launches tomorrow** in the newsletter (4,860 subscribers). Gift product at €79, priced on margin, not discount.

## What they might poke at

- **Yesterday's sales dip.** A shipping change cost about €1,100 in an afternoon; we caught it the same day and it's being rolled back. Lesson: price changes go through one person.
- **Capacity.** The kiln runs at 82%. If asked: thinking about a second potter in spring (not decided, don't commit to a date).
- **Supplier costs.** Boxwell up 8% from 1 ${NEXT_MONTH}, about €90 a month; we're buying three months ahead.

## Cash

- €86k in the bank
- No debt; Ostra invoice (€2,500 after the credit note) is the only overdue payable

## Ask

Nothing this call. Keep them warm for a possible small round tied to the second kiln, next year.
`,

  'users/nora/hiring-thoughts.md': `# Hiring a second potter

Private. Thinking, not decided. Spring at the earliest.

## Why now-ish

- Lena and I throw about 1,400 pieces a month between us. The kiln is at 82% and we're the bottleneck, not it.
- Brewline alone takes 240 mugs every six weeks, and a tenth café is coming.
- Every launch (Ember, the bundle) eats throwing time we'd otherwise spend on the core range.

## What it would cost

| | Per month |
|---|---|
| Salary (gross) | €1,900 |
| Employer costs | ~€450 |
| Clay + glaze for their output | ~€600 |
| **Total** | **~€2,950** |

A second potter adds about 700 pieces a month. At our average wholesale-and-online mix that's roughly €9k of extra revenue a month at full speed, after three months of learning our glazes.

## What has to be true first

- [ ] Ember earns its place (decision ${nice(16)})
- [ ] Two more wholesale accounts the size of Cais Bakery, or Brewline grows
- [ ] Six months of cash runway kept after the hire
- [ ] Lena wants this too, and wants to train them

## Who I'd want

- Throws consistently (sets of four that match)
- Has fired gas or electric kilns to cone 10
- Patient with repetitive work; the wholesale mugs are 70% of the job

## Open questions

- Part-time first (three days)? Cheaper, but harder to train.
- Shared studio day with a ceramics school instead?
- Ask Jonas to model the cash flow before I say anything to the team.
`,

  'users/mara/newsletter-ideas.md': `# Newsletter ideas

Private scratch pad. The good ones graduate into Marketing/newsletter-this-week.md.

## Next few issues

| Issue | Lead | Second | Status |
|---|---|---|---|
| ${nice(1)} | Breakfast Bundle launch | Ember week two | Drafted |
| ${nice(SHOOT + 1)} | Ember lifestyle photos (from Paula's shoot) | Winter market dates | Idea |
| ${nice(15)} | "How a mug is made" in eight photos | Gift guide teaser | Idea |
| ${nice(22)} | Gift guide: under €30, under €60, the big one | — | Idea |

## Ideas bank

- **Meet the kiln.** Lena explains why Ember goes on the middle shelves. Readers love the studio stuff (best click rate last quarter).
- **One mug, three cafés.** Photos of Tide mugs in use at Brewline (ask Tom if Sofia's OK with it).
- **Seconds sale for the list only,** the week before the winter market. Check with Nora; it's a discount, so list-only is fine by the pricing rules.
- **Customer kitchens.** Ask readers to send photos of their Saltmarsh pieces. Small prize: an Ember mug.
- **Care guide** as a short evergreen issue: dishwasher, microwave, what not to do.

## Subject lines that worked

| Subject | Open rate |
|---|---|
| Fired red, cooled to amber | 48% |
| The kiln is open | 51% |
| A mug for the second coffee | 44% |

## Not doing

- Countdown timers. Not us.
- "Last chance" unless it really is.
`,

  'users/mara/notes.md': `# Notes

Private. Mara's working notes.

## This week

- Newsletter goes out tomorrow 08:00. Draft done; review blocked until Nora signs off the pricing page (the bundle section links to it).
- A/B test on the subject line: "Breakfast for two, in a box" vs. "The slow-morning set is here". Aria pulls open rates an hour after send.
- Ask Ivy for one bundle photo on the breakfast table; the pack shot is too plain for the header.

## People

- **Nora:** decisions on prices and anything on the pricing page. Fastest by Telegram before 10:00, after that the web chat.
- **Leo:** wants the newsletter send time a day ahead so he can line up the bundle ads (starting ${nice(1)}).
- **Ivy:** shoot with Paula on ${nice(SHOOT)}. Shot 6 (breakfast table) is for my header.
- **Lena:** can pack 15 more bundles a day if it sells out.

## Numbers to remember

- List: 4,860 subscribers, average open rate 46%, click rate 6.2%
- Best-performing section type: studio stories
- Unsubscribes spike when we send two issues in one week

## Questions for Nora

- [ ] Pricing page: €4.90 or €9 for under-€50 shipping? (Can't finish my review until this is decided.)
- [ ] OK to do a list-only seconds sale before the winter market?
- [ ] Can the gift guide include the Pour-over Set at full price, or do we leave it out?
`,
};

// ── Chat ────────────────────────────────────────────────────────────────────
// A message is { ts, role: 'user'|'assistant', text, tools? }. `tools` is
// [{ id, name, at, ok }] where `at` is the offset in `text` the tools ran at
// (ChatPanel → BodyWithTools / ToolChip.jsx's toolSegments render it as a
// collapsed "Used N tools" in place). Absolute /home/coder/project/... paths
// in text become clickable file chips (ChatPanel linkifyFilePaths → FileChip).

let toolSeq = 0;
const U = (ts, text) => ({ ts, role: 'user', text });
/** An assistant reply; arrays among `parts` are tool names run at that point. */
function A(ts, ...parts) {
  let text = '';
  const tools = [];
  for (const p of parts) {
    if (Array.isArray(p)) for (const name of p) tools.push({ id: `toolu_demo_${++toolSeq}`, name, at: text.length, ok: true });
    else text += p;
  }
  return tools.length ? { ts, role: 'assistant', text, tools } : { ts, role: 'assistant', text };
}

export const HISTORIES = {
  // (1) What needs me today?
  'nora-today': [
    U(ago(52), 'What needs me today?'),
    A(ago(51),
      ['mcp__gcalendar__list_events', 'mcp__email__search', 'mcp__tasks__list_tasks', 'Read'],
      `Three things need you today, in order:

**1. Investor call at 10:00.** North Quay Angels, the regular check-in. Your prep is in ${P}users/nora/investor-prep.md, updated this morning: trailing-12-month revenue (€412k), the Ember numbers and the Brewline account.

**2. Ostra invoice OC-2291 is 6 days overdue.** Rita from their accounts sent a second reminder at 07:52. We're holding payment until the credit note for the damaged pallet arrives (8 bags, €360); Jonas has chased Rui twice. I've drafted a reply that says exactly that and offers to pay the €2,500 balance the day the credit note lands. It's waiting for your yes.

**3. Mara's review is blocked on you.** She can't finish reviewing tomorrow's newsletter until you sign off the new pricing page, because the Breakfast Bundle section links to it.

| | When | Waiting on |
|---|---|---|
| Investor call | 10:00 | you |
| Reply to Ostra | today | your yes |
| Pricing page sign-off | before Mara's review this afternoon | you |

One more on your board, not urgent this morning: yesterday's shipping change. Checkout conversion dropped after it; I can walk you through it whenever you want.`),
    U(ago(47), 'What exactly is stopping the pricing page?'),
    A(ago(46),
      ['Read'],
      `One line. The page says shipping under €50 is **€4.90**, but since yesterday at 14:20 Shopify charges **€9**. Everything else on the checklist in ${P}Products/pricing.md is done:

- [x] Bundle price and contents match the catalog (€79, 2 Tide mugs + 2 Harbour Bowls)
- [x] Floors removed from the public version
- [ ] Shipping line matches the rule live in Shopify
- [ ] Your sign-off

So it comes down to the shipping decision. If you roll the rule back, the page is right as it stands and you can sign it off straight away. I'll tell Mara the moment you do.`),
    U(ago(41), 'Ok. Show me the Ostra reply first.'),
    A(ago(40),
      ['mcp__email__read_message'],
      `Here's the draft, as a reply to Rita's reminder:

> **To:** Rita, Ostra Clay Supply accounts
> **Cc:** Jonas
> **Subject:** Re: Payment reminder, invoice OC-2291
>
> Hi Rita,
>
> Thanks for the reminder. We're holding OC-2291 until the credit note for the damaged pallet comes through: 8 bags arrived split and soaked, and Rui agreed a credit of €360 on the phone. Photos went to him the same day.
>
> As soon as the credit note arrives we'll pay the balance of €2,500, the same day. If it helps, Rui can send it straight to Jonas.
>
> Best,
> Nora

It's polite, it doesn't argue, and it puts the next step on their side. Say the word and I'll send it with Jonas in cc.`),
  ],

  // (2) Why did sales drop yesterday?
  'nora-sales-drop': [
    U(ago(130), 'Why did sales drop yesterday?'),
    A(ago(129),
      ['mcp__shopify__get_sales_summary', 'mcp__ga4__run_report', 'mcp__shopify__get_orders'],
      `Traffic held; checkout didn't.

| | Last 6 days (avg) | Yesterday |
|---|---|---|
| Sessions | 1,850 | 1,840 |
| Checkout conversion | 3.1% | **1.9%** |
| Orders | 57 | 35 |
| Revenue | €3,315 | €2,170 |

The drop starts at **14:20**. That's when the shipping rule changed in Shopify: orders under €50 now pay **€9** (it was €4.90). Before 14:20 the day converted at 3.1%; after, 0.7%. Carts abandoned at the shipping step went from 11 in the morning to 47 in the afternoon.

The orders that disappeared are the small ones: a single Harbour Bowl, one Tide Mug Set, an Ember mug. Exactly the under-€50 baskets.

The change came from Jonas's admin login. My guess is it was meant to cover Boxwell's 8% box increase, but that's his to confirm.

I can roll the rule back to €4.90 now. It's one setting in Shopify and takes effect immediately. Want me to?`),
    U(ago(122), 'Hold on. What would the €9 rule have earned us if conversion had held?'),
    A(ago(121),
      ['Read'],
      `Not much, even in the best case:

- **Extra shipping income:** about €95 a day (roughly 23 under-€50 orders a day × the €4.10 difference).
- **What it cost yesterday afternoon:** about €1,100 in lost sales.
- **What it was trying to cover:** Boxwell's increase is about **€90 a month**, not a day (${P}Suppliers/boxwell-packaging.md).

So the rollback is the clear call. There's a cheaper fix for the boxes in that same file: order three months ahead at today's price before 1 ${NEXT_MONTH}, which saves about €270.

Roll it back now, or after you've talked to Jonas?`),
    U(ago(118), 'After I talk to Jonas. Put it on my board.'),
    A(ago(117),
      ['mcp__tasks__update_task', 'mcp__reminders__set_reminder'],
      `Done. "Decide: roll back the shipping rule" is on your board for today, with these numbers in the description.

I'll also recheck checkout conversion at 18:00 and tell you only if it's still under 2.5%. Once you say go, the rollback takes me a minute, and the pricing page Mara is waiting on becomes correct as it stands.`),
  ],

  // (3) Brewline reorder prep
  'nora-brewline': [
    U(at(-1, '16:40'), 'What did Brewline order last time?'),
    A(at(-1, '16:40'),
      ['Read', 'mcp__email__search'],
      `Their last order was on ${nice(-37)}:

| Item | Qty | Price | Total |
|---|---|---|---|
| Tide mugs | 240 | €8.50 | €2,040 |
| Pour-over drippers | 60 | €16.00 | €960 |
| **Total (ex VAT)** | | | **€3,000** |

Paid in 24 days, like most of their orders. They reorder every six weeks, so the next one is due around **${nice(5)}**, in about five days. Tom has it on his board. Sofia mentioned a tenth café opening in the new year, so the order after this one may be bigger. Notes in ${P}Wholesale/brewline-cafes.md.`),
    U(at(-1, '16:43'), 'Do we have the stock for the same again?'),
    A(at(-1, '16:44'),
      ['mcp__shopify__get_low_inventory', 'Read', 'Read'],
      `Not on the shelf yet, but it's covered if the kiln stays on plan:

| | Needed | On the shelf | From firings | Total |
|---|---|---|---|---|
| Tide mugs | 240 | 86 | 120 (${nice(1)}) + 120 (${nice(3)}) | 326 |
| Drippers | 60 | 40 | 24 (${nice(2)}) | 64 |

The mugs are fine. The drippers are tight: four spare. If the dripper firing loses more than 15%, Tom should warn Sofia a week ahead, which is what Brewline asks for. Lena's plan is in ${P}Studio/kiln-schedule.md.

Want me to draft the order confirmation for Tom, same quantities as last time?`),
    U(at(-1, '16:46'), 'Yes, for Tom. Same quantities, one delivery per city like they like it.'),
    A(at(-1, '16:47'),
      ['mcp__email__create_draft', 'mcp__tasks__update_task'],
      `Drafted for Tom, to Sofia:

> **Subject:** Your next order: 240 Tide mugs + 60 drippers
>
> Hi Sofia,
>
> Your six-weekly order is coming up, so here's what we have ready: 240 Tide mugs and 60 pour-over drippers, same prices as last time (€3,000 ex VAT). As usual, one delivery to Lisbon and one to Porto, boxes labelled by café.
>
> We can ship on ${nice(5)}. Shall we go ahead with the same quantities, or do you need more for the new café?
>
> Best,
> Tom

It's in Tom's drafts, not sent. I added a note to his "Prepare the Brewline reorder" task so he sees it first thing.`),
  ],

  // (4) A quick one, phone-style
  'nora-quick-stock': [
    U(at(-1, '11:12'), 'harbour bowls left?'),
    A(at(-1, '11:12'),
      ['mcp__shopify__get_products'],
      '64 on the shelf, plus the 60 already packed into Breakfast Bundles for the launch.'),
    U(at(-1, '11:13'), 'and ember mugs'),
    A(at(-1, '11:13'),
      `38. They sell about 4 a day, so roughly nine days at this pace. Lena's next Ember firing (60 mugs) comes out on ${nice(4)}, so they shouldn't run out.`),
    U(at(-1, '11:14'), 'good, thanks'),
    A(at(-1, '11:14'), 'Any time.'),
  ],

  // (5) Yesterday's investor prep
  'nora-investor-prep': [
    U(at(-1, '18:05'), 'Can you put together my prep for tomorrow\'s investor call? Same format as last time.'),
    A(at(-1, '18:07'),
      ['mcp__shopify__get_sales_summary', 'mcp__stripe__list_charges', 'Read', 'Read', 'Write'],
      `Done: ${P}users/nora/investor-prep.md. It's in your private folder, so only you can see it.

The headline numbers:

| | Number |
|---|---|
| Trailing 12-month revenue | €412k (+€19k since the last call) |
| September | €38.2k, the best September yet |
| Gross margin | 61% |
| Cash | €86k |

I put three talking points up front (Ember, Brewline, tomorrow's Breakfast Bundle) and three things they might poke at: today's shipping dip, kiln capacity and Boxwell's price rise. On capacity I wrote "thinking about a second potter in spring, not decided", as you put it in your hiring notes. Change that if you'd rather not raise it.`),
    U(at(-1, '18:10'), 'Perfect. Leave the potter line in.'),
    A(at(-1, '18:10'), 'Left as is. I\'ll remind you 20 minutes before the call tomorrow and send you the three numbers again then.'),
  ],

  // Mara (1) Newsletter draft from what shipped
  'mara-newsletter': [
    U(at(-1, '10:20'), 'Draft this week\'s newsletter from what shipped this week.'),
    A(at(-1, '10:22'),
      ['mcp__shopify__get_products', 'mcp__shopify__get_sales_summary', 'Read', 'Read', 'Edit'],
      `Draft is in ${P}Marketing/newsletter-this-week.md. What shipped this week, and what I made of it:

| Shipped | In the issue |
|---|---|
| Breakfast Bundle page live, 30 packed | **Lead:** the bundle, €79, ships free |
| Ember: 48 mugs, 22 bowls, 14 plates sold | **Second:** Ember week two, "the mugs are going fastest" |
| Two Tide firings for a café order | **Studio bit:** short, no names |

I kept to the brand voice: no "save" on the bundle (it's a gift product, per the pricing rules), numbers over adjectives, one light line in the studio section.

One gap: the bundle section links to the new pricing page, and Nora hasn't signed it off yet. Everything else is ready for your review.`),
    U(at(-1, '10:31'), 'Make the studio bit shorter and mention the winter market.'),
    A(at(-1, '10:31'),
      ['Edit'],
      `Done. The studio section is now two lines:

> Two extra Tide firings this week, both for a café order. The kiln has barely cooled.
>
> See you at the winter market. Dates in next week's issue.

I left the dates out because they aren't confirmed; your ideas file has them pencilled in for the next issue.`),
  ],

  // Mara (2) Breakfast Bundle subject lines
  'mara-subject-lines': [
    U(ago(95), 'Give me subject lines for the Breakfast Bundle.'),
    A(ago(94),
      ['Read'],
      `Eight, in our voice. Your best opener last quarter was "The kiln is open" (51%), so I leaned towards short and concrete:

| # | Subject | Angle | Length |
|---|---|---|---|
| 1 | Breakfast for two, in a box | The product, plainly | 27 |
| 2 | Two mugs, two bowls, one box | Concrete | 28 |
| 3 | The slow-morning set is here | Mood | 28 |
| 4 | Our gift box is open | Mirrors "The kiln is open" | 20 |
| 5 | For whoever makes the coffee | Gifting | 28 |
| 6 | New: the Breakfast Bundle | Straight announcement | 25 |
| 7 | Coffee, cereal, and a card | Playful | 26 |
| 8 | Breakfast, boxed | Shortest | 16 |

For the A/B test I'd pair **1** (clear) with **3** (mood): different enough that the result tells you something.`),
    U(ago(88), 'Go with 1 and 3.'),
    A(ago(87),
      ['Edit', 'mcp__reminders__set_reminder'],
      `Set in the draft: A is "Breakfast for two, in a box", B is "The slow-morning set is here", preheader "Two mugs, two bowls, one gift box. Plus week two of Ember."

An hour after it goes out tomorrow, I'll pull open and click rates for both and tell you which won.`),
  ],
};

const SESSION_META = {
  nora: [
    { id: 'nora-today',         title: 'What needs me today' },
    { id: 'nora-sales-drop',    title: 'Why sales dropped yesterday' },
    { id: 'nora-investor-prep', title: 'Investor call prep' },
    { id: 'nora-brewline',      title: 'Brewline reorder' },
    { id: 'nora-quick-stock',   title: 'Harbour and Ember stock' },
  ],
  mara: [
    { id: 'mara-subject-lines', title: 'Breakfast Bundle subject lines' },
    { id: 'mara-newsletter',    title: 'Newsletter draft: this week' },
  ],
};

/** Per-person chat sessions (shape of GET /api/chat/sessions → sessions[]), newest first. */
export const SESSIONS = Object.fromEntries(Object.entries(SESSION_META).map(([slug, list]) => [slug, list
  .map(({ id, title }) => {
    const h = HISTORIES[id] || [];
    return {
      id, title, titleSource: 'auto',
      createdAt: h[0]?.ts || at(-1, '09:00'),
      lastMessageAt: h.at(-1)?.ts || at(-1, '09:00'),
      messageCount: h.length,
      pinned: false, archived: false,
    };
  })
  .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))]));

// ── Board ───────────────────────────────────────────────────────────────────

const task = (id, title, description, status, owner, priority, deadline, order, extra = {}) => ({
  id, title, description, status, owner, priority, deadline,
  completed: null, order, createdAt: at(-10, '09:30'), createdBy: 'nora', ...extra,
});

export const TASKS = [
  task('t_pricing_page', 'Sign off the new pricing page',
    'The "Prices & shipping" page goes live with the Breakfast Bundle. Everything is checked except the shipping line, which depends on the shipping rule decision. Mara\'s newsletter review is waiting on this.',
    'in_progress', 'nora', 'high', day(0), 0),
  task('t_ember_launch', 'Run the Ember launch campaign',
    'Four-week paid push on Meta (€1,200) and Google Ads (€800). Day 12: €890 spent, ROAS 3.2. Swap in the lifestyle creatives after the shoot.',
    'in_progress', 'leo', 'high', day(16), 1, { createdAt: at(-14, '10:00'), createdBy: 'leo' }),
  task('t_brewline_reorder', 'Prepare the Brewline reorder',
    'Next six-weekly order due around ' + nice(5) + ': expect 240 Tide mugs + 60 drippers (€3,000 ex VAT). Confirmation drafted in Tom\'s inbox; book the Lisbon and Porto pickups.',
    'in_progress', 'tom', 'high', day(5), 2, { createdBy: 'tom' }),
  task('t_ostra_credit', 'Get Ostra\'s credit note for the damaged pallet',
    'Invoice OC-2291 (€2,860) is on hold until Ostra issues the €360 credit note for 8 damaged bags. Then pay the €2,500 balance the same day.',
    'in_progress', 'jonas', 'high', day(2), 3, { createdBy: 'jonas' }),
  task('t_newsletter', 'Friday newsletter: Breakfast Bundle launch',
    'Lead with the bundle (€79, ships free), Ember week two, a short studio note. A/B subject lines set. Review blocked on the pricing page sign-off.',
    'in_progress', 'mara', 'high', day(1), 4, { createdBy: 'mara' }),
  task('t_kiln_tide', 'Two extra Tide glaze firings',
    '120 mugs each, unloading ' + nice(1) + ' and ' + nice(3) + ', for Brewline. Log losses.',
    'in_progress', 'lena', 'medium', day(3), 5, { createdBy: 'lena' }),
  task('t_shipping_rule', 'Decide: roll back the shipping rule',
    'Yesterday 14:20 the under-€50 shipping went from €4.90 to €9. Conversion fell from 3.1% to 1.9% (0.7% after the change); about €1,100 lost in an afternoon. The €9 rule earns ~€95/day at best; Boxwell\'s increase is ~€90/month. Talk to Jonas, then tell Aria to roll back.',
    'backlog', 'nora', 'high', day(0), 0, { createdBy: 'nora' }),
  task('t_photo_shoot', 'Ember lifestyle shoot with Paula Reyes',
    'Studio and kitchen, 09:00–15:00. Seven shots (see Marketing/shoot-brief-ember.md). Pieces from the third Ember firing.',
    'backlog', 'ivy', 'medium', day(SHOOT), 1, { createdBy: 'ivy' }),
  task('t_boxwell_order', 'Order three months of boxes before the price rise',
    'Boxwell goes up 8% on 1 ' + NEXT_MONTH + '. Ordering ahead saves about €270. Lena has room for two pallets.',
    'backlog', 'jonas', 'medium', null, 2, { createdBy: 'jonas' }),
  task('t_spring_budget', 'Draft the spring campaign budget',
    'Split across Meta and Google, based on what Ember taught us. Share with Nora.',
    'backlog', 'leo', 'low', day(21), 3, { createdBy: 'leo' }),
  task('t_winter_market', 'Book the winter market stall',
    'Same corner as last year if we can get it. Bring the seconds box (64 pieces).',
    'backlog', null, 'low', null, 4),
  task('t_stock_count', 'Monday stock count',
    'Counted everything; Tide mugs and drippers low after Brewline. Extra firings booked.',
    'done', 'lena', 'medium', day(-3), 0, { completed: day(-3), createdBy: 'lena' }),
  task('t_ember_packshots', 'Ember pack shots for the shop',
    'Shot in the studio before launch; 24 images on the collection and product pages.',
    'done', 'ivy', 'high', day(-13), 1, { completed: day(-14), createdAt: at(-20, '09:00'), createdBy: 'ivy' }),
];

// ── Reminders ───────────────────────────────────────────────────────────────
// Shape of reminders.json entries; `dueInMin` is stamped into a real `due` by
// the demo server. Planner reminders (origin: 'planner') are instructions for
// Aria to act on, never text to relay.

export const REMINDERS = {
  nora: [
    { id: 'r_investor', kind: 'user', origin: 'planner',
      title: 'Before Nora\'s 10:00 investor call, reread users/nora/investor-prep.md and send her the three headline numbers',
      description: 'Trailing 12-month revenue, September, gross margin. Add anything that changed overnight (orders, the shipping rollback).',
      dueInMin: 20, channel: 'all', status: 'pending', setBy: 'nora', recipients: ['nora'] },
    { id: 'r_unfulfilled', kind: 'user',
      title: 'Check Shopify for orders unfulfilled over 48h and flag them',
      description: 'List each one with what it\'s waiting on (stock, a firing, an address), so whoever owns it can chase.',
      dueInMin: 150, repeat: 'daily', channel: 'all', status: 'pending', setBy: 'nora', recipients: ['*everyone*'] },
    { id: 'r_ostra_nudge', kind: 'user', origin: 'planner',
      title: 'If Nora hasn\'t approved the Ostra reply by 15:00, ask her once more; check the inbox for Ostra\'s credit note',
      description: 'If the credit note has arrived, tell Jonas the balance to pay is €2,500.',
      dueInMin: 300, channel: 'all', status: 'pending', setBy: 'nora', recipients: ['nora'] },
    { id: 'r_conversion', kind: 'user', origin: 'planner',
      title: 'Recheck checkout conversion at 18:00; tell Nora only if it\'s still under 2.5%',
      description: 'Compare with the 3.1% baseline from before yesterday\'s shipping change.',
      dueInMin: 480, channel: 'all', status: 'pending', setBy: 'nora', recipients: ['nora'] },
    { id: 'r_weekly_report', kind: 'user',
      title: 'Draft the weekly sales report from Shopify and GA4 into Reports/weekly-sales.md',
      description: 'Revenue, orders, conversion by day, top products. Call out anything that moved more than 10%.',
      dueInMin: 1500, repeat: 'weekly', channel: 'web', status: 'pending', setBy: 'nora', recipients: ['nora', 'leo'] },
    { id: 'r_tom_brewline', kind: 'user',
      title: 'Ask Tom whether Sofia has confirmed the Brewline quantities; if not, offer to send the drafted confirmation',
      dueInMin: 1560, channel: 'all', status: 'pending', setBy: 'nora', recipients: ['tom'] },
    { id: 'r_from_lena', kind: 'user',
      title: 'Check the glaze stock for the Ember firing and tell Nora if anything needs ordering from Ostra',
      description: 'Iron oxide especially; the firing loads on ' + nice(3) + '.',
      dueInMin: 2700, channel: 'all', status: 'pending', setBy: 'lena', recipients: ['nora'] },
    { id: 'r_plan_nora', kind: 'system', title: 'Plan the day',
      dueInMin: 1290, repeat: 'daily', channel: 'all', status: 'pending', recipients: ['nora'] },
    { id: 'r_backup', kind: 'system', title: 'Weekly project backup',
      dueInMin: 4320, repeat: 'weekly', channel: 'all', status: 'pending' },
  ],
  mara: [
    { id: 'r_unfulfilled', kind: 'user',
      title: 'Check Shopify for orders unfulfilled over 48h and flag them',
      description: 'List each one with what it\'s waiting on (stock, a firing, an address), so whoever owns it can chase.',
      dueInMin: 150, repeat: 'daily', channel: 'all', status: 'pending', setBy: 'nora', recipients: ['*everyone*'] },
    { id: 'r_m_pricing', kind: 'user',
      title: 'When Nora signs off the pricing page, tell Mara so she can finish the newsletter review',
      dueInMin: 60, channel: 'telegram', status: 'pending', setBy: 'mara', recipients: ['mara'] },
    { id: 'r_m_check', kind: 'user', origin: 'planner',
      title: 'Before the 08:00 send, check the newsletter links and prices against Shopify and send Mara anything that doesn\'t match',
      dueInMin: 1320, channel: 'all', status: 'pending', setBy: 'mara', recipients: ['mara'] },
    { id: 'r_m_abtest', kind: 'user',
      title: 'An hour after the newsletter goes out, pull open and click rates for both subject lines and tell Mara which won',
      dueInMin: 1380, channel: 'telegram', status: 'pending', setBy: 'mara', recipients: ['mara'] },
    { id: 'r_plan_mara', kind: 'system', title: 'Plan the day',
      dueInMin: 1290, repeat: 'daily', channel: 'all', status: 'pending', recipients: ['mara'] },
  ],
};

// ── Notifications ───────────────────────────────────────────────────────────

export const NOTIFICATIONS = [
  { id: 'n_morning', kind: 'bot', ts: ago(55), title: 'Three things need you today',
    body: 'Investor call at 10:00, the Ostra reply waiting for your yes, and Mara\'s review is blocked on the pricing page.',
    meta: { session_id: 'nora-today' } },
  { id: 'n_sales', kind: 'bot', ts: ago(135), title: 'Sales dropped yesterday afternoon',
    body: 'Traffic held, but checkout conversion fell from 3.1% to 1.9% after the shipping change at 14:20.',
    meta: { session_id: 'nora-sales-drop' } },
  { id: 'n_investor', kind: 'reminder', ts: ago(30), title: 'Investor call at 10:00',
    body: 'Prep is ready: €412k trailing revenue, 61% margin, Ember ROAS 3.2.',
    meta: { session_id: 'nora-today', channel: 'all' } },
  { id: 'n_ostra', kind: 'bot', ts: ago(50), title: 'Reply to Ostra drafted',
    body: 'Holding OC-2291 until the €360 credit note arrives, then paying €2,500. Waiting for your yes.',
    meta: { session_id: 'nora-today' } },
  { id: 'n_unfulfilled', kind: 'reminder', ts: ago(200), title: 'Two orders past 48 hours',
    body: '#4417 (customer asked us to hold it for a gift date) and #4421 (the courier bounced the address). Lena has both.',
    meta: { channel: 'all' } },
  { id: 'n_brewline', kind: 'bot', ts: at(-1, '16:48'), title: 'Brewline confirmation drafted',
    body: '240 Tide mugs + 60 drippers, €3,000. In Tom\'s drafts, not sent.',
    meta: { session_id: 'nora-brewline' } },
  { id: 'n_mara', kind: 'bot', ts: ago(75), title: 'Mara is waiting on the pricing page',
    body: 'Mara: "Newsletter is ready except the pricing page link. Can you sign it off before 14:00?"',
    meta: { channel: 'all' } },
  { id: 'n_boxwell', kind: 'reminder', ts: at(-1, '09:15'), title: 'Boxwell prices up 8% on 1 ' + NEXT_MONTH,
    body: 'About €90 a month. Jonas suggests ordering three months ahead at today\'s price.',
    meta: { channel: 'web' } },
];

/** Arrive while the page is open (the first lands in the open "What needs me today" chat). */
export const LIVE_NOTIFICATIONS = [
  { id: 'n_live_credit', kind: 'bot', title: 'Ostra\'s credit note arrived',
    body: 'Ostra just sent credit note CN-0412 for €360. The balance on OC-2291 is now €2,500; I\'ve updated the draft reply to say it will be paid today. Still waiting for your yes, and I\'ve told Jonas.',
    meta: { session_id: 'nora-today' } },
  { id: 'n_live_conversion', kind: 'bot', title: 'Conversion still low this morning',
    body: 'Checkout conversion since midnight is 1.2%, against 3.1% before the shipping change. The rollback is one step once you say go.',
    meta: { session_id: 'nora-sales-drop' } },
];

// ── Skills ──────────────────────────────────────────────────────────────────
// Team skills: the real defaults shipped in ide-template/skills/default/
// (stamped source: system, read-only) plus three the workspace made.

const system = (name, description, references = []) => ({
  name, origin: 'project', description, requires: null, tags: [], source: 'system',
  editable: false, managed_by: 'ide-template', references, scope: 'team',
});
const made = (name, description, requires, tags, references = []) => ({
  name, origin: 'project', description, requires, tags, source: 'project',
  editable: true, managed_by: null, references, scope: 'team',
});
const own = (name, description, tags = []) => ({
  name, origin: 'personal', description, requires: null, tags, source: 'personal',
  editable: true, managed_by: null, references: [], scope: 'personal',
});

export const SKILLS = {
  team: [
    system('capability-tour', 'Show the user what tools/MCPs are configured and what they can actually do for this business. Use when someone asks what you can do or which tools are wired up, and proactively once after a new integration is activated. Diffs the active MCP set against the CLAUDE.md "Context" section and offers to fill the gap. Ends a tour with at most one fitting routine suggestion and a pointer that more is under Integrations.', ['gap-handling.md', 'mcp-defaults.md']),
    system('environment', 'Sealed-container constraints — never run install/setup commands, never edit system dotfiles, never download runtimes. Load on any tool error matching "not available", "browser not reachable", "ENETUNREACH", "not connected", "command not found", "module not found", "missing dependency", or whenever you\'re about to run install / npm install / pip install / apt install / playwright install / curl … | sh / wget … | sh / chrome / chromium / git clone for an environment fix. Container is curated at image build time — runtime install attempts fail with 403 or timeout. Operator is the only one who can change the image.'),
    system('file-placement', 'Use this BEFORE writing or saving a new file when the destination path is not explicitly given by the user — e.g. "save this", "write this up", "save this brief". Reads the project\'s "Where to Save" decision tree, PROJECT_STRUCTURE.md and the current folder structure, then either picks a folder confidently or asks one short question. Not for "remember this" (a fact or preference) — that is memory_note, not a file. Also covers how to tell people where things went in plain language.', ['decision-tree.md']),
    system('legacy-drive-sync', 'Reliability rules for workspaces using the legacy Google Drive sync (rclone-backed file mirroring). Load ONLY when `LEGACY_DRIVE_SYNC=true` is active in the workspace env. Covers silent write failures, stale reads, verification-after-write protocol. New deploys do NOT use this — they store files in the workspace volume only, no Drive round-trip.'),
    system('make-pdf', 'Use this whenever you need to produce a PDF — a proposal, report, invoice, letter, contract, summary, or any document someone asks for "as a PDF". There is a dedicated tool for it (mcp__pdf__render_pdf); NEVER write raw PDF bytes or a hand-rolled Python PDF builder. Also covers previewing a PDF to SEE it before sending, and delivering it over Telegram.'),
    system('memory-notes', 'Use this whenever you save something to memory yourself with memory_note — the person says "remember this", corrects what memory holds, pastes meeting notes or a summary, or tells you something they will clearly want kept. How to write a note that still makes sense months later, how a meeting becomes one note, and when to ask before saving.'),
    system('mini-apps', 'Build persistent mini apps (dashboards, trackers, widgets) that live as tabs in the workspace sidebar under "Mini Apps". Use whenever the user asks for a dashboard, tracker, overview, widget, "app", or keeps asking for the same summary repeatedly — offer to turn it into a tab instead of another one-off chat answer. The dedicated tool is mcp__miniapps__save_as_tab; NEVER paste UI specs or component code into the chat.'),
    system('morning-planner', 'Owns the daily plan and turns the person\'s routines (the ROUTINES block, fresh via memory_now) into it. Run this whenever a routine is added (add_routine or memory_write) or changed, to fold it into today\'s reminders the same day. Plan the day like a proactive colleague. Each morning, read their routines (standing duties + proactive directives), the calendar, tasks, open threads, and the reminders already set — then anticipate what today needs and place timed reminders at concrete hours. Works SILENTLY (sets reminders, posts nothing) and stays entirely inside the platform (it only READS context and SETS reminders — it never sends email or changes anything over an API; external actions become reminders that tell you to PROPOSE them for the user to approve). Triggered by `[PLAN_DAY_TRIGGER]` (daily reminder, see global-claude.md trigger table) or manually via "/plan", "plan my day", "plan today".'),
    system('playwright-protocol', 'Rules for browser automation with Playwright — screenshots, navigation, mobile views. Use when you need to open and drive a website yourself (screenshot a URL, check a mobile view, click through a public page). Not for the page the person has open in Chrome — in a side-panel conversation use the tab_* tools (tab_snapshot, tab_screenshot, tab_act) instead.'),
    system('project-backup', 'Use this when the user asks to back up the project, create a project archive, or send a project snapshot, and on the weekly `[BACKUP_TRIGGER]`. Creates a compressed tar.gz of the shared project (never memory, team state or other people\'s private folders) and hands it over — on Telegram as a file, on the web as a workspace path.', ['rules.md']),
    system('reminders', 'Use this when the user wants to set a timed reminder, list pending reminders, or cancel one. Reminders fire on Telegram, the web UI, or both — even when no session is active — and can repeat on a schedule (hourly/daily/weekly/monthly or a custom interval, with an optional end date or fire count). Not for a standing duty the person wants you to take on ongoing ("check my inbox every morning", "keep an eye on X") — that is a routine: use the routines skill.', ['delivery.md', 'set-params.md']),
    system('repo-audit', 'Weekly project structure review. Identifies orphans (loose files in root), stale files (no edit 30+ days), duplicate folders and empty dirs (never inside memory/, .team/, .routines/ or .group-watcher/). Auto-executes obvious safe cleanups (empty folders, twin-folder casing, .playwright-mcp wipe), asks for approval on judgment calls. Triggered weekly by reminder `[REPO_AUDIT_TRIGGER]`, or manually via "/audit", "weekly audit", "clean up repo", "tidy up the project".', ['bash-commands.md', 'exclusions.md']),
    system('routines', 'Use this when the person talks about something they\'d like taken care of regularly ("every morning tell me…", "keep an eye on…", "every Friday send me…"), asks what you can do on your own, has just connected an integration, or wants a routine added, changed or removed. Knows every ready-made routine in the Marketplace (references/catalog.md) and adds one with add_routine once they say yes.', ['catalog.md']),
    system('security', 'Untrusted-content handling rules. Every agent that reads externally-sourced text (emails, PDFs, web pages, transcripts, files the user dragged in) must load this skill and follow its rules. NOT user-facing — agent-facing reference, loaded as a system prompt addendum.', ['coverage-status.md']),
    system('skill-authoring', 'Author or update a SKILL.md playbook in this workspace. Use when user says "create a skill", "add a skill", "write a SKILL.md", "make a playbook", "package this as a recipe", "automate this workflow", or asks how the skills system works / how to add a new playbook / where skills live. Covers folder structure, YAML frontmatter, references/ split, allowed-tools restriction, and pre-commit validation against Anthropic\'s official skill format.', ['anti-patterns.md', 'checklist.md', 'yaml-fields.md']),
    system('task-management', 'Use this when the user wants to add, update, move, assign, delete, or review tasks. Tasks live on a structured board (Backlog / In Progress / Done) served by the workspace API over HTTP at http://localhost:3001/api/tasks — read and write it with the Bash tool (curl). There are no mcp__tasks__* tools; don\'t look for them. Each task can be assigned to a teammate.', ['reminder-rules.md', 'templates.md']),
    made('wholesale-reorder', 'Prepare a café\'s reorder: pull their last order from Wholesale/, check shelf stock and the kiln plan cover it, flag anything short a week ahead, and draft the confirmation for the account owner to send. Never sends it.', 'shopify', ['wholesale', 'stock'], ['packing-rules.md']),
    made('newsletter-voice', 'Write or edit the Friday newsletter in Saltmarsh\'s voice: lead with what shipped this week, numbers over adjectives, no "save" on gift products, one light line at most. Checks prices against Products/pricing.md before calling a draft ready.', 'email', ['newsletter', 'brand']),
    made('product-copy', 'Write a product page for the shop: headline, short and long description, details, care and SEO lines, in the brand voice. Pulls sizes and prices from Shopify and the catalog; says plainly that handmade pieces vary.', 'shopify', ['copy', 'shop'], ['page-template.md']),
  ],
  personal: {
    nora: [
      own('investor-update', 'How I prep an investor call: trailing 12-month revenue, the latest month, margin, cash, three talking points and three things they might poke at. Goes in my private folder, never the shared one.', ['investors']),
      own('founder-friday', 'My Friday review: what moved this week (sales, wholesale, the kiln), what\'s stuck on me, and the one decision I\'ve been putting off.', ['weekly']),
    ],
    mara: [
      own('subject-line-test', 'How I want subject-line options: eight in our voice, with angle and length, then a recommended A/B pair that will actually teach us something.', ['newsletter']),
    ],
  },
};

// ── Integrations ────────────────────────────────────────────────────────────
// Ids from workspace-api/integrations.catalog.json.

export const INTEGRATIONS = {
  workspace: ['email-imap', 'google-workspace', 'shopify', 'notion', 'meta-ads', 'google-ads', 'ga4', 'stripe', 'telegram'],
  personal: { nora: ['granola'], mara: ['granola'] },
  // Connected for the team with read access only.
  accessReadOnly: ['stripe', 'ga4'],
};

// ── Telegram groups, locks, branding ────────────────────────────────────────

const tgMembers = (...slugs) => Object.fromEntries(slugs.map(s => [PEOPLE[s].telegramChatId, PEOPLE[s].name]));

export const SLACK_CHANNELS = {
  groups: [
    { chatId: 'slack-C0SALT0001', kind: 'slack', title: '#studio', requireMention: true, language: '',
      members: { U0SALTNORA: 'Nora Vale', U0SALTMARA: 'Mara Quill', U0SALTLEO: 'Leo Brandt' },
      audience: { ok: true, outsiders: [], shared: false, members: 4, checkedAt: at(-1, '09:12') },
      addedAt: at(-30, '10:00'), addedBy: PEOPLE.nora.email },
    { chatId: 'slack-C0SALT0002', kind: 'slack', title: '#wholesale', requireMention: false, language: 'English', paused: true,
      members: { U0SALTNORA: 'Nora Vale', U0SALTTOM: 'Tom Ashby' },
      audience: { ok: false, outsiders: ['U0GUEST001'], shared: false, members: 4, checkedAt: at(0, '08:40') },
      addedAt: at(-12, '15:30'), addedBy: PEOPLE.nora.email },
  ],
  pending: [
    { chatId: 'slack-C0SALT0003', channel: 'C0SALT0003', title: '#kiln-log', inviterSlug: 'lena', members: 5, private: false, at: at(0, '07:55') },
  ],
  pendingPeople: [
    { id: 'U0NEWHIRE1', email: 'pia@saltmarshceramics.example', name: 'Pia Larsen', at: at(0, '08:10') },
  ],
};

export const TELEGRAM_GROUPS = [
  { chatId: '-1007001000001', title: `${COMPANY.short} team`, requireMention: false, language: 'English',
    beat: 'The whole team. Day-to-day questions about orders, stock, the kiln and the newsletter.',
    members: tgMembers('nora', 'mara', 'leo', 'tom', 'jonas', 'lena'),
    addedAt: at(-90, '09:00'), addedBy: PEOPLE.nora.email },
  { chatId: '-1007001000002', title: 'Studio floor', requireMention: true, language: 'English',
    beat: 'Kiln loads, stock counts and packing. Only answer when someone mentions the bot.',
    members: tgMembers('nora', 'lena', 'jonas'),
    addedAt: at(-60, '08:30'), addedBy: PEOPLE.nora.email },
];

export const LOCKS = {
  'Products/pricing.md':     { by: 'nora', at: at(-20, '09:00') },
  'Wholesale/price-list.md': { by: 'nora', at: at(-30, '10:00') },
  'Marketing/brand-voice.md': { by: 'nora', at: at(-45, '11:30') },
};

export const BRANDING = {
  title: COMPANY.name,
  botName: BOT.name,
  botDisplayName: BOT.name,
  botAvatarUrl: `${BASE}avatars/1.png`,
  logoUrl: null,
  iconUrl: null,
  personality: 'Warm, plain and a little dry, like the studio. Says what it found and what it would do next; asks before anything leaves the building.',
  backstory: `${BOT.name} is ${COMPANY.short}'s coworker: knows the catalog, the kiln plan, the wholesale accounts, the suppliers and the numbers.`,
  updatedAt: at(-60, '10:00'),
  updatedBy: PEOPLE.nora.email,
};
