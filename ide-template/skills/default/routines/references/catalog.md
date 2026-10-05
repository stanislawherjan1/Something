# Marketplace routines

<!-- Generated from workspace-api/routines.catalog.json by lib/routines-reference.js — do not edit by hand. -->

Every ready-made routine a person can add (the Marketplace tab of Routines, or `add_routine` with the id).
**Needs** = the integration that must be connected first ("or" = any one of them).
The summary is what to say to the person; the full instruction is what the planner runs once it is added.

## Everyday life

- **Morning weather** — `weather-morning` · recommended · needs: nothing
  Each morning: today's weather where you are and what it means for the day.
- **Weekend weather and a plan** — `weekend-weather` · needs: nothing
  Friday afternoon: the weekend's weather, with one idea that fits it.
- **Something good** — `good-news` · recommended · needs: nothing
  Once a day, one real piece of good news, with its source.
- **A fact about your topic** — `daily-fact` · needs: nothing
  Every day, one surprising, checked fact about a topic you choose.
- **Word of the day** — `word-of-the-day` · needs: nothing
  A useful word or phrase in the language you're learning, with an example.
- **On this day** — `on-this-day` · needs: nothing
  Each morning, one thing that happened on today's date — tied to what you like.
- **What's on this weekend** — `weekend-ideas` · needs: nothing
  Thursday: three things worth doing near you this weekend.
- **Dinner idea** — `dinner-idea` · needs: nothing
  Weekday afternoons: one simple dinner idea that fits your diet and the season.
- **Weekly read** — `weekly-read` · needs: nothing
  Once a week, one article worth your time on what you're into.
- **Birthdays and occasions** — `occasions` · recommended · needs: nothing
  A week ahead: birthdays and anniversaries you mentioned, with a gift idea.
- **Take a break** — `break-nudge` · needs: nothing
  Workday afternoons: a short break suggestion when you've been at it for hours.
- **This week's wins** — `weekly-wins` · needs: nothing
  Friday evening: three things that went well this week.
- **Night sky** — `night-sky` · needs: nothing
  A heads-up for a clear night with something worth looking up at.
- **Your city this week** — `local-news` · needs: nothing
  Monday: the three local stories that matter where you live.
- **Long weekends ahead** — `long-weekends` · needs: nothing
  A month ahead: public holidays near weekends, and days off that would stretch them.

## Planning

- **Morning brief** — `morning-brief` · recommended · needs: nothing
  Every working morning: the day's top three and what's due, in one short message.
- **Deadlines at risk** — `deadline-at-risk` · recommended · needs: nothing
  Speaks up only when a task can't realistically be finished in time.
- **End-of-day wrap-up** — `day-wrap-up` · needs: nothing
  Late afternoon: what moved today and what rolls to tomorrow.
- **Plan the week** — `weekly-plan` · needs: nothing
  Monday morning: three priorities for the week, from the board and what slipped.
- **Friday recap** — `friday-recap` · recommended · needs: nothing
  Friday afternoon: what got done, what's stuck, what's next — short.
- **Stale task sweep** — `stale-tasks` · needs: nothing
  Weekly: tasks stuck In Progress for a week, with a question.
- **Keep my promises** — `promise-keeper` · recommended · needs: nothing
  When you say you'll do something later, it comes back at the right moment.
- **Waiting on others** — `waiting-on` · needs: nothing
  Tracks what you're waiting on from people and offers a nudge.
- **Monthly look back** — `monthly-review` · needs: nothing
  First working day of the month: what worked, what slipped, which routines to keep.
- **Protect focus time** — `focus-guard` · needs: Google Workspace
  When tomorrow is packed, proposes what to batch or move to keep one focus block.
- **Renewals and expiries** — `renewals` · needs: nothing
  Tracks what expires or renews and warns a month and a week ahead.

## Email

- **Watch your inbox** — `inbox-hourly` · recommended · needs: Email (IMAP)
  About hourly in working hours; tells you only when a mail needs you, with a draft.
- **Morning inbox digest** — `inbox-digest` · needs: Email (IMAP)
  Each morning: what arrived overnight, sorted into reply / FYI / later.
- **Draft the obvious replies** — `reply-drafts` · needs: Email (IMAP)
  Twice a day: drafts for simple mails, and a note of which are ready.
- **Follow up when they go quiet** — `no-reply-followup` · recommended · needs: Email (IMAP)
  Drafts a polite follow-up when mail you sent gets no answer.
- **Threads you owe a reply** — `unanswered-threads` · needs: Email (IMAP)
  Twice a week: mail waiting on your answer for three days or more.
- **Mail from key people** — `vip-mail` · needs: Email (IMAP)
  Tells you within half an hour when a key person writes.
- **Newsletters, weekly** — `newsletter-digest` · needs: Email (IMAP)
  Once a week: the newsletters worth reading, one line each.

## Calendar & meetings

- **Travel day prep** — `travel-prep` · needs: Email (IMAP)
  The day before a trip: check-in, times, bookings and weather in one message.
- **Morning calendar brief** — `calendar-brief` · recommended · needs: Google Workspace or Cal.com or Calendly
  Each morning: today's meetings, free blocks and what to prepare.
- **Meeting prep** — `meeting-prep` · recommended · needs: Google Workspace or Cal.com or Calendly
  Before meetings with outside people: a short brief on who, the last thread and open items.
- **After the meeting** — `meeting-followup` · needs: Google Workspace or Granola or Fireflies or Fathom or Otter.ai or Read AI or Krisp
  Turns meeting notes into proposed tasks and a follow-up draft.
- **Tomorrow, checked** — `calendar-conflicts` · needs: Google Workspace or Cal.com or Calendly
  Each evening: clashes, no breaks or an overloaded tomorrow, with a fix.
- **Unanswered invites** — `pending-invites` · needs: Google Workspace
  Once a day: invites you haven't answered, soonest first.
- **New bookings** — `new-bookings` · needs: Cal.com or Calendly
  Tells you when someone books, moves or cancels time with you.
- **Action items from meetings** — `meeting-actions` · needs: Granola or Fireflies or Fathom or Otter.ai or Read AI or Krisp
  After each meeting: who does what by when, ready to put on the board.

## Sales & clients

- **Reply to new leads fast** — `lead-response` · recommended · needs: Email (IMAP)
  New enquiry: who they are, what they want, and a draft reply within the hour.
- **Deals gone quiet** — `stale-deals` · needs: Email (IMAP)
  Weekly: clients and prospects with no contact in two weeks, with a next touch drafted.
- **News about key clients** — `client-news` · needs: nothing
  Weekly: funding, launches or trouble at key clients, with a message drafted.
- **Clients at risk** — `churn-risk` · needs: Stripe
  Monday: customers with failed payments, downgrades or cancellations.
- **Waiting for signatures** — `contract-signatures` · needs: E-Signature (SignWell)
  Checks documents out for signature and asks before chasing.
- **New form submissions** — `form-leads` · needs: Tally
  New answers to your forms, sorted: leads first, with a reply drafted.
- **Feedback from your forms** — `feedback-digest` · needs: Tally
  Monday: what people said in your surveys and feedback forms last week.

## Shop

- **"Where is my order" mail** — `where-is-my-order` · needs: Shopify, plus Email (IMAP)
  Answers order-status questions with a ready draft.
- **Answer product reviews** — `review-replies` · needs: Email (IMAP)
  Drafts replies to new reviews from the review app's mails; flags bad ones.
- **Daily store pulse** — `shop-pulse` · recommended · needs: Shopify
  Each morning: yesterday's sales vs. the usual, only when something's off.
- **Stockout forecast** — `stockout-forecast` · recommended · needs: Shopify
  Daily: products that will sell out before restock, with a draft order.
- **Stuck orders** — `stuck-orders` · needs: Shopify
  Orders unfulfilled after 48 hours or still unpaid.
- **Rising products** — `bestsellers` · needs: Shopify
  Weekly: what's selling faster or slower than usual, with an idea for each.

## Money

- **Invoices and receipts** — `invoice-catcher` · needs: Email (IMAP)
  Weekly list of invoices from mail, with what's due soon.
- **Subscriptions and price rises** — `subscription-watch` · needs: Email (IMAP)
  Notices new subscriptions, price rises and coming renewals.
- **Month-end pack** — `month-end-pack` · needs: Email (IMAP)
  At month end: the month's invoices and receipts in one folder, and what's missing.
- **Failed payments and disputes** — `payment-issues` · recommended · needs: Stripe or PayPal
  Disputes as they come, with the deadline and evidence; failed payments for key clients.
- **Chase overdue invoices** — `overdue-invoices` · recommended · needs: Stripe or PayPal
  At 7, 14 and 21 days overdue, a reminder that gets firmer — you approve each.
- **Weekly cash snapshot** — `cash-weekly` · needs: Stripe or PayPal or Shopify
  Monday: money in, refunds, payouts and the change vs. last week.

## Marketing & ads

- **Ad spend out of line** — `ad-anomalies` · recommended · needs: Meta Ads or Google Ads
  Daily check; tells you only when a campaign overspends or underdelivers.
- **Weekly ad review** — `ads-weekly` · needs: Meta Ads or Google Ads
  Monday: what worked, what's wearing out, what to pause or scale.
- **Traffic out of line** — `traffic-anomalies` · needs: Google Analytics 4 or Amplitude
  Each morning; speaks only when visits or conversions are well off normal.
- **Funnel drops** — `funnel-drop` · needs: Amplitude
  Tells you when a step in your key funnel drops sharply.
- **Campaign results** — `campaign-results` · needs: Klaviyo or Mailchimp
  Two days after a send: opens, clicks, revenue vs. usual, and one lesson.
- **List health** — `list-health` · needs: Klaviyo or Mailchimp
  Monthly: list growth, unsubscribes and bounces, flagged when unusual.
- **Key pages checked** — `page-health` · needs: Firecrawl
  Weekly: broken links, missing titles or pages hidden from search.

## Content & social

- **Content ideas** — `content-ideas` · needs: nothing
  Weekly: three post ideas from what happened in the business.
- **Mentions worth answering** — `mentions` · needs: X (twitterapi.io)
  Twice a day: mentions that deserve a reply, with one drafted.
- **Content calendar check** — `content-calendar` · needs: Notion or Airtable
  Friday: what was published, what slipped, what's due next week.

## Dev & ops

- **New errors** — `new-errors` · recommended · needs: Sentry
  New or spiking errors, with how many users and a first guess at the cause.
- **Failed builds and deploys** — `failed-deploys` · needs: GitHub
  When a CI run or deploy fails: what broke, the relevant part of the log, and when it's fixed.
- **Review queue** — `review-queue` · needs: GitHub
  Each morning: PRs waiting on your review, and yours waiting on others.
- **What shipped** — `what-shipped` · needs: GitHub
  Each morning: yesterday's merges and releases in plain words.
- **Security advisories** — `security-advisories` · needs: GitHub
  Weekly: critical advisories for your dependencies, with the fix.
- **Standup digest** — `standup-digest` · needs: Linear or GitHub or Atlassian or ClickUp
  Before standup: what moved, what's blocked and what's next, per person.
- **Is the site up** — `site-health` · needs: Firecrawl
  A few times a day; tells you right away if the site is down or slow.
- **Database limits** — `database-limits` · needs: Supabase or Neon
  Daily: database size and usage vs. plan limits, before a limit is hit.

## Team

- **1:1 prep** — `one-on-one-prep` · needs: Google Workspace or Cal.com or Calendly
  Before each one-on-one: what they worked on, asked for, and what you owe them.
- **Weekly team pulse** — `team-pulse` · needs: Notion or Todoist or Trello or monday.com or Airtable or Linear or Atlassian or ClickUp
  Weekly: what's moving, stuck and coming up, one line per person or project.
- **Overdue on the board** — `board-overdue` · needs: Notion or Todoist or Trello or monday.com or Airtable or Linear or Atlassian or ClickUp
  Each morning: overdue and due-this-week items, grouped by owner.
- **What changed in the wiki** — `wiki-changes` · needs: Notion
  Weekly: new pages and comments waiting for your answer.
- **Monthly update draft** — `monthly-update` · needs: Stripe or Google Analytics 4 or GitHub or Linear
  At month end, a draft update for the team or investors.

## Research

- **Competitor prices** — `competitor-prices` · recommended · needs: Parallel Search or Firecrawl
  Daily: competitor prices for products you name, only when one changes.
- **Competitor launches** — `competitor-launches` · needs: nothing
  Weekly: what competitors launched or changed since last time.
- **Industry news, filtered** — `industry-news` · needs: nothing
  Weekly: the few stories that matter to this business.
- **What people say about us** — `reputation` · needs: nothing
  Weekly: new reviews, threads and articles about the business, with tone.
- **Supplier watch** — `supplier-watch` · needs: Parallel Search or Firecrawl
  Weekly: restocks, price or lead-time changes at your suppliers.
- **Platform policy changes** — `policy-changes` · needs: nothing
  Monthly: policy or pricing changes from platforms you depend on.
- **Tenders and opportunities** — `opportunities` · needs: nothing
  Weekly: new tenders, grants or calls that match what you do.
