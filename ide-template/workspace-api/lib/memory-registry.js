/**
 * memory-registry — the SINGLE definition of what a memory card is.
 *
 * Before this module the same knowledge was restated in six places that drifted
 * apart: memory-loader's LOAD_ORDER + USER_TIER, claude.js's hand-written group
 * exclusion list, memory-graph's CANONICAL_CARDS, reflect-apply's
 * CARD_DESCRIPTIONS, entrypoint.sh's seed array, and the lint policy. The drift
 * was not cosmetic — RESPONSIBILITIES was added to LOAD_ORDER + USER_TIER but
 * missed by claude.js's group list, so a group turn (whose reply is public to
 * the whole chat) loaded the SENDER's PRIVATE duties card into its prompt. That
 * class of bug is what this file exists to make impossible: add a card here, and
 * every consumer picks it up.
 *
 * Fields
 *   id       — the block heading in the cached prefix, and the key every
 *              consumer uses. Unique.
 *   file     — basename inside the card's scope dir. NOT unique: INDEX and
 *              USER_INDEX are the same filename in two different scopes.
 *   tier     — 'shared' → the flat memory/ tree, team-wide.
 *              'user'   → per-person memory/users/<slug>/ in team mode (flat in
 *              solo). A 'user' card is PRIVATE: it never enters a group prefix
 *              and never crosses to another teammate.
 *   prefix   — true when the card is preloaded into the cached system prompt.
 *              Large, low-frequency cards (relationships, reflections) stay out
 *              and are pulled with Read when a turn needs them.
 *   seed     — true when entrypoint.sh copies a starter template on first boot.
 *   machine  — true when the file is auto-maintained (INDEX, CHANNELS, TEAM,
 *              RECENT_*). Humans and the agent must not hand-edit these; the
 *              write path treats them as generated output, not claims.
 *   stale    — 'claims' → its lines are dated facts that can go stale and get a
 *              freshness marker; 'none' → rules/identity/generated content that
 *              does not expire on a clock.
 *   adopt    — true when a solo-era FLAT copy of this card must be moved into
 *              the primary admin's private dir on the one-time team migration.
 *              Only real authored content: never a machine-generated file. This
 *              flag exists because deriving "adopt = tier user" deleted the
 *              SHARED memory/INDEX.md on every boot (USER_INDEX shares its
 *              filename), and left USER_RELATIONSHIPS / USER_REFLECTIONS flat —
 *              i.e. readable by every teammate.
 *   desc     — one-line blurb used when the card is listed in an INDEX map.
 *
 * ORDER IS LOAD-BEARING. The array below IS the cached-prefix order, and the
 * prompt cache keys on the exact bytes: reordering invalidates every existing
 * cache across the fleet. Append new prefix cards at the END of the prefix run
 * rather than inserting into the middle.
 */

export const CARDS = [
  {
    id: 'AGENT_IDENTITY', file: 'AGENT_IDENTITY.md', tier: 'shared',
    prefix: true, seed: true, machine: false, stale: 'none', adopt: false,
    desc: "the agent's name, voice, mood, defaults",
  },
  {
    id: 'AGENT_TOOLS', file: 'AGENT_TOOLS.md', tier: 'shared',
    prefix: true, seed: true, machine: false, stale: 'claims', adopt: false,
    desc: 'per-tool gotchas + activation notes for active integrations',
  },
  {
    // The bot's standing duties + proactive directives TOWARD this user — what
    // the bot does FOR them. Per-user, so each teammate's card holds the bot's
    // duties for THAT person. Prefix-loaded so the bot knows its duties on EVERY
    // turn (proactive all day, not just at planning time); morning-planner reads
    // it to plan each person's day into timed reminders.
    id: 'RESPONSIBILITIES', file: 'RESPONSIBILITIES.md', tier: 'user',
    prefix: true, seed: true, machine: false, stale: 'none', adopt: true,
    desc: "the bot's standing duties toward this person",
  },
  {
    id: 'RULES', file: 'RULES.md', tier: 'shared',
    prefix: true, seed: true, machine: false, stale: 'none', adopt: false,
    desc: 'hard never/always rules — override preferences on conflict',
  },
  {
    id: 'INDEX', file: 'INDEX.md', tier: 'shared',
    prefix: true, seed: true, machine: true, stale: 'none', adopt: false,
    desc: 'map of shared memory — cards, topics, concepts',
  },
  {
    // Per-user PRIVATE index: the MAP of THIS actor's OWN private memory (their
    // cards + topics + concepts under memory/users/<slug>/). Topic/concept pages
    // are never in the prefix AND memory_grep skips users/** — so without this
    // map the actor's own private depth is undiscoverable (write-only). Loaded
    // only in a real per-user prefix, never as a solo duplicate of INDEX.
    id: 'USER_INDEX', file: 'INDEX.md', tier: 'user',
    prefix: true, seed: false, machine: true, stale: 'none', adopt: false,
    desc: 'map of your private memory — cards, topics, concepts',
  },
  {
    // The Telegram GROUPS the bot is in + who's in them. Shared, auto-maintained
    // by team.js writeChannelsCard(). Both brains load it → the operator knows
    // which groups exist (and their chat_ids, so it can reply into one from a DM).
    id: 'CHANNELS', file: 'CHANNELS.md', tier: 'shared',
    prefix: true, seed: false, machine: true, stale: 'none', adopt: false,
    desc: 'the Telegram groups the bot is in + who is in them',
  },
  {
    id: 'USER_PROFILE', file: 'USER_PROFILE.md', tier: 'user',
    prefix: true, seed: true, machine: false, stale: 'claims', adopt: true,
    desc: 'stable facts about the user (role, location, languages, focus)',
  },
  {
    id: 'USER_PREFERENCES', file: 'USER_PREFERENCES.md', tier: 'user',
    prefix: true, seed: true, machine: false, stale: 'claims', adopt: true,
    desc: 'soft preferences (tone, formatting, working style)',
  },
  {
    // Rolling snapshot of the recent web chat. Per-user: recent-snapshot.js
    // writes each person's tail to memory/users/<slug>/. The web prefix EXCLUDES
    // it (each web session resumes its own thread); the Telegram prefix loads the
    // OPERATOR's own web tail for cross-surface awareness.
    id: 'RECENT_WEB', file: 'RECENT_WEB.md', tier: 'user',
    prefix: true, seed: true, machine: true, stale: 'none', adopt: false,
    desc: 'rolling snapshot of the recent web chat',
  },
  {
    // The bot's single Telegram log is the OPERATOR's private conversation,
    // written to memory/users/<adminSlug>/. Per-user so it comes from the actor's
    // own dir — the operator gets theirs, a non-operator gets an (empty) one.
    id: 'RECENT_TELEGRAM', file: 'RECENT_TELEGRAM.md', tier: 'user',
    prefix: true, seed: true, machine: true, stale: 'none', adopt: false,
    desc: 'rolling snapshot of the recent Telegram conversation',
  },

  // ─── Below: real cards that are NOT in the cached prefix ──────────────────
  // Large + low-frequency, or generated for a surface other than the prompt.
  // They still classify as CARDS everywhere else (INDEX grouping, graph node
  // kind, seeding), which is the drift this registry removes.
  {
    id: 'USER_RELATIONSHIPS', file: 'USER_RELATIONSHIPS.md', tier: 'user',
    prefix: false, seed: true, machine: false, stale: 'claims', adopt: true,
    desc: "people in the user's life",
  },
  {
    id: 'USER_REFLECTIONS', file: 'USER_REFLECTIONS.md', tier: 'user',
    prefix: false, seed: true, machine: false, stale: 'none', adopt: true,
    desc: "the user's own self-introspection entries",
  },
  {
    // Written by team.js writeTeamRoster() in team mode: PUBLIC fields only
    // (displayName, slug, role) — a pointer to each person, never their content.
    id: 'TEAM', file: 'TEAM.md', tier: 'shared',
    prefix: false, seed: false, machine: true, stale: 'none', adopt: false,
    desc: "the team roster + each member's role",
  },
  {
    // Optional, hand-written: what this bot is here to do (org context, mission).
    // Nothing seeds or generates it; when an operator creates it, it classifies
    // as a card instead of being mislabelled a topic.
    id: 'MISSION', file: 'MISSION.md', tier: 'shared',
    prefix: false, seed: false, machine: false, stale: 'none', adopt: false,
    desc: 'what the bot is here to do: responsibilities, principles, org context',
  },
];

const byId = new Map(CARDS.map(c => [c.id, c]));

/** One card definition, or undefined. */
export function card(id) { return byId.get(id); }

/**
 * The cached-prefix load order: `[{ id, path }]`, in the locked sequence.
 * Shape kept identical to memory-loader's historical LOAD_ORDER so the loader is
 * a drop-in consumer.
 */
export const LOAD_ORDER = CARDS.filter(c => c.prefix).map(c => ({ id: c.id, path: c.file }));

/**
 * Cards that are PER-USER in team mode. A person's profile, duties, preferences
 * and conversation tails are about THEM — not the team — so with an actor they
 * load from memory/users/<slug>/ instead of the shared flat file. Solo ignores
 * this and loads everything flat.
 */
export const USER_TIER = new Set(CARDS.filter(c => c.tier === 'user').map(c => c.id));

/**
 * Ids that must NEVER enter a Telegram GROUP prefix. A group turn's reply is
 * public to the whole chat and its session is shared across turns run as
 * DIFFERENT senders, so nothing private may be preloaded into it — not even the
 * sender's own. Derived, not hand-listed: that hand-list is precisely what
 * leaked RESPONSIBILITIES.
 */
export const GROUP_EXCLUDED = new Set(USER_TIER);

/** Card ids for graph node classification (`kind: 'card'` vs topic). */
export const CANONICAL_CARD_IDS = new Set(CARDS.map(c => c.id).filter(id => id !== 'USER_INDEX'));

/**
 * Solo-era flat cards to move under the primary admin on the one-time team
 * migration, as `[{ id, path }]`. Deliberately NOT derived from `tier` —
 * USER_INDEX is user-tier but its file IS the shared memory/INDEX.md, so a
 * derived set deleted the shared index on every boot.
 */
export const ADOPT_CARDS = CARDS.filter(c => c.adopt).map(c => ({ id: c.id, path: c.file }));

/** Files entrypoint.sh seeds from bootstrap templates on first boot. */
export const SEED_FILES = CARDS.filter(c => c.seed).map(c => c.file);

/** `{ ID: 'blurb' }` for INDEX map generation. */
export const CARD_DESCRIPTIONS = Object.fromEntries(
  CARDS.filter(c => c.id !== 'USER_INDEX').map(c => [c.id, c.desc]),
);

/** True when a card's lines are dated facts that can go stale. */
export function hasStaleableClaims(id) { return byId.get(id)?.stale === 'claims'; }

/** True when the file is auto-maintained and must not be hand-edited. */
export function isMachineWritten(id) { return byId.get(id)?.machine === true; }
