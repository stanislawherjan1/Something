# Memory

**How the bot remembers things between sessions and across channels.**

---

## User guide

Your coworker keeps every finished conversation, dated, on your own server.
From each one it takes the few things worth remembering: a meeting, a
decision, a person, a preference. A fact is taken from **your** words, never
from the bot's own replies, and every fact keeps the conversation it came
from, so you can always see why it believes something. Before it answers, it
reads the few past excerpts that matter to your message instead of carrying
everything in every turn.

It keeps **one fact per thing**. Say something again and the fact gains a
source. Change a detail ("it's at 14:30, not 13:00") and the fact gets a dated
remark under it. Say something is no longer true ("I didn't get the job") and
the old fact is struck through, with what replaced it next to it. You correct
it the way you would a colleague: just tell it.

**The Memory screen** (AI Settings → Memory):

- **Short-term memory**: what is going on right now (meetings, trips,
  deadlines, things it is waiting on) and what it is keeping track of.
- **Facts**: everything it remembers, newest first, each with the conversation
  it came from ("See source") and its own timeline of earlier versions and
  corrections. **Hide** takes a fact off the screen and out of the bot's reach;
  it comes back from Changes for 30 days, then it is gone. **Erase** removes
  it for good at once, and the same words cannot be learned again. Erasing
  the whole conversation lives behind "See source".
- **Topics**: the people, companies and projects that keep coming up (a tile
  appears once a name comes up in three conversations), each with one line
  saying who they are to you and the facts about them over time. Two
  spellings of one person are merged for you; you can merge or separate them
  yourself, and remove a topic you don't want tracked.
- **Preferences**: the standing rules you stated ("keep answers short",
  "never email a client without asking"). They are read on every turn.
- **Sources**: what feeds memory besides conversations. A meeting notetaker
  you have connected (Granola, Fireflies, Fathom, Otter, Read AI, Krisp) is
  read in each night: its notes and transcripts become facts of yours, each
  with the meeting behind "See source" and the service's icon after its title.
  A switch per source, here and on the integration's card; "Read now" reads
  it at once.
- **Privacy** (team mode): what you shared with the team, and the lines the
  bot asks you about before sharing them.
- **Changes**: a log of what memory did (remembered, corrected, merged, hidden,
  erased, restored, topics merged or removed), with undo where there is one.

**Yours and the team's.** In a team workspace memory splits like the files do:
shared memory the team works from, and a private memory for each person. What
you say in your own chat stays yours unless you share it; the bot asks before
sharing a borderline business line. Privacy is enforced by where a thing is
stored, never by role: an admin cannot read a teammate's private memory, and
the bot never reads one person's private memory on another's behalf. A
Telegram group has a memory of its own, readable by its members.

**Meetings you did not tell it about.** Connect a meeting notetaker and you
need not recount your meetings: each night the coworker reads the meetings of
the day, and what was said in them is remembered the way a conversation is —
one fact per thing, a change as a dated remark, the meeting itself a click
away. It only ever reads into your own memory; nothing from a meeting reaches
the team unless you share it.

**New and older workspaces.** A new workspace starts on this memory from day
one. A workspace set up before it keeps its old notes until an admin moves it
over from the banner on the Memory screen; until then the new memory already
collects conversations in the background, so nothing from the waiting time is
lost. Everyone can download their own memory before the move, and for 30 days
after it the old memory can still be restored by the operator.

---

## How it works

Measured on real conversations before it was built: the v3 cards loaded ~70 KB
into every turn, missed about a quarter of what mattered (a fact is saved only
if a model notices it), and kept stale claims alive. v4 keeps **every finished
conversation, whole**, and hands each turn the few excerpts that matter to it.

### Modes (`MEMORY_V4`)

| Value | What happens |
|---|---|
| `off` | v3 only. The kill switch: `off` wins over everything below. |
| `shadow` (default) | v3 as before; v4 files conversations into the ledger in the background. Admins see the upgrade bar. A fresh workspace — nothing but untouched seed templates in `memory/` — does not wait for anyone: boot applies the move itself and it is `on` from the first day. |
| `read` | v4 prefix, recall block and tools; the v3 sweep still runs. For testing on the canary. |
| `on` | v4 is the memory; the v3 sweep stands down. |

Moving the old memory in (migration `0005`, from the upgrade bar) switches a
`shadow` or `read` deployment to `on` for good (a stamp in `memory/_engine/`);
only `MEMORY_V4=off` overrides it. The same migration runs by itself at boot
when it is *trivial* for the deployment — nothing anyone wrote would move or
go: a seed template nobody edited is a view, not content, and goes without a
record. The moment a card or page carries a person's words (a filled-in
duties card included), the move waits for an admin.

### The ledger — the ground truth

Append-only JSONL, one tree per scope, so the path rules that guard the rest of
`memory/` guard it too:

```
memory/ledger/YYYY-MM.jsonl                   shared (the team)
memory/users/<slug>/ledger/YYYY-MM.jsonl      one person
memory/groups/<chatId>/ledger/YYYY-MM.jsonl   one Telegram group
```

A record is a conversation chunk (≤ ~2500 characters, cut at message
boundaries — the unit retrieval was measured on) with up to two **notes** (the
Facts rows), optional tags (status with an expiry date, stated rules, names of
people/companies/projects) and its source. Hide/unhide are overlay flags; the
only destructive operations are an owner's **erase** and the purge of records
hidden more than 30 days — both physical, both leave a content-free tombstone
(per record *and per line*, so re-reading a raw log cannot bring erased content
back). Every view, vector and index is rebuilt from the ledger.

### Writing: the consolidator

The person's words are the memory; the assistant's reply is context. A note's
evidence and a topic's name must be attested in what people said — never only
in the assistant's turn — and each assistant turn is kept to one short line in
the record. Otherwise "what do you know about me?" answered from memory came
back as new facts and topics about the person, and memory fed on itself. The
one exception is a reply the assistant wrote **after a tool that reads the
world** (the web transcript keeps the tool steps): "I checked both registries —
the company is still not struck off" is what it found, not what it remembered.
Such a turn is labelled `(after checking)` in the record, kept in full, and
counts as a source for facts and names; the notes prompt is told the
difference. Which tools read the world is an **allowlist** — the built-in
readers (web, files), the browser tab, and every integration in the catalog
except the ones that generate, translate or deliver (the chat models, image
generation, DeepL, Telegram). Everything else — no tool, a memory tool
(`memory_*`), a skill load, a setting saved — is a recital, whatever the tool
is called. (It used to be a deny list of memory tools; the day `memory_now`
was missing from it, a "what's in Right now?" answer came back as three fresh
facts, one carrying a guessed trip end the person had never said.)

How many notes a conversation may yield grows with what the person said (two,
one more per eight lines of theirs, four at most), and a note's quote may be
near-verbatim (four words in five, in order, inflections and diacritics
forgiven) — a strict verbatim check on Polish quotes dropped real facts without
a trace. A note whose quote is found nowhere in what was said is **dropped**
(it used to be kept with an `unverified` mark; on real data the marked notes
were the invented ones, and a mark on a screen is not a guard). A quote found
only in the assistant's own turn is a recital and is dropped too. Lines shared
with the team keep the strict verbatim rule: that one is the injection boundary.

**Dates stand on words.** For a status the model also quotes where the day
comes from (`whenFrom`) and, if an end was said, where that comes from
(`expiresFrom`); each quote must be in what was said, and an end's quote must
carry a digit. A status whose end was not said has none — it shows in "Right
now" from its day and for two weeks after its last mention, never with a
made-up end ("for a few days" once became "until 11 Oct", was recited by the
bot and filed again as if the person had said it). A meeting or a deadline
ends the day it happens.

`lib/memory-consolidator.js`, poked every minute by the snapshot monitor. A
conversation that has been quiet for 15 minutes is filed **whole** in its
owner's scope — web chat → that user, a Telegram DM → the roster person whose
chat it is (a stranger's chat → nobody), a registered group → that group's
scope. Code decides the owner, never a model. Two small-model calls then only
*add*:

- **the router** (1:1 conversations) picks lines the whole team may also read.
  Every shared line must be word-for-word in the conversation, so an invented or
  injected line cannot reach shared memory; a router failure shares nothing and
  loses nothing. Borderline business lines become a question on the owner's
  Privacy screen and are shared only if they say so. That screen lists what a
  person shared as the facts a record holds, never the conversation itself, and
  only while team mode is on — alone, there is nobody to share with.
- **the notes pass** writes a few durable notes (two, one more per six lines
  the person wrote, six at most) — each a title, a description, verbatim
  evidence and the names it is about — plus any
  standing rule the person stated, and the names the conversation is about
  (every word of a name must appear in the text — an extractor cannot add a
  surname).

A window with no human message (a reminder nobody answered) is not filed.
With `MEMORY_TRACE=1` the consolidator also appends one line per filed window to
`memory/_engine/trace.jsonl` — every line's standing (said / found, with the
tools / recital), the candidates kept and the ones rejected with the reason —
which is how a change to the pipeline is checked against real conversations
before it ships (a shadow replay; see the operator notes).
Nothing else writes facts: the former nightly day and week reviews
re-extracted the same days a second time, in other words, and the copies
survived dedup often enough to clutter Facts and "Right now" — they are gone.
What a single conversation's notes miss is the price; the digest and the
who-lines (views, not facts) still read the whole period.

### Fed by integrations

`lib/memory-sources.js`. A meeting from a connected notetaker becomes a
**record** the way a conversation does, in the private scope of the person it
is read for — `source: 'integration'`, `conv: import:<id>:<item>`, `ts` the
meeting's time, `tags.import` holding the service, the item id, title, people
and link — and the facts store and the nightly run treat it like any other
record. The service's notes are one record; the transcript is filed in
conversation-sized parts; each record's text opens with the meeting's
heading ("Meeting: <title>", "With: <participants>") — never the service's
name, which is the record's source and was once read as a party ("Szymon of
Granola"). **One meeting is one fact.** The meeting is read whole, in one
pass (`router.meeting`: the app is never a party, anonymous speakers are
never assigned, a person's employer only from the words): a status about
the meeting on its day, titled by code ("Call with Szymon Kubicki (5 Oct
2026)"), its summary as the description (what it was about, what was
decided, who committed to what), the names it was about, on the notes record
(standing `found`) or the first part. Only what lives on after the call and
has a day — a follow-up, a deadline, at most two — is filed on its own,
grounded in the words like any note (`whenFrom`, `dayStated`) and pinned
to the part that holds them (standing `said`). Twenty-six parts read one by
one once gave eleven facts from one hour, each meaningless outside the call.
A chat-made "call with X" on the same day keys with the import and shows
once; two imported meetings with the same person on one day do not key with
each other. The item id dedupes; an erased meeting is tombstoned like any
record and never learned again.

What can feed memory is declared in the catalog (`memory: { kind, default,
what }`; today the six notetakers, `kind: meetings`, on by default). Whether
a person's connected feeder is on is their own setting
(`memory/_engine/sources.json`), read and written by Memory → Sources
(`/api/memory/v4/sources`) and by the switch on the integration's card.

The fetch is **code, at 02:00 the person's time** (before the 04:00
tidy-up; `startImports`, a ten-minute tick): workspace-api reads the service
itself as an MCP client (`lib/integrations/mcp-client.js` — the person's
OAuth token from the store, the egress proxy's open listener, one connection
per run) through the service's feeder (`lib/memory-feeders/`: list the items
since a time, get one item's notes and transcript — Granola's reader checked
against its live server; Fireflies, Fathom, Otter, Read AI and Krisp read by
`generic.js`, which takes the tool names each service publishes and fills
the arguments from the schema the server itself declares; Fathom's tools
were checked live)
and files each new item through `importItem` — the records first, each marked
pending until the meeting pass has run (an import stopped halfway finishes
on the next run, a finished item answers "already"). No model in the fetch:
the
first version had a headless turn pass the transcript to `memory_import`
verbatim, and the model spent twenty minutes re-emitting one transcript as
a tool argument (and, with `--tools ''`, still ran shell commands through a
built-in — see SECURITY §23). A service whose answer the reader cannot read (a renamed tool, a changed
shape) is read that night through such a turn (`runHeadlessTurn`: a strict MCP config of that service
and workspace-api, every built-in tool refused by name, the memory write
and delivery tools disallowed, a 30-minute stop), for its **notes only**,
never a transcript. The window starts a day before the newest meeting
imported (two days on a fresh source, never more than a week back), so a
skipped item is caught next time and a repeat is harmless. "Read now" on
the Sources tab runs the same read at once. The import route
(`/internal/memory/v4/import`, turn token; the bot's `memory_import`)
refuses a group turn, an integration that is not a feeder, not connected,
or switched off for that person. Changes logs "Imported a meeting from …"
with counts only. To check a newly connected notetaker before a night depends
on it: `node bin/probe-feeder.mjs <id>` (as wsapi in the container) lists the
server's tools, the meetings the reader parses and, for the newest, which
fields came back — names and lengths only, never what was said.

### Reading

- **The prefix** (cached): the product rules from the v3 preamble, identity and
  tool cards, `RULES`, `CHANNELS`, the person's `USER_PROFILE` and
  `USER_PREFERENCES`, their routines (`routines.json`), **STANDING_RULES** —
  only the rules people stated — and, last, **WHAT_IS_GOING_ON**: the Memory
  screen's Short-term memory as the bot sees it (statuses still in force, then
  the digest, one line per thing with its state). It changes nightly, so it
  comes after the cards that rarely change. A group turn gets the same card from
  the group's own digest and the shared statuses (never anyone's private memory):
  without it the group brain answered "is X dead?" from old shared pages while
  the group's digest said "closed". No INDEX, no RECENT tails. The
  CLI's own auto-memory is switched off for every turn and memory call
  (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`): a second memory next to this one
  answered "what do you remember" with months-old notes of its own.
- **The recall block**: before each web/group turn, the ten excerpts most
  relevant to the message and the two turns before it (BM25 + vectors, fused by
  rank), oldest first, with a coverage line ("10 of N records") and the reader
  rules (the later record wins; say you don't know rather than guess). It goes
  in front of the **user message** — a system-prompt change voids the prompt
  cache. Fenced as data; excerpts cannot close the fence. Shown once per
  session. A page turn (the browser panel) gets none. **Topic anchors:** when the
  message names a topic (any spelling its tile gathered), that topic's two newest
  records join the block whatever the ranking said — a dozen old pages matching
  the words crowded out the one record that answered.
- **Tools** (offered only with `read`/`on`): `memory_search`, `memory_timeline`,
  `memory_note` (private by default, shared only when asked; takes the fact as
  it now stands **and the person's own words it comes from** — a name that is
  in neither those words nor memory is refused by name, so a correction cannot
  arrive with an invented first name — the person's own name in any form and a
  year that follows from today are never "new"; a note about several things
  is split into one entry per thing, each grounded in the words, and a part
  the words do not carry is left out and said so; each entry is then judged
  against what memory holds — a repeat confirms, more detail merges, a changed
  detail becomes a dated update under the fact, something no longer true marks
  the old fact as such — and the tool answers what it did),
  `memory_forget`
  (the `memory-notes` skill says how a note is written: it must stand on its
  own months later — what it is about, who, when, what was decided, where it
  came from; pasted meeting notes are one "Call with <who> (<date>)" note that
  merges with the notetaker's; when the bot cannot say what or who, it asks first);
  (hides; erased for good after 30 days), and `memory_now` — the person's
  current settings, "Right now", "What I'm keeping track of" and routines,
  fetched fresh. The Telegram brain's prefix is loaded once per session and can
  be days old; the morning planner starts every run with `memory_now`.
- **The Telegram brain proves who it is** with a token the entrypoint writes at
  boot (`IDE_TURN_ID`, its hash in `/var/wsapi-store`). `bot.sh` exports it in
  solo mode too — it used to be team-mode only, so on a solo workspace every
  `memory_search`/`memory_timeline` from Telegram failed with "no turn identity".
- Summaries (the digest, reviews) are **not** used for answering questions —
  measured, they made answers confident and stale. They feed the Memory screen
  and the planner.

Scopes a turn may read come from its identity, never from the model: a person
reads their own scope, shared, and the groups they are in; a group turn reads
shared + that group; there is no admin bypass.

### Search and the embedder

`lib/memory-search.js`: BM25 per scope plus cosine over vectors from
`multilingual-e5-small` (int8 ONNX), reciprocal-rank fusion, k = 10. The
embedder is a worker workspace-api forks on first use (`apps/embedder`) — its
own process, minimal environment, IPC only, exits after 30 idle minutes. Without
it search runs on BM25 alone (measured 0.75 vs 0.80). Vectors are kept per scope
in `_vectors.json` next to the ledger and pruned when a record is erased. The
model is pinned by revision and sha256 and fetched by `deploy.sh` on the deploy
host.

Two things bend the words without word lists. A query word matches a record's
word when the two differ only in a suffix ("Bergman" / "Bergmana",
"Lindholm" / "Lindholmowi": five letters or more, the same first four or all but
the last two of the shorter one, lengths within three) — a form that changes a
root (a dropped vowel) is not caught here. And a query that names a topic by
any of its spellings is searched by all of them (`views.expandQuery`): the
tile's spellings, the owner's merges and the nightly `aliases` decisions. The
bot's excerpts stay oldest first (the order it reasons in); the Memory screen's
search shows the topics the words name, then the facts about them best match
first (a fact scores by the query words its title and text carry; the
conversation it stands on being found only breaks ties), then the excerpts the
bot would recall, most relevant first.

### Facts — their own store

A **record** is a conversation: evidence, written once, never edited. A **fact**
is what memory took from it, and lives in its own file next to the scope's
ledger — `memory/facts.jsonl` (shared), `memory/users/<slug>/facts.jsonl`,
`memory/groups/<id>/facts.jsonl` — so privacy is still the path
(`lib/memory-facts.js`). The file is append-only events, folded on read:

- `add` — a new fact with a stable id, the record it rests on, the words it
  stands on (`evidence`), its standing (`said` for a person's words, `found` for
  what the assistant found with a tool, `note` for `memory_note`, or `legacy`
  for what was migrated), who wrote it, and two times: `ts`, the
  conversation's (the story; a replacement takes the later of the two), and
  `at`, when memory learned it — the Facts tab lists by `at`, newest first,
  so a meeting read at night sits under that night, and an earlier version
  says until when it stood;
- `confirm` — the same thing said again: one more source (shown as "N sources");
- `replace` — it changed: the old fact is history, `by` names the **fact** that
  took its place (never a record — a record that held no note once retired a fact
  that way). It is a live relation: hide or erase the newer fact and the older
  one is current again;
- `replace … why: superseded` — the new fact says the old one is no longer true
  as a whole; the old is struck through under Past & superseded, and the new
  one does not inherit its sources;
- `update` — a correction of one claim: a dated remark with the record it
  stands on, kept with the fact (shown on its timeline, read with it by the
  bot); the fact's own words and id do not change. An update's record is not a
  source of the fact: hide or erase the conversation the fact came from and the
  fact goes, remark or no remark; erase the update's conversation and the
  update leaves the file with it;
- `amend` — a title, names, or for a status what it is about and when, added later;
- `retire` (legacy, `why: superseded` from the old notes) and `erased` (a text
  hash that keeps the same words from being learned again);
- `hide` / `unhide` — off the screen and back; a fact hidden 30 days is erased.

Erasing a fact rewrites the file without any line of it and keeps the hash of
its text and of each update's text, so the same words cannot be learned again.
A fact whose every record is hidden leaves the screen with them; erase its last
record and it is erased too. A fact with other records survives one of them going.

**Titles.** Every fact is a **title** (3 to 8 words, like a heading: "Trip to
Lisbon") plus a **description** (one or two self-contained sentences with the
context someone needs months later; the extractor's notes are cut at 400
characters and anything the store writes — a description, a merged text, an
update — at 1,200, always at the last whole sentence, never mid-word; the
full text stays in the record behind "See source"). A status also has **about** (meeting,
travel, deadline, waiting, other) and **when**. A fact that arrives without a
title gets one in the nightly run (an `amend`; the text never changes); the
operator can force it with `node bin/title-notes.mjs`.

### One fact per thing

`facts.remember()` is the only writer of new facts: the consolidator (per
record) and `memory_note` (and `memory_write`'s fallback) all go through it.
Per candidate, against the facts **current in the same scope**:

- **by key first.** A meeting, trip or deadline with a day and a name its text
  carries has a key — `meeting|2026-10-05|marekkowal`. Two keys match when the
  kind and day are equal and one name starts the other ("Marek" and "Marek
    Kowal" are one lunch, "Marek" and "Jan" two). The same key **is** the same
  thing: confirmed with no model call when the new words add nothing, replaced
  when they carry everything the old one had plus a change (a moved time, a
  place) — the replacement keeps every source and every update of the old one;
  when neither covers the other, the judgment below decides, with all its verdicts;
- **otherwise by meaning.** The five closest current facts by embedding (cosine
  ≥ 0.80; word overlap when the embedder is down) — none close → added, no model
    call — unless the note names someone or something: then the newest current
  facts sharing that name are judged, so a terse correction ("it was X, not Y")
  still reaches its fact; else one model call (`MEMORY_V4_DECIDE_MODEL`, Sonnet
  by default — the one judgment that must not be cheap, made a few times a
  night and on `memory_note`), which sees each existing fact with its updates: `same` (confirm) | `merge` (the same item, one wording: a
  replace whose text keeps every name, number and date of both — the code
  refuses one that drops any) | `corrects` (one claim of a richer fact changes:
  the fact keeps its words and the new note is kept with it as a dated remark —
  an `update` event, shown on the fact's own timeline under its description —
  earlier versions, the current wording, dated updates — and read with it by
  the bot; nothing rewritten, nothing lost, no new fact) | `supersedes` (no longer true as a whole —
  "will probably get the job", then "did not": the new fact stands alone, the
  old is marked `replacedBy` it with `why: superseded`, struck through under
  Past & superseded with what says so now) | `unrelated` (added). Any failure →
  added: a fact is never lost to this.

Never across scopes: a private fact never meets a shared one. What crosses
scopes is the **view**: "Right now" shows the same thing said in a group and in
a DM once, the private copy first, marked with where else it is. Retrieval is
unchanged — it ranks records, not facts.

**Moving to the store, and cleaning up:** boot migration `0102-facts-store`
writes every scope's notes as events (ids `<recordId>n<index>`; sources, hides
and replacements carried over; a replacement that pointed at a record holding
no note is dropped). Records keep their old notes untouched; the store still
reads any a record gained later (a content migration run afterwards), and its
own events win. The **nightly run** then folds the duplicate backlog — the keyed
ones for free, the rest a few model decisions a night — so a deployment
converges on one fact per thing with no operator step.

### Views and the nightly run

`lib/memory-views.js`: right now (statuses until the day after their event),
standing rules, topics (names merged conservatively; the owner's "same" / "not
the same" decisions win; a tile appears once a name comes up in **3
conversations** — `TOPIC_MIN` — where a Telegram or group thread counts once
per day, since it is one endless conversation; a topic's **timeline is the facts
about it** — each note says which of the conversation's names it is about, and
the fact keeps only those, so a chat about a product's website and a meeting
with someone does not file the meeting under the product; a name memory
already keeps is matched by the model too — the extractor reports which known
names a conversation mentions in any form (an inflection, a short form, a
typo), so code never bends words; the nightly `names` step asks the model the
same question about older facts, once per fact, and keeps the names their own
words carry;
whether two spellings are one thing — "Janek" and "Jan Kowal", "Marek" and
"Marek Nowak" — is the model's call in the nightly `aliases` step, over the
tiles and what memory says about each, written as an owner's merge would be and
logged; kinds must agree and an owner's "not the same" is never overridden), the digest (active/paused/closed, one structured
model pass rendered by code), and **who a topic is** — one line per topic
("co-founder of Harbor Works, left in March"), built per *viewer*
from that viewer's readable records only, each line pointing at the record it
comes from (evidence quoted verbatim and checked; a line the ledger does not
support is dropped). The same pass decides a topic's **kind** (person, company,
project, topic) when no conversation's tag carried one — a migrated page's
title never does — and keeps it in `_engine/kinds.json`, for every viewer; a
tag with a kind still wins. The owner can write their own line; after that, new
information arrives as a suggestion to take or decline, never a silent
overwrite. A topic's card shows its facts newest first, from the top (the newest 40, all on request).

`lib/memory-maintenance.js` runs once a day after 04:00 local: purge hidden
records past 30 days, prune migration backups past 30 days, archive and remove
any `memory/users/<slug>` tree whose slug is not on the roster (a removed
member, a test account, a group member the old memory gave a private tree —
nobody can read it; the archive sits with the backups), report unparseable
ledger lines (never "fixed"), erase facts hidden 30 days and facts whose last
record is gone, check the invariants (`lib/memory-invariants.js`: no orphan or
fact, no update standing on a record that is gone, no two current facts with
one key, no status day that its words do not carry, no fact made of the
assistant's lines alone — read-only, each violation in the run's errors),
update the digests, refresh the who-lines of topics with new records, title
untitled facts, narrow older facts to the names their own words carry, on
the model's say-so (`names`), merge two spellings of one topic on the model's say-so (`aliases`),
and fold the duplicate backlog — the way a new fact would be: a repeat is
hidden as a duplicate (logged, undoable), more detail merges, a correction
moves under the fact it corrects, and what is no longer true is marked so.

**Removing things on the Memory screen.** A person may hide or erase their own
records and what they shared themselves; an admin may also hide or erase what
the team holds in common — shared and group records (after the move most shared
records have no author, and nobody could take them down). Private records stay
their owner's: that is a path, never a role, and an admin cannot read them, let
alone hide them. A row on the Facts tab is one **fact** (one note of a record):
hiding or erasing a fact leaves the conversation it came from, with its other
facts and its text for search; a hidden fact is purged with hidden records after
30 days and restored from Changes by its id (the log never holds the text).
The tab has a bulk select for facts; erasing the whole conversation lives where
the conversation is shown ("See source"), and both erasures confirm in a modal.
An open fact shows its own timeline — the versions it replaced (struck through
when no longer true) and its dated updates — under its description. A topic's
timeline is its facts only (a conversation that named it and gave no fact —
a request to draft a reply, a passing mention — is not shown there; it stays
searchable), each with hide/erase; a topic can
be **removed** — the name stops making a tile for that person, their
conversations are no longer tagged with it (the extractor's exclusion list), the
records keep their text; the undo in Changes puts the tag back on exactly those
records. "Replaced" is a live relation between facts (see Facts above): the
earlier fact is past only while the fact that replaced it is there — hide or
erase the newer and the older is current again. A topic the owner
merged into another is named as they typed it; a company never folds into a page
title that starts with its name (the first-name fold is for people). Card lines
that became records are plain text, dated from their own text or "known by" the
card's last change (`undated`), never "today".

The **Changes** tab is the v4 event log (`memory/_engine/v4-log.jsonl`):
conversations remembered (with how many facts, corrections and supersedes),
notes saved or corrected on request, shares, keeps, hides, restores, erasures
(a nightly duplicate hide included), topics removed, restored, merged or kept
apart — ids, counts and labels only, never a record's text. An event is shown to whoever may read the record it is about, as it is
now: a share is addressed to the team; a hide withdraws a record from the team,
so only the person who hid it sees that.

### `memory_write` once v4 is on

The model's habits keep working: a duty written to `RESPONSIBILITIES` lands in
the person's `routines.json` (a correction updates that routine); a card v4
still loads goes through the engine as before; anything else (a page, a card v4
no longer loads) is kept as a record and becomes a fact through the facts store
(one per thing, like any other) — nothing recreates the old files.

### Moving a deployment to v4

1. Update. `shadow` is the default, so nothing to set (an explicit
   `MEMORY_V4=off` in the client's `.env` keeps it on v3). Structural
   migrations apply at boot (`0003` the ledger layout, `0004` routines.json next
   to the untouched card). Let it collect conversations for a while. A
   workspace with nothing but untouched seed templates skips the rest: boot
   moves it over by itself.
2. An admin sees **"A new memory is available"**, reviews, downloads a backup if
   they like, and starts the move (`0005`). Pages and cards become dated ledger
   records in the scope they were in (in solo mode, the owner's own scope); the
   old files leave `memory/`; the deployment is on v4.
3. There is no switch back in the product. The operator keeps the full archive
   in the store for 30 days: `node bin/migrate.mjs rollback 0005-legacy-memory-to-ledger`
   restores the old memory byte for byte (records filed after the move are lost
   with it).
4. **After the move the old memory is off, not merely unused** — the stamp
   (`memory/_engine/.v4-migrated`) decides, whatever `MEMORY_V4` says in the
   env: the MCP offers the v4 tools and drops `memory_grep` and `memory_log`
   (`memory_write` keeps only the card and duty operations); the scope guard
   refuses every raw read or listing of `memory/` (the cards are in the
   prefix, the rest is reached through the tools — listing the tree had the
   bot narrate folders of people who were never users); the skill fence
   refuses `memory-cards` and
   `taste-recall`; `INDEX.md` is no longer regenerated; and `0007` (structural,
   at boot) archives the leftovers — the undo snapshots, the emptied trees, the
   INDEX maps — into the store (30 days) and removes them from `memory/`. The
   bot that found "three old versions of a card" and offered to restore them
   was reading those leftovers.

Each person can download **their own** memory (the shared tree, their own tree,
their groups — never another person's, never the engine log) before the move
and, for 30 days, the old memory after it.

### Known gaps

- The Telegram brain (tmux) gets the v4 prefix and tools but not yet the
  per-message recall block (a `UserPromptSubmit` hook is to be verified on the
  pinned CLI); it is told to search before saying it doesn't know.
- Raw group transcripts (`.group-watcher/<chatId>-history.jsonl`) remain
  readable by any turn, as in v3 — group *memory* is fenced by membership, the
  raw log is not yet.
- Local dates in views are UTC days; reviews run per UTC day.


---

## The older memory (v3)

A deployment set up before v4 runs this until an admin moves it over (see
[Moving a deployment to v4](#moving-a-deployment-to-v4)). Everything in this
section describes that older design; nothing here applies after the move.

### TL;DR

Every workspace ships with a small LLM-wiki under `~/project/memory/` — curated
markdown cards plus per-entity pages. Workspace-api stitches the relevant cards
into the system prompt on every chat turn, so the bot wakes up already knowing
the basics.

Memory is written **in the conversation that produces the fact**, by the model,
through one guarded tool (`memory_write`). There is no background pipeline: no
nightly consolidation, no proposal queue, no approval step. The same tool is how
a fact gets **corrected** — and a correction *replaces* the claim it corrects
rather than being filed next to it.


### What lives in `project/memory/`

```
project/memory/
├── INDEX.md                  ← auto: map of this scope (cards, topics, concepts)
├── RULES.md                  ← hard never / always rules
├── AGENT_IDENTITY.md         ← the agent's voice, mood, defaults
├── AGENT_TOOLS.md            ← per-tool gotchas for active integrations
├── CHANNELS.md               ← auto: the Telegram groups the bot is in
├── TEAM.md                   ← auto: the roster (team mode)
├── concepts/<slug>.md        ← accreting, cited claims about a recurring entity
├── topics/<slug>.md          ← long-form prose on a subject
├── patterns/<slug>.md        ← "the bot got X wrong; here's the rule"
├── users/<slug>/             ← one person's PRIVATE tree (team mode)
│   ├── INDEX.md              ← auto: map of their private memory
│   ├── USER_PROFILE.md       ← stable facts about them
│   ├── USER_PREFERENCES.md   ← how they like things done
│   ├── USER_RELATIONSHIPS.md ← people in their world
│   ├── USER_REFLECTIONS.md   ← their own dated self-introspection
│   ├── RESPONSIBILITIES.md   ← the bot's standing duties toward them
│   ├── RECENT_WEB.md         ← auto: rolling web-chat tail
│   ├── RECENT_TELEGRAM.md    ← auto: rolling Telegram tail (operator only)
│   └── concepts/ topics/     ← their private pages
└── _engine/                  ← the write log + undo snapshots (never read back)
```

In a solo workspace the `users/<slug>/` tier is flat: the personal cards sit
directly under `memory/`.

`workspace-api/lib/memory-registry.js` is the **single definition** of what a
card is — its tier (shared vs private), whether it is preloaded, whether it is
seeded from a template, whether it is machine-generated. The prefix loader, the
group fence, the graph, the INDEX generator and the entrypoint seed list all
derive from it, and a build-failing test rejects a second card list anywhere in
the tree. Six hand-maintained copies of that knowledge is how a private card
once leaked into group prompts.

Cards are seeded on first container start from
`/opt/ide/bootstrap/memory-cards-templates/`. Existing files are never
overwritten. `INDEX.md`, `CHANNELS.md`, `TEAM.md` and the `RECENT_*` tails are
machine-generated — read them, never hand-edit them.

---

### How the bot reads memory

#### Cached system-prompt prefix (every turn)

`workspace-api/lib/memory-loader.js` builds a fixed-order block (a preamble plus
the preloaded cards) and feeds it to claude on every turn. The block is stable
across turns within a session, so Anthropic's prompt cache reads it at 0.1× the
input rate. The order is locked: changing it invalidates every existing cache
across the fleet, so the registry test pins it literally.

| Channel | Mechanism | When |
|---|---|---|
| Web (`workspace-api` chat) | `claude.js` → `buildTurnPrefix()` → `--append-system-prompt` | every turn |
| Telegram (bot tmux) | `bot.sh` curls `GET /api/memory/prefix?raw=1` into a file, passed as `--append-system-prompt-file` | once per tmux session; refreshed on `/restart` |

The Telegram prefix is **static for the tmux session lifetime** — a correction
written today is on disk immediately but is not visible to that session until a
restart. (This is the last thing tying the workspace to the tmux runtime; the
delivery-layer plan retires it.)

`USER_RELATIONSHIPS` and `USER_REFLECTIONS` are deliberately **not** preloaded —
large and low-frequency. The bot pulls them with `Read` when relevant.

**Group turns** load a prefix built by `buildTeamPrefix()`, which excludes the
entire private tier *derived from the registry*. A group reply is public to the
whole chat and its session is shared across senders, so nothing private may be
preloaded there — not even the sender's own.

#### On demand

- `memory_grep` — ripgrep over the shared tree **plus the caller's own private
  tree**, never another teammate's. Cheap deterministic lookup before `Read`.
  The caller is resolved from the session cookie for browser calls; the bot's
  MCP call has no cookie, so `workspace-api-mcp` sends the turn's
  `IDE_ACTOR_SLUG` as `X-IDE-Actor` (the same header `memory_write` sends), and
  `GET /api/memory/grep` honours it **only from loopback**. With no actor the
  search excludes `users/**` entirely — which in team mode would hide every
  per-user card (RESPONSIBILITIES, USER_PROFILE, …) from the bot.
- `Read` on a concept/topic page, found via the scope's `INDEX.md`.
- `recent_messages({channel})` — the live rolling tail, fresher than a frozen
  Telegram prefix.

INDEX entries carry a date, and a page whose newest cited claim is older than
`MEMORY_STALE_DAYS` (default 90) is marked `⚠ unreviewed`, so the model prefers
asking over asserting from an old page.

---

### How the bot writes memory

**One path.** `memory_write` (workspace-api MCP) → `POST /api/internal/memory-write`
(loopback only) → `workspace-api/lib/memory-engine.js`. Direct `Write`/`Edit`
under `memory/` is blocked by the `scope-guard` PreToolUse hook, with a message
naming the tool. workspace-api is the only process that touches the tree, which
also keeps a single uid on it.

#### Operations

| Op | What it does |
|---|---|
| `remember` | record a new fact on a card (with a section) or an entity page |
| `supersede` | a fact CHANGED: replace the old claim **everywhere it appears** |
| `retire` | a fact was never true: delete the claim outright |
| `rename_entity` | a page was created under the wrong name: move it and repoint every `[[link]]` |
| `retire_page` | delete a page that should not exist |
| `revert` | undo one logged write |

#### The doctrine

**A correction replaces the claim it corrects.** No `[was: …]` trail, no
strikethrough, no `## Retired` section. The reason is mechanical: cards are
preloaded on *every* turn, so a falsehood parked beside the truth is exactly as
present as the truth. History lives in `_engine/log.jsonl` plus a pre-image
snapshot per write — which is why the page does not have to carry it.

`supersede` replacing **every** copy is the other half. The same fact usually
exists in more than one place (a card line and a concept page); a correction
applied to one copy comes back weeks later from the copy nobody touched.

When the matches disagree with each other, nothing is written and they are
returned — replacing the wrong claim is worse than replacing none.

#### Guards (all in the engine, so they apply to every writer)

- **credential kill-list** — a key/token/PEM is refused, with the reason.
- **path confinement** — card names come from the registry; page slugs are
  validated; the resolved path must stay under `memory/`.
- **scope** — the same rule that guards reads (`scope-rule.js`): your own tree
  or the shared one, never a teammate's. A group turn may write shared only.
- **rival detection** — `remember` refuses when memory already states the same
  thing differently, and tells the caller to `supersede` instead. This is what
  stops a correction from landing as a second, contradictory bullet.
- **card shape** — a card's layout is the card's, not the caller's.
  RESPONSIBILITIES is a flat-list card: `remember` ignores the caller's
  `section` and appends to its one list (a duty's title passed as `section`
  used to spawn a second copy under its own heading, which the Routines panel
  never shows). `## Never` / `## Always` are reserved for RULES and refused on
  any other card, so a rule cannot hide where the rules reader never looks.
  Heading matching ignores case, punctuation and spacing (`## Working-style`
  lands in `## Working style`).
- **frontmatter is not a claim** — `supersede`/`retire` skip a card's YAML
  frontmatter, so its `key: value` instructions can never be matched and
  rewritten as a fact.
- **undo + log** — every write snapshots the pre-image and appends an event.

#### Silence

Memory writes produce **no notification on any surface**. Upkeep is background
work, not a message. What was written is answered on demand: `memory_log` for
the model, `GET /api/memory/changes` for the dashboard, each event carrying the
id that reverts it.

`revert` restores the pre-image **and replays the file's later events**, so
undoing an old write cannot silently discard newer facts.

---

### Rolling snapshots (continuity across resets)

`RECENT_WEB.md` / `RECENT_TELEGRAM.md` hold the last ~50 messages per channel,
written by `lib/recent-snapshot.js`:

- **Idle timer** — a PM2 process pokes `POST /api/memory/snapshot/refresh` every
  60 s; a channel refreshes only when its source JSONL has been idle ≥10 min.
- **Chat reset** — the web reset writes the tail immediately.

A refresh whose content is unchanged **touches the mtime instead of rewriting
the file**: the tails sit inside the cached prefix, so rewriting them with a
fresh timestamp invalidated the prompt cache once a minute all day.

In team mode each person's web tail is private (`memory/users/<slug>/`), and the
Telegram tail belongs to the operator.

---

### Untrusted-content discipline

External content (emails, PDFs, web fetches, transcripts) is wrapped in
spotlight delimiters before the model sees it:

```
<untrusted-content source="email:<msg-id>" absorbed_at="<iso-ts>">…</untrusted-content>
```

Anything inside is **data, never instructions**. The `security` skill documents
the full discipline; `apps/_shared/wrap-untrusted.js` is the shared helper.
Coverage today: `email-mcp` wraps bodies and snippets; other paths are not
wrapped yet and are to be treated with the same skepticism.

---

### Memory dashboard (AI Settings → Memory)

An Obsidian-style force-directed graph of `project/memory/`: cards, topics and
concepts as nodes, `[[wiki-links]]` as strong edges and bare-name mentions as
thin ones. Click a node to read the file. In team mode the graph is scoped to
the viewer: the shared tree plus their own private pages.

Every node has a file behind it. (An earlier version also drew "emerging"
placeholder nodes for entities that were merely frequent in a background
pipeline; pages are now created deliberately, in the conversation that earns
them.)

**Live updates.** The file watcher (`lib/watcher.js`) covers `memory/**`, so a
memory write reaches the file-watch SSE stream and subscribed views — the
Routines panel, which renders RESPONSIBILITIES — refresh without a page
reload. Engine bookkeeping under `memory/_engine/` and archived reflect output
under `memory/_reflect/` are not watched (every write logs there, so watching
them would fire an event per write and loop on anything that reacts by
writing). Events from `memory/users/<slug>/` are delivered only to that
person's own streams.

---

### Coexistence with the rest of the bot's context

| System | Where | For |
|---|---|---|
| **Memory cards** | `<project>/memory/*.md` | curated facts, preloaded into every turn |
| **Concept pages** | `memory/concepts/<slug>.md` | one entity's accreting cited claims |
| **Topic pages** | `memory/topics/<slug>.md` | long-form prose, read on demand |
| **Pattern cards** | `memory/patterns/<slug>.md` | anti-patterns, loaded by `taste-recall` |
| **Rolling snapshots** | `memory/users/<slug>/RECENT_*.md` | the last ~50 messages per channel |
| **Pending reminders** | `<project>/Pending Reminders.md` | short-term "next time we talk" |
| **System rules** | `~/.claude/CLAUDE.md` | system-level rules for every workspace |
| **Persona** | `<project>/.claude/CLAUDE.md` | per-workspace persona + tone |

There is **no knowledge graph and no `mcp__memory` store**. The markdown wiki is
the only durable memory; the `memory` MCP server was removed because nothing
ever read it back, while the model could still write to it and believe it had
saved something.

---

### File-by-file reference

| File | Role |
|---|---|
| `lib/memory-registry.js` | the single card definition every consumer derives from |
| `lib/memory-loader.js` | builds the cached prefix (`buildCachedPrefix`, `buildTeamPrefix`) |
| `lib/memory-engine.js` | the one write path: ops, guards, undo, log |
| `lib/memory-index.js` | regenerates a scope's `INDEX.md` map |
| `lib/memory-migrate.js` | one-shot move off the retired pipeline (boot, idempotent) |
| `lib/memory-graph.js` | `{nodes, edges}` for the dashboard |
| `lib/memory-grep.js` | ripgrep-backed search, own-tree scoped |
| `lib/memory-repair.mjs` | one-shot CLI: fold drifted cards back to their declared shape (`repairCards`) |
| `lib/recent-snapshot.js` | rolling tail writer (content-gated) |
| `lib/watcher.js` | file-watch SSE source; includes `memory/**`, owner-tags private trees |
| `routes/memory.js` | graph / grep / prefix / recent / changes / revert / snapshot |
| `routes/internal.js` | `memory-write`, `memory-log` (loopback only) |
| `apps/workspace-api-mcp` | the `memory_write`, `memory_log`, `memory_grep`, `recent_messages` tools |
| `hooks/scope-guard.mjs` | blocks raw file writes under `memory/`; enforces per-actor scope |

#### Skills

- `memory-cards` — reference for the memory *model* (what lives where). Writing
  needs no skill: the routing rules live in the `memory_write` tool description.
- `taste-recall` — loads anti-pattern cards at session start.
- `security` — untrusted-content handling.

---

### Operational notes

**Tests.** `bash ide-template/scripts/test-memory.sh` runs the write-path
(engine) and read-path (registry/prefix/grep) suites; both are also in
`npm test` under `workspace-api/`. Permissions are container-specific:
`docker exec -u coder <ctr> bash /opt/ide/scripts/test-memory-perms.sh`.

**Cache hit verification.** After a turn or two, check `pm2 logs workspace-api`
for `cache_read_input_tokens`. If it is `0` across several turns, something is
changing the prefix mid-session — usually a card being rewritten.

**Updating templates without losing edits.** The entrypoint seed step is
idempotent. To roll new template content into an already-seeded workspace, copy
the file in by hand (not `INDEX.md` — it is generated).

**Repairing drifted cards.** Cards written before the card-shape guard can
carry a heading twice, duties parked under headings of their own on
RESPONSIBILITIES, or entries missing their `- ` marker (invisible to
`supersede`/`retire`). From `/opt/ide/workspace-api` inside the container, as
the workspace-api user:

```
node lib/memory-repair.mjs --dry-run   # report only
node lib/memory-repair.mjs             # apply
```

It walks the whole tree, per-user trees included (skipping `_engine/`,
`_reflect/`, archives and the generated `INDEX`/`RECENT_*`/`ABOUT` files).
Content under a duplicate heading joins the first heading of that name; on a
flat-list card every entry ends up in the one list and gets its list marker
back. Lines are moved, never dropped; frontmatter, the preamble and HTML-comment
template blocks are left as they are. Each repaired file goes through the
normal write path, so it has an undo snapshot and a log line (`op: repair`) and
can be reverted like any other write. A second run is a no-op.

**Migration.** `migrateToEngine()` runs at boot, once: it archives the retired
pipeline's files to `/var/wsapi-store/memory-v2-archive-<date>.tar.gz` (outside
the project tree, because those drafts contain every teammate's private facts)
and strips `## Retired` sections, struck claims and `[was: …]` tails off the
cards. What it removes is inside the archive.

---

