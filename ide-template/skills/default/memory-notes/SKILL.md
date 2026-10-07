---
name: memory-notes
description: Use this whenever you save something to memory yourself with memory_note — the person says "remember this", corrects what memory holds, pastes meeting notes or a summary, or tells you something they will clearly want kept. How to write a note that still makes sense months later, how a meeting becomes one note, and when to ask before saving.
allowed-tools: mcp__workspace-api__memory_note, mcp__workspace-api__memory_search, mcp__workspace-api__memory_timeline, mcp__workspace-api__memory_now
---

# Writing to memory yourself

Most of memory writes itself: every finished conversation is filed, and a
connected notetaker's meetings are read in each night. You write a note only
when the person asks, corrects something, or hands you material to keep. When
you do, the note is read later **alone** — on the Facts tab, in a topic's
timeline, in an answer months from now — by someone who does not have this
conversation in front of them. Write it for that reader.

## A note stands on its own

Every note says, in its own words:

- **what it is about** — the project, company, deal, trip or person by name
  ("the Context Layer product for physiotherapy clinics", not "the project");
- **who** — full names as memory knows them, and who they are when it matters
  ("Kamil Pawlik, CEO of ResearchTech");
- **when** — an absolute date (and time, if said) for anything dated; never
  "tomorrow", "next week", "today";
- **what it means** — the decision, the commitment, the status, the number —
  and **why it matters** to the person when that is not obvious;
- **where it came from** when it is not their own words — "from the call
  notes of 5 Oct 2026", "from the summary Stan pasted".

A one-line note that only makes sense inside this chat ("Kamil will work on
the metrics and integrations") is a bad note: whose metrics, for what, decided
where, by when? Look it up (`memory_search`, `memory_timeline`) and write it
whole, or ask.

## A meeting is one note

Pasted meeting notes, a call summary, "here's what we agreed": that is **one
meeting**, so **one note**, never a handful of loose sentences.

- Title it by the convention: **"Call with <who> (<day month year>)"** — e.g.
  "Call with Kamil Pawlik (6 Oct 2026)".
- Its text is the summary a colleague would want a month later: what it was
  about, what was decided or agreed, who committed to what, what it means for
  the person — 3 to 6 plain sentences, concrete (names, numbers, dates as
  said). Not the whole transcript, not a list of every topic touched.
- A follow-up with its own day (a call on Thursday, a deadline on the 15th)
  may be a second note, dated. Nothing else is split off.
- If a meeting with that person on that day is already in memory (the
  notetaker read it, or it was planned in a chat), write the same title: the
  system merges the two into one fact and keeps the history.

## When you do not know, ask — before saving

If you cannot say what it is about, who someone is, which meeting it was, or
when — ask the person in one short question, then save. Never fill a gap with
a guess, and never save a fragment to "complete later". Names that are in
neither their words nor memory are refused by the tool anyway; ask instead of
retrying with a guess.

## Saying it is done

Say in a few words what you kept ("Kept the call with Kamil from 6 Oct — the
pilot scope and his part on metrics."), in their language. Never name the tool,
never show ids. If memory merged it with something it already had, say so.
