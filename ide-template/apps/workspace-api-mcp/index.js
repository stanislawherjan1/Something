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
