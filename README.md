<h1 align="center">Something</h1>

<p align="center">
  <b>Your own AI coworker. Runs 24/7, knows your business, works with your team.</b>
</p>

<p align="center">
  <sub>
    <a href="#get-started">Get started</a>
    &nbsp;·&nbsp;
    <a href="#demo">Demo</a>
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
  <img src="assets/hero.png" alt="The web workspace: file vault, markdown editor, embedded chat" width="820" />
</p>

<p align="center">
  A coworker that knows your context: your tools, your customers, your goals.<br/>
  You reach it on Telegram or a private web workspace, and it acts on your behalf, not just answers.
</p>

<br/>
<br/>

## What they do

Everything you'd reach for to automate your work (markdown for context, skills for playbooks, MCP for tools), but off the terminal: a calm UI, always on, shared with your team. 

Your coworkers:

- **Have a name and a personality.** Set once in the first-login wizard.
- **Live on Telegram and the web.** Pick one or both; same memory either way.
- **Remember between sessions.** Markdown notes, a knowledge graph, recent threads.
- **Act on your tools.** Pull Shopify orders, draft Gmail replies, schedule Instagram posts, query GA4, and ask before anything goes out.
- **Reach out first.** Restock alerts, weekly reports, deadlines; they schedule their own follow-ups.
- **Write their own playbooks.** A *skill* is a markdown file describing how to handle a recurring task, editable right from the UI.
- **Keep the task list moving.** Your `Tasks.md` becomes a list or board view with owner, priority, and deadline, kept current as work progresses.
- **Work with your whole team.** Turn on collaborative mode: everyone signs in with their own account and a private space beside the shared one, and your coworker routes reminders, tasks, and messages to the right person.

<br/>

## Why it's different

- **Built for the whole team, not just engineers.** The power of a terminal AI agent, in a calm UI that non-technical people actually live in.
- **It reasons, it doesn't just route.** Not if-this-then-that automation. It reads the situation, pulls from your tools, decides what to do, then asks before anything goes out.
- **Your server, your data, full source.** Self-hosted on a box you control, one per business. You hand it your inbox, store, and ads, so everything it does with that access is public and auditable.

<br/>

<a id="get-started"></a>

## Get started

**You'll need:** a Linux server (from ~€4.50/mo), a domain, a Google account, and a **paid Claude plan** (Pro or Max). Run the installer from macOS or Linux (on Windows, use WSL2).

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

The installer is interactive: it asks for your Google sign-in app, server address, domain, and admin email, then deploys. Plan for 45-60 minutes end to end, most of it waiting on the server, DNS, and the first build.

First time renting a server or pointing a domain? **[Full step-by-step guide →](docs/QUICK_START.md)**

**Not comfortable in the terminal?** Open this repo in an AI coding tool ([Claude Code](https://www.anthropic.com/claude-code), Cursor, or Codex) and ask it to run the installer, read back errors, and customize the project for you. You create the accounts (Google, server, domain); the agent does the rest.

<br/>

## Demo

<p align="center">
  <img src="assets/workspace.png" alt="The web workspace: file vault, markdown editor, embedded chat" width="820" />
</p>

<br/>

## Talk to them anywhere

Your coworker is one mind you reach from a few places: the **web workspace chat**, a **Telegram** DM, and the **team Telegram groups** it's part of. Same name, same memory, same context, whichever you reach for.

- **Web chat**: a full workspace alongside your files, skills, and dashboards. Each conversation is its own thread, so a dozen lines of work can run in parallel without blurring together.
- **Telegram**: message them like any contact. Best for on-the-go asks and getting pinged wherever you are.
- **Telegram groups**: add it to a team group and it follows the conversation, chiming in when it's genuinely useful and staying quiet otherwise. It only takes part in groups a teammate brings it into — never barging in on its own.

It's all connected. What you said on Telegram is there when you open the web chat, and the other way round. Each thread stays its own conversation, but your coworker keeps cross-surface awareness: it knows what recently happened on the other channel and draws on it when it helps.

Proactive messages travel the same paths. When a job finishes or a reminder comes due, your coworker pings you on Telegram, in the web app, or both; a web ping is a notification you click straight into its thread.

<br/>

<a id="team"></a>

## One coworker, your whole team

<p align="center">
  <img src="assets/team.png" alt="Team dashboard, roster with roles and avatars, channel links, and the Shared / Your Files split" width="820" />
</p>

<br/>

Flip on **collaborative mode** and your coworker stops being only *yours*; it becomes the team's, while still knowing each of you as an individual. Everyone signs in with their own Google account, and an admin keeps the roster: invite people, set roles (admin or member), link their Telegram.

Now there's a shared workspace and a private one for each person, side by side:

- **Shared**: the files, the task board, and the team-wide memory everyone works from.
- **Yours**: your own files and your own memory cards, scoped to you. A teammate can't read them, and your coworker won't go digging through them on someone else's behalf.

The default is collaboration, not secrecy: ask *"did Mara finish the report?"* and it answers from the shared work. Private cards are the exception, and they stay private.

Because it knows the whole team, it routes work to the right person, and carries messages between you:

> **You:** Remind Mara to send the review tomorrow morning.<br/>
> **Coworker:** Done. I'll ping Mara at 9:00 tomorrow, in her workspace, and on Telegram since that's how she likes to be reached.

Reminders and tasks can target one teammate or *everyone*, and a task's owner is a real face on the board. You can also talk *through* your coworker: it delivers your message into a colleague's workspace or Telegram, in their language, phrased like a person, not a forwarded memo.

Solo setups are untouched: team mode off means no roles, no split, no routing, just the clean single-user workspace. Full design in **[docs/TEAM_MODE.md](docs/TEAM_MODE.md)**.

<br/>

## A real editor, your coworker writes to it too

<p align="center">
  <img src="assets/editor.png" alt="The native markdown editor, checklists, formatting toolbar, and clickable file paths" width="820" />
</p>

<br/>

Everything your coworker knows is plain markdown: notes, skills, memory, reports. The web app opens it in a clean, Notion-style editor (headings, checklists, tables, slash commands), but saves byte-for-byte markdown on disk, so git diffs and the bot's own edits stay clean.

It's a shared surface. You and your coworker edit the **same** files: write a launch checklist and the bot ticks items off as it does the work; ask it to draft a report, then polish it yourself. When it changes a file you have open, the edit flashes in live, and file paths (in chat or in a note) are clickable: mention `Products/pricing.md` and it opens.

<br/>

## Skills

<p align="center">
  <img src="assets/skills.png" alt="Skills dashboard, reusable playbooks the coworker runs, each with its integration badge" width="820" />
</p>

<br/>

A *Skill* is a markdown file that tells your coworker how to handle one recurring task, like a job description for a single responsibility.

```markdown
---
name: weekly-ads-review
description: Every Monday, pull the last 7 days of Meta + Google Ads and post a one-pager.
---

Compare ROAS to the previous week. Flag any campaign that dropped >20%.
Surface 2-3 budget moves. Save to Reports/.
```

Create, edit, and delete skills from the dashboard. Integration-specific skills auto-install when the matching integration is activated. See [docs/SKILLS.md](docs/SKILLS.md).

<br/>

## Reminders

<p align="center">
  <img src="assets/reminders.png" alt="Reminders dashboard, pending pings with relative due time and timezone" width="820" />
</p>

<br/>

Tell your coworker when to ping you, and they will: once, daily, or weekly. Reminders survive container restarts, reach you on Telegram, in the web app, or both, and live in a tidy dashboard you can edit by hand.

> **You:** Each morning, check Shopify for orders stuck unfulfilled over 48h and flag them.<br/>
> **Coworker:** Done. I'll run that daily at 9:00 and ping you with anything stuck.

Your coworker also schedules its own (a Monday ad-spend review, a first-of-the-month revenue pull) whenever a recurring rhythm makes sense.

<br/>

## Memory

<p align="center">
  <img src="assets/memory.png" alt="Memory dashboard, graph of cards, topics, and rolling snapshots" width="820" />
</p>

<br/>

Your coworker doesn't start from zero each conversation. A small markdown wiki under `project/memory/` holds the basics (who you are, your team, your hard rules, what each integration can do) plus rolling snapshots of recent web and Telegram exchanges. It loads into the system prompt every turn, so you never re-explain context. In a [team workspace](#team) it splits like the files do: shared cards everyone works from, private cards that are only yours.

Open **AI Settings → Memory** to see it as a graph: cards (facts), topic pages (long-form), and the rolling snapshots, all linked. Click a node to open the file, or search to highlight. The bot maintains it itself: writing new facts after each session, promoting overgrown sections to their own pages, and reminding itself of past mistakes before it repeats them.

Inspired by [Karpathy's LLM-wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern, and built in collaboration with [@jandziew](https://github.com/jandziew). Full design + operational guide in [docs/MEMORY.md](docs/MEMORY.md).

<br/>

## Integrations

<p align="center">
  <img src="assets/integrations.png" alt="Shopify · Gmail · Gemini · Google Ads · Meta, and more" width="820" />
</p>

<br/>

| Integration | What it gives your coworker |
|---|---|
| Shopify | Orders, products, inventory; draft orders, fulfillments |
| Meta Ads | Instagram + Facebook ads, campaigns, audiences, Page/IG insights |
| Google Ads | Campaigns, ad groups, keywords, Keyword Planner, reports |
| Google Analytics 4 | Traffic, events, conversions, queried from chat |
| Google Workspace | Docs, Sheets, Calendar, Drive, Slides, Tasks, one OAuth, six services |
| Email (IMAP) | Multi-account inbox (Gmail / Zoho / custom); read by default, sending opt-in |
| Trello | Cards, comments, labels, move between columns |
| GitHub | Repos, issues, pull requests |
| Substack | Posts, authors, Notes; optional write access |
| X | Tweets, profiles, replies, mentions (via twitterapi.io) |
| Grok (xAI) | Live X + web search, real-time takes, fact-checks |
| OpenAI (GPT) · Gemini | Second opinions from GPT-5 / Gemini 2.5 |
| Image generation | Seedream 4.5 + Google Imagen 3 / Gemini, generate & edit |
| SignWell | Send documents for e-signature |
| Docs Comments | Inline comments anchored to text in Google Docs |

You activate each one from the Integrations dashboard, no redeploy, no `.env` editing. Credentials are encrypted at rest; removing an integration wipes the secret. Setup details in [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

<br/>

## Self-hosted, end-to-end

Each client gets their own server. One per business, isolated by design: your data, your coworker, your tools, nobody else's. They live there 24/7 listening for Telegram messages; the web workspace runs at your own subdomain, gated by Google login and a team whitelist.

Every line of code is public. You give your coworker access to your inbox, your store, your ads, so you should be able to see exactly what they do with that access. Architecture in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), threat model in [docs/SECURITY.md](docs/SECURITY.md).

<br/>

## Deploy your own

Requires a Hetzner VPS (from ~€4.50/mo), a domain, and a paid Claude plan. Nothing runs locally; `deploy.sh` SSHs into the VPS and builds there.

**The easy way**: the interactive installer (see [Get started](#get-started)):

```bash
curl -fsSL https://raw.githubusercontent.com/stanislawherjan1/Something/main/install.sh | bash
```

**The manual way**: once a client dir exists, deploy is a one-liner:

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
- [MEMORY.md](docs/MEMORY.md), Karpathy-style LLM-wiki: cards, topics, rolling snapshots, reflect-bots
- [TEAM_MODE.md](docs/TEAM_MODE.md), collaborative workspaces: roster & roles, Shared vs Personal files/memory, per-recipient reminders, task assignment, cross-surface relay
- [ARCHITECTURE.md](docs/ARCHITECTURE.md), system design and data flows (with a glossary up top)
- [SECURITY.md](docs/SECURITY.md), threat model, auth layers, vulnerability reporting
- [DEPLOY.md](docs/DEPLOY.md), production deployment & day-2 operations reference
- [CONTRIBUTING.md](CONTRIBUTING.md), conventions, PR vs direct push
