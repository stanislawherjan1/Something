<h1 align="center">Something</h1>

<p align="center">
  <b>Your own AI coworker. Runs 24/7, knows your business, works with your team.</b>
</p>

<p align="center">
  <sub>
    <a href="https://something.md">Website</a>
    &nbsp;·&nbsp;
    <a href="#get-started">Get started</a>
    &nbsp;·&nbsp;
    <a href="#team">Team</a>
    &nbsp;·&nbsp;
    <a href="#integrations">Integrations</a>
    &nbsp;·&nbsp;
    <a href="#deploy-your-own">Deploy</a>
    &nbsp;·&nbsp;
    <a href="docs/ARCHITECTURE.md">Architecture</a>
  </sub>
</p>

<br/>

<p align="center">
  <img src="assets/readme/hero.png" alt="Build your own employee: bot portraits above the headline, and the tools it works with" width="820" />
</p>

<p align="center">
  Something lets you build a self-hosted AI coworker who knows your tools, your customers and your goals.<br/>
  You reach them in a private web workspace, in Chrome's side panel or on Telegram, and they do the work.
</p>

<br/>
<br/>

## What they do

Everything you'd reach for to automate your work (markdown for context, skills for playbooks, MCP for tools), but off the terminal: a calm UI, always on, shared with your team. 

Your coworkers:

- **Know you from the first day.** A short setup on first login: name your coworker, say what your company does and what you need help with. It looks your company up on the web and reads its site, shows what it found for you to fix, and suggests a starter plan of tools and routines. Each teammate gets their own shorter version.
- **Live on the web, in Chrome and on Telegram.** Pick any; same memory everywhere.
- **Remember between sessions.** Markdown notes, a knowledge graph, recent threads.
- **Act on your tools.** Pull Shopify orders, draft Gmail replies, schedule Instagram posts, query GA4, and ask before anything goes out.
- **Reach out first.** Restock alerts, weekly reports, deadlines; they schedule their own follow-ups. A Marketplace of ready-made routines shows what they can take on, with more for each tool you connect; add your own or edit any of them. Each morning they plan your day at 06:00 in your own time zone.
- **Write their own playbooks.** A *skill* is a markdown file describing how to handle a recurring task, editable right from the UI.
- **Keep the task list moving.** Your `Tasks.md` becomes a list or board view with owner, priority, and deadline, kept current as work progresses.
- **Work with your whole team.** One coworker for everyone: each teammate brings their own tools and routines, the team shares a board and files, and work moves between people through it.

<br/>

## Why it's different

- **Built for the whole team, not just engineers.** The power of a terminal AI agent, in a calm UI that non-technical people actually live in.
- **It reasons, it doesn't just route.** Not if-this-then-that automation. It reads the situation, pulls from your tools, decides what to do, then asks before anything goes out.
- **Your server, full source.** Self-hosted on a box you control, one per business: your files, memory and credentials live there. Conversations are answered by Claude through your own plan, the same as when you use Claude directly. You hand it your inbox, store, and ads, so everything it does with that access is public and auditable.

<br/>

<a id="get-started"></a>

## Get started

**Want to look around first?** Click through **[the demo](https://something.md/demo/)**: a made-up ceramics shop with a team of seven, every screen on sample data. Switch between the founder and a teammate to see what stays private. The chat is off; there's no AI behind it.

**You'll need:** a Linux server (from ~€7/mo), a domain, a Google account, and a **paid Claude plan** (Pro or Max). Run the installer from macOS or Linux (on Windows, use WSL2).

Then, from your own computer, run:

```bash
curl -fsSL https://raw.githubusercontent.com/stanislawherjan1/Something/main/install.sh | bash
```

Prefer to read it before running? Download, skim, then execute for the same result:

```bash
curl -fsSL https://raw.githubusercontent.com/stanislawherjan1/Something/main/install.sh -o install.sh
less install.sh    # review exactly what it does
bash install.sh
```

The installer is interactive: it asks for your Google sign-in app, server address, domain, and admin email, then deploys — showing the build as a calm phase checklist, with the full log saved next to your workspace folder. Plan for 45-60 minutes end to end, most of it waiting on the server, DNS, and the first build. Then open your domain, sign in, and a short setup takes it from there.

First time renting a server or pointing a domain? **[Full step-by-step guide →](docs/QUICK_START.md)**

**Not comfortable in the terminal?** Open this repo in an AI coding tool ([Claude Code](https://www.anthropic.com/claude-code), Cursor, or Codex) and ask it to set Something up for you. The repo carries its own agent runbook ([docs/AGENT_SETUP.md](docs/AGENT_SETUP.md)), so the agent knows every step — and secrets stay out of the chat: those you type in your own terminal. You create the accounts (Google, server, domain); the agent does the rest.

<br/>

## Talk to them anywhere

Your coworker is one mind you reach from a few places: the **web workspace chat**, a **Telegram** DM, the **team Telegram groups** it's part of, and **Chrome's side panel**, next to whatever page you're on. Same name, same memory, same context, whichever you reach for.

- **Web chat**: a full workspace alongside your files, skills, and dashboards. Each conversation is its own thread, so a dozen lines of work can run in parallel without blurring together.
- **Chrome side panel**: the same chat beside any tab. It sees the page you're on, and with your go-ahead clicks and types in it for you ([below](#browser)).
- **Telegram**: message them like any contact. Best for on-the-go asks and getting pinged wherever you are.
- **Telegram groups**: add it to a team group and it follows the conversation, chiming in when it's genuinely useful and staying quiet otherwise. It only takes part in groups a teammate brings it into, never barging in on its own.

It's all connected. What you said on Telegram is there when you open the web chat, and the other way round. Each thread stays its own conversation, but your coworker keeps cross-surface awareness: it knows what recently happened on the other channel and draws on it when it helps.

Proactive messages travel the same paths. When a job finishes or a reminder comes due, your coworker pings you on Telegram, in the web app, or both; a web ping is a notification you click straight into its thread.

<br/>

<a id="team"></a>

## One coworker, your whole team

<p align="center">
  <img src="assets/readme/team.png" alt="Collaborative mode switched on, four teammates around it: what each is doing through the coworker right now, their own tools and their own routine" width="820" />
</p>

<br/>

Set it up once and the whole team works with it. Turn on **collaborative mode**, invite your people, and everyone gets the same coworker, in the web app, on Telegram, or in your team groups. It knows who is asking, what they're working on, and how they like to be reached.

**Everyone gets their own.** Each teammate connects their own tools (their inbox, calendar, notetaker, Stripe or GitHub), sets their own routines (a day plan at 8:00, a stock check on Mondays, a recap on Thursdays), writes their own skills, and keeps their own files. The coworker uses them for that person only.

**The team shares the rest.** The task board, the team's files, what everyone has learned, and the tools the admin connects for everyone. Ask *"what is everyone working on this week?"* and it answers from all of it.

**Work moves between people.** Hand off a task, pass on a message, or tell the whole team at once, and it lands where each person will see it, in their language:

> **Mara:** Ask Jonas to chase the supplier about the invoice.<br/>
> **Coworker:** Added to the board for Jonas, due Friday, and let Jonas know on Telegram.

**Private stays private.** Each person's space is theirs, enforced on the server, with no admin bypass. Before something personal from a conversation reaches the team, the coworker asks.

Solo setups are untouched: team mode off means no roles, no split, no routing, just the clean single-user workspace. Full design in **[docs/TEAM_MODE.md](docs/TEAM_MODE.md)**.

<br/>

## A real editor, your coworker writes to it too

<p align="center">
  <img src="assets/readme/editor.png" alt="A markdown document in the editor: a launch plan with a checklist and a timeline table" width="820" />
</p>

<br/>

Everything your coworker works on is plain markdown: notes, skills, reports. The web app opens it in a clean, Notion-style editor (headings, checklists, tables, slash commands), but saves byte-for-byte markdown on disk, so git diffs and the bot's own edits stay clean.

It's a shared surface. You and your coworker edit the **same** files: write a launch checklist and the bot ticks items off as it does the work; ask it to draft a report, then polish it yourself. When it changes a file you have open, the edit flashes in live, and file paths (in chat or in a note) are clickable: mention `Products/pricing.md` and it opens.

<br/>

## Routines

<p align="center">
  <img src="assets/readme/routines.png" alt="Routines the coworker keeps on its own, each with the tools it uses" width="820" />
</p>

<br/>

Tell your coworker what to keep an eye on, and it takes it from there. These are the standing things it handles for you without being asked: scan the inbox each hour, chase threads that have gone quiet, watch approaching deadlines, prep meeting materials the day before. Every morning it plans the day from these routines, together with your calendar, tasks, and open threads.

> **You:** From now on, each morning check Shopify for orders stuck unfulfilled over 48h and flag them.<br/>
> **Coworker:** Added to my routines. I'll check every morning and flag anything stuck.

Under the hood, routines run on **reminders**: a background scheduler that survives container restarts and fires on time (once, daily, weekly, or continuous), reaching you on Telegram, in the web app, or both. You rarely touch it directly: the coworker sets and prunes its own reminders as the routines demand.

<br/>

## Memory

<p align="center">
  <img src="assets/readme/memory.png" alt="The coworker in the middle, the facts it remembers around it, each with where it came from" width="820" />
</p>

<br/>

Your coworker doesn't start from zero each conversation. Every finished conversation is kept, dated, on your server, and from each one it takes the few things worth remembering: a meeting, a decision, a person, a preference. A fact is taken from **your** words, never from the bot's own replies, and it carries the conversation it came from, so you can always see why it believes something.

It keeps one fact per thing. Say something again and the fact gains a source. Change a detail and the fact gets a dated remark under it. Say something is no longer true and the old fact is struck through, with what replaced it. Before answering, it brings in the few excerpts that matter to your message instead of carrying everything in every turn.

Open **AI Settings → Memory**:

- **Short-term memory**: what's going on right now, meetings, trips, deadlines, things it is waiting on, and what it is keeping track of.
- **Facts**: everything it remembers, each with the conversation it came from and its own timeline of earlier versions and corrections. Hide or erase any of them, or erase the whole conversation behind it.
- **Topics**: the people, companies and projects that keep coming up, each with who they are to you and the facts about them over time.
- **Preferences**: the standing rules you stated ("keep answers short", "never email a client without asking").
- **Privacy** (team mode): what the team may see of yours, and the lines it asks you about before sharing.
- **Sources**: what feeds memory besides conversations. Connect a meeting notetaker and each night the day's meetings are read in, notes and transcripts, and remembered like a conversation, each fact with the meeting behind it. A switch per source.
- **Changes**: a log of what memory did: remembered, corrected, merged, hidden, erased, restored.

In a [team workspace](#team) memory splits like the files do: shared memory the team works from, private memory that is only yours. Privacy is enforced on the server by where a thing is stored, never by role: an admin cannot read a teammate's private memory, and the bot won't go digging through it on someone else's behalf.

A new workspace starts on this memory directly. One that started on the older card-based memory moves over from a banner on the Memory screen, with a backup to download first. Full design + operational guide in [docs/MEMORY.md](docs/MEMORY.md).

<br/>

## Integrations

<p align="center">
  <img src="assets/readme/integrations.png" alt="Shopify, Notion, Stripe, Google Workspace, Meta Ads, Linear, GitHub and dozens more" width="820" />
</p>

<br/>

**One-click — sign in, no keys to paste.** Two dozen provider-hosted MCP servers connect with a single popup: sign in, approve, done. No API keys, and nothing for whoever deploys the product to register — the workspace-api OAuth broker registers itself on the fly (Dynamic Client Registration) and completes the flow on the client's own domain.

> Notion · Stripe · Linear · Airtable · Miro · monday.com · Todoist · Cal.com · Calendly · PayPal · Klaviyo · Mailchimp · Cloudflare · Atlassian (Jira/Confluence) · Sentry · Netlify · Neon · Supabase · Webflow · Zapier · Amplitude · Wix · Firecrawl · Parallel Search · Crypto.com · ClickUp · WordPress.com · DeepL · Typeform · Tally · Granola · Fireflies · Fathom · Otter.ai · Read AI · Krisp

**Bring your own credentials.** The rest paste a key, token, or file once — encrypted at rest:

> Shopify · Meta Ads · Google Ads · Google Analytics 4 · Google Workspace · Email (IMAP) · Trello · GitHub · Vercel · X · Grok (xAI) · OpenAI (GPT) · Gemini · Gemini Image · Seedream · SignWell · Docs Comments

You connect each one from the Integrations screen, no redeploy, no `.env` editing. In a team workspace an admin connects a service for the whole team (read-only or read and write; Telegram is always the whole team's, reading and sending) and anyone can connect their own account of a notetaker, calendar or task board for themselves — used in their conversations only. Credentials are encrypted at rest; disconnecting wipes the secret. Setup details in [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

<br/>

<a id="browser"></a>

## Right next to your browser

<p align="center">
  <img src="assets/readme/browser.png" alt="A page open in the browser with the side-panel chat next to it, one element on the page picked out" width="820" />
</p>

<br/>

Install the Chrome extension from the workspace's **Browser agent** page and your coworker sits in the side panel, beside whatever you're looking at. It's the same chat, with the same memory and conversations, and it knows which page you're on.

- **It looks by itself.** Ask *"which of these orders are late?"* and it reads the page or takes a screenshot on its own. No copy-pasting, no "can you send me a screenshot".
- **It works in the page when you let it.** Flip the **Act** switch and it clicks, types, picks from dropdowns and scrolls for you: filling in a form, searching a site, working through a multi-step flow. You watch a cursor move as it goes, and it stops the moment you switch Act off.
- **It uses the API when that's better.** On a page of a service it's connected to, such as a calendar event, a Miro board or an email, it hands the job to the integration instead of clicking: *"move this meeting to 3pm"* becomes one Calendar call, not ten clicks.

It is fenced in code, not in the prompt: it stays on the site you're on, never touches password, one-time-code or card fields, refuses password managers, and while it can act on a page it has no way to send anything out. What a web page says is treated as content, never as an instruction. Full details in **[docs/BROWSER_EXTENSION.md](docs/BROWSER_EXTENSION.md)**.

<br/>

## Self-hosted, end-to-end

Each business gets its own server, isolated by design: your coworker, your files, your tools, nobody else's. Conversations are answered by Claude through your own plan, and nothing passes through our servers. They live there 24/7 listening for Telegram messages; the web workspace runs at your own subdomain, gated by Google login and a team whitelist.

Every line of code is public. You give your coworker access to your inbox, your store, your ads, so you should be able to see exactly what they do with that access. Architecture in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), threat model in [docs/SECURITY.md](docs/SECURITY.md).

<br/>

## Deploy your own

Requires a Linux server (a Hetzner VPS from ~€7/mo works well), a domain, and a paid Claude plan. Nothing runs locally; `deploy.sh` SSHs into the server and builds there.

The easiest way is the installer in [Get started](#get-started). Once a client dir exists, redeploying is a one-liner:

```bash
cd clients/my-client && ./deploy.sh
```

Beginner walkthrough in [docs/QUICK_START.md](docs/QUICK_START.md). End-to-end manual onboarding in [docs/NEW_CLIENT.md](docs/NEW_CLIENT.md). Operations reference in [docs/DEPLOY.md](docs/DEPLOY.md).

<br/>

## Docs

**Start here**
- **[QUICK_START.md](docs/QUICK_START.md)**, first deployment, beginner-friendly: buy a server, point a domain, one command. Start here if it's your first time.
- [NEW_CLIENT.md](docs/NEW_CLIENT.md), the manual, click-by-click version of the same flow; also how an operator onboards additional deployments with full control over each step.

**Reference**
- [INTEGRATIONS.md](docs/INTEGRATIONS.md), the integration catalog, self-service activation, encrypted credentials
- [SKILLS.md](docs/SKILLS.md), reusable Claude playbooks + dashboard editor
- [MEMORY.md](docs/MEMORY.md), how memory works: conversations kept whole, one fact per thing, topics, privacy, the nightly run, moving an older workspace over
- [ROUTINES.md](docs/ROUTINES.md), routines, the morning planner, and reminders and how they fire
- [BROWSER_EXTENSION.md](docs/BROWSER_EXTENSION.md), the Chrome side panel: Look, Act, the hand-off to integrations, every limit and where it is enforced
- [TEAM_MODE.md](docs/TEAM_MODE.md), collaborative workspaces: roster & roles, Shared vs Personal files/memory, per-recipient reminders, task assignment, cross-surface relay
- [ARCHITECTURE.md](docs/ARCHITECTURE.md), system design and data flows (with a glossary up top)
- [SECURITY.md](docs/SECURITY.md), threat model, auth layers, vulnerability reporting
- [DEPLOY.md](docs/DEPLOY.md), production deployment & day-2 operations reference
- [CONTRIBUTING.md](CONTRIBUTING.md), conventions, PR vs direct push

<br/>

## License

Open source under [AGPL-3.0](LICENSE). Made by stan corp.
