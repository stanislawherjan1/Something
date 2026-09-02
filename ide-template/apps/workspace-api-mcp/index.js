#!/usr/bin/env node
/**
 * Workspace-API MCP — thin MCP wrapper around workspace-api HTTP routes
 * that the model is instructed to use as tools.
 *
 * Tools exposed:
 *   - memory_grep(query, regex?, max?)             → ripgrep over memory/
 *   - recent_messages(channel, limit?)             → live RECENT_<CHANNEL>.md
 *     content + snapshot_age_seconds (so the bot can fetch fresher snapshot
 *     than the one baked into its --append-system-prompt-file at startup)
 *
 * Why these wrappers exist: workspace-api/lib/memory-loader.js PREAMBLE
 * instructs the model on every turn to "prefer the memory_grep tool for
 * cheap deterministic lookups" + "for messages older than your cached
 * snapshot, call recent_messages". Without an MCP tool the model
 * paraphrases the absence as "I don't have a memory search tool" — a
 * silent self-fulfilling hallucination.
 *
 * Adding more workspace-api routes here is straightforward — define a new
 * tool in ListToolsRequestSchema and a new branch in CallToolRequestSchema
 * that fetches the corresponding HTTP endpoint.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_BASE = process.env.WORKSPACE_API_URL || 'http://localhost:3001';

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'workspace-api-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'memory_write',
      description:
        'Write to the workspace memory wiki. This is the ONLY way to change memory — plain file writes into memory/ are blocked.\n\n' +
        'CALL IT WITHOUT BEING ASKED whenever a turn produces something durable:\n' +
        '- a stable fact about the person (role, location, languages, what they are working on)\n' +
        '- a preference (tone, channel, format, working style)\n' +
        '- a hard rule ("always…", "never…", "from now on…")\n' +
        '- a standing duty you are put on the hook for ("every Friday…", "keep an eye on…")\n' +
        '- a person, client, project or tool that will come up again\n' +
        'Skip the ephemeral (today\'s weather, a one-off task). Do NOT announce the write; memory upkeep is background work, never a message.\n\n' +
        'CORRECTIONS ARE THE OTHER HALF OF THE JOB. When someone corrects a fact — "actually…", "no, it is…", "that is wrong", ' +
        '"we do not use X any more", "it changed", "nie, …", "już nie…", "to nieaktualne", "pomyliłeś się" — call this tool in the SAME turn:\n' +
        '- op "supersede" when the fact CHANGED (moved city, switched tool, new role): the old claim is replaced everywhere it appears.\n' +
        '- op "retire" when the fact was NEVER true (a wrong name, a misheard detail): the claim is deleted outright.\n' +
        'Never write the correction as a new fact next to the old one, and never annotate the old one — the tool keeps the history, the page keeps only the truth. ' +
        'A correction that lives only in the chat WILL come back as the same mistake.\n\n' +
        'WHERE IT GOES (op "remember"): pass EITHER `card` or `page`.\n' +
        '- card "RULES" (hard rules) | "AGENT_TOOLS" (tool gotchas) | "AGENT_IDENTITY" (your voice) — these are SHARED.\n' +
        '- card "USER_PROFILE" | "USER_PREFERENCES" | "USER_RELATIONSHIPS" | "USER_REFLECTIONS" | "RESPONSIBILITIES" — these are PRIVATE: pass scope "private".\n' +
        '- page "<slug>" for a recurring entity (a client, project, person) whose detail keeps growing — an accreting page of one atomic claim per line.\n' +
        'SHARED vs PRIVATE, one test: "would this help a DIFFERENT teammate?" Yes → scope "shared". No — it is about this person, their taste, their contacts → scope "private". ' +
        'Anything sensitive stays private. In a group conversation only shared memory can be written.\n\n' +
        'The tool refuses, with a reason, when a credential is detected, when memory already states the same thing differently ' +
        '(use supersede), or when a correction matches several different claims (re-run naming one of them). Read the reason and act on it.',
      inputSchema: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['remember', 'supersede', 'retire', 'rename_entity', 'retire_page', 'revert'],
            description:
              'remember: record a new fact. supersede: replace a claim that changed (needs `match` + `text`). ' +
              'retire: delete a claim that was never true (needs `match`). rename_entity: an entity page was created under the wrong name ' +
              '(needs `from` + `to`; repoints links so the wrong name stops coming back). retire_page: delete a page that should not exist. ' +
              'revert: undo one logged write (needs `event_id`).',
          },
          text: { type: 'string', description: 'The fact, as ONE atomic sentence. For supersede, the corrected version.' },
          match: { type: 'string', description: 'supersede/retire: the existing claim to replace or delete — quote it as closely as you can.' },
          card: { type: 'string', description: 'remember: the card name (see the routing rules above).' },
          page: { type: 'string', description: 'remember/retire_page: a kebab-case entity slug, e.g. "acme" or "q3-launch".' },
          section: { type: 'string', description: 'remember: the section heading on the card, e.g. "Identity", "Never", "Communication".' },
          scope: { type: 'string', enum: ['shared', 'private'], description: 'Default "shared". Use "private" for anything about this one person.' },
          from: { type: 'string', description: 'rename_entity: the current (wrong) slug.' },
          to: { type: 'string', description: 'rename_entity: the correct slug.' },
          reason: { type: 'string', description: 'retire/retire_page: why, in a few words. Kept in the log.' },
          source: { type: 'string', description: 'Optional: where the fact came from, e.g. "conversation" or "correction".' },
          event_id: { type: 'string', description: 'revert: the id from a previous write or from memory_log.' },
        },
        required: ['op'],
      },
    },
    {
      name: 'memory_log',
      description:
        'What memory writes actually happened recently, newest first — each with its target, what was added or removed, and an id you can pass to ' +
        'memory_write { op: "revert" }. Memory writes are silent by design, so this is how you answer "what did you save?", "did you remember that?" ' +
        'or "undo what you just wrote" truthfully instead of from recollection.',
      inputSchema: {
        type: 'object',
        properties: { days: { type: 'integer', minimum: 1, maximum: 90, description: 'How far back to look. Default 7.' } },
      },
    },
    {
      name: 'memory_grep',
      description:
        'Ripgrep-backed search over the workspace memory tree (memory/). ' +
        'Use this for cheap deterministic lookups BEFORE falling back to Read ' +
        'on a whole topic page. Returns up to `max` file:line matches with ' +
        'snippets. Searches all memory cards, topics, patterns, threads, and ' +
        'rolling snapshots. Prefer over Read when you need to find where a ' +
        'specific name, term, or phrase is mentioned across memory.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Search term. By default treated as a literal string. ' +
              'Set `regex: true` to interpret as a ripgrep regex.',
          },
          regex: {
            type: 'boolean',
            description: 'Treat `query` as a ripgrep regex. Default: false.',
          },
          max: {
            type: 'integer',
            description: 'Maximum matches to return (1–50). Default: 10.',
            minimum: 1,
            maximum: 50,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'recent_messages',
      description:
        'Live RECENT_<CHANNEL>.md content from disk + snapshot freshness. ' +
        'Use this when the user references conversation context that may ' +
        'be OLDER than what your cached prefix shows: the Telegram side ' +
        'in particular has a static prefix from tmux startup, so the ' +
        '`RECENT_TELEGRAM` block in your system prompt can be stale by ' +
        'hours or days. This tool returns the file the snapshot-monitor ' +
        'maintains on disk (refreshed every ~60s when channel is idle) ' +
        'so you can see fresher transcript than your prefix has. ' +
        '`snapshot_age_seconds` tells you how recent the file is. ' +
        'Channel must be "web" or "telegram".',
      inputSchema: {
        type: 'object',
        properties: {
          channel: {
            type: 'string',
            enum: ['web', 'telegram'],
            description: 'Which channel\'s snapshot to fetch.',
          },
          limit: {
            type: 'integer',
            description:
              'Optional: return only the last N message sections (1–200). ' +
              'Each section starts with "## " in the markdown. ' +
              'Default: full file.',
            minimum: 1,
            maximum: 200,
          },
        },
        required: ['channel'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'memory_write') {
    const payload = { ...args };
    try {
      const res = await fetch(`${API_BASE}/api/internal/memory-write`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The turn's identity, set per-spawn by workspace-api/lib/claude.js.
          'X-IDE-Actor': process.env.IDE_ACTOR_SLUG || '',
          'X-IDE-Group': process.env.IDE_GROUP_CONTEXT === '1' ? '1' : '0',
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (data && data.ok) {
        // Echo exactly what changed, so the model can verify its own write
        // rather than assume it — and can undo it in the same turn if wrong.
        const bits = [];
        if (data.noop) bits.push('already recorded, nothing to do');
        if (data.wrote) bits.push(`wrote to ${data.target}: ${data.wrote}`);
        if (data.replaced) bits.push(`replaced in ${data.targets.join(', ')}:\n` + data.replaced.map(x => `  was: ${x.was}`).join('\n'));
        if (data.removed) bits.push(`removed from ${[...new Set(data.removed.map(x => x.file))].join(', ')}:\n` + data.removed.map(x => `  ${x.was}`).join('\n'));
        if (data.from && data.to) bits.push(`renamed ${data.from} → ${data.to}${data.relinked?.length ? `; relinked ${data.relinked.length} page(s)` : ''}`);
        if (data.restored) bits.push(`reverted; ${data.restored.map(x => `${x.target} (replayed ${x.replayed} later change(s))`).join(', ')}`);
        const id = data.event_id || data.event_group;
        return { content: [{ type: 'text', text: `${bits.join('\n') || 'done'}${id ? `\n[event ${id}]` : ''}` }] };
      }
      // A refusal is INFORMATION, not a failure: it usually says the fact is
      // already there in different words, i.e. this is a correction.
      const hint = data?.needs_supersede
        ? `\nMemory already says: "${data.existing}"\nRe-run with op:"supersede", match:"${data.existing}" and the corrected text.`
        : data?.ambiguous
          ? `\nMatching claims:\n${data.ambiguous.map(a => `  ${a.file}: ${a.text}`).join('\n')}`
          : '';
      return { content: [{ type: 'text', text: `${data?.error || `HTTP ${res.status}`}${hint}` }], isError: true };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `memory_write failed: ${err?.message || err}. The fact was NOT saved — say so rather than implying it was.` }],
        isError: true,
      };
    }
  }

  if (name === 'memory_log') {
    const days = Number.isInteger(args?.days) ? args.days : 7;
    try {
      const res = await fetch(`${API_BASE}/api/internal/memory-log?days=${days}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { content: [{ type: 'text', text: `memory_log HTTP ${res.status}` }], isError: true };
      if (!data.events?.length) return { content: [{ type: 'text', text: `No memory writes in the last ${days} day(s).` }] };
      const lines = data.events.map(e => {
        const what = e.op === 'supersede' ? `replaced ${e.removed.length} claim(s)`
          : e.op === 'retire' ? `removed ${e.removed.length} claim(s)`
            : e.added.length ? e.added.join(' | ') : e.op;
        return `${e.ts.slice(0, 16).replace('T', ' ')}  ${e.op.padEnd(10)} ${e.target}${e.section ? ` › ${e.section}` : ''}\n    ${what}${e.revertable ? `   [revert: ${e.id}]` : ''}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `memory_log failed: ${err?.message || err}` }], isError: true };
    }
  }

  if (name === 'memory_grep') {
    const q = String(args?.query || '').trim();
    if (!q) {
      return {
        content: [{ type: 'text', text: 'Provide a non-empty `query`.' }],
        isError: true,
      };
    }

    const params = new URLSearchParams({ q });
    if (args.regex === true) params.set('regex', '1');
    if (Number.isInteger(args.max)) params.set('max', String(args.max));

    const url = `${API_BASE}/api/memory/grep?${params.toString()}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        return {
          content: [{
            type: 'text',
            text: `memory_grep HTTP ${res.status}: ${body.slice(0, 500)}`,
          }],
          isError: true,
        };
      }
      const data = await res.json();

      if (!data.matches || data.matches.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No matches for "${q}"${args.regex ? ' (regex)' : ''} in memory/.`,
          }],
        };
      }

      // Format: one match per line — `file:line | snippet`
      const lines = data.matches.map((m) => {
        const snippet = (m.snippet || '').replace(/\n/g, ' ').slice(0, 200);
        return `${m.file}:${m.line} | ${snippet}`;
      });

      const header = `Found ${data.count} match${data.count === 1 ? '' : 'es'} for "${q}"${args.regex ? ' (regex)' : ''}:`;
      return {
        content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `memory_grep request failed: ${err?.message || err}. ` +
                `Workspace-API may not be reachable at ${API_BASE}.`,
        }],
        isError: true,
      };
    }
  }

  if (name === 'recent_messages') {
    const channel = String(args?.channel || '').trim().toLowerCase();
    if (!channel || !['web', 'telegram'].includes(channel)) {
      return {
        content: [{ type: 'text', text: 'Provide `channel` as "web" or "telegram".' }],
        isError: true,
      };
    }
    const params = new URLSearchParams();
    if (Number.isInteger(args.limit)) params.set('limit', String(args.limit));
    const qs = params.toString();
    const url = `${API_BASE}/api/memory/recent/${channel}${qs ? `?${qs}` : ''}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        return {
          content: [{
            type: 'text',
            text: `recent_messages HTTP ${res.status}: ${body.slice(0, 500)}`,
          }],
          isError: true,
        };
      }
      const data = await res.json();
      if (!data.exists) {
        return {
          content: [{
            type: 'text',
            text: `No snapshot for channel "${channel}" yet (file ${data.path} doesn't exist; channel may be idle or never used).`,
          }],
        };
      }
      const ageStr = data.snapshot_age_seconds < 60
        ? `${data.snapshot_age_seconds}s`
        : data.snapshot_age_seconds < 3600
          ? `${Math.round(data.snapshot_age_seconds / 60)} min`
          : `${(data.snapshot_age_seconds / 3600).toFixed(1)} h`;
      const header =
        `RECENT_${channel.toUpperCase()}.md ` +
        `(${data.bytes} bytes, snapshot age ${ageStr}, updated ${data.snapshot_updated_at})`;
      return {
        content: [{ type: 'text', text: `${header}\n\n${data.content}` }],
      };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `recent_messages request failed: ${err?.message || err}. ` +
                `Workspace-API may not be reachable at ${API_BASE}.`,
        }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
