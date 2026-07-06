#!/usr/bin/env node
/**
 * PDF MCP — the ONE supported way to turn a document into a PDF in this
 * workspace. Wraps a real toolchain (python-markdown → weasyprint) so the bot
 * NEVER hand-rolls raw PDF bytes again (that path gave off-by-one page tables,
 * latin-1-mangled accents, and "shitty tables"). Always on: no credentials.
 *
 * Tools:
 *   render_pdf  — markdown (file or inline) → a clean, well-typeset PDF.
 *   preview_pdf — rasterise one page of a PDF to PNG so you can Read it and
 *                 actually SEE the result before sending it to anyone.
 *
 * The rendering lives in render.py (weasyprint is Python); this process just
 * speaks MCP and shells out to it. Truthful by construction: if the render
 * fails, the tool returns an error — it never claims success it can't back up.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RENDER_PY = path.join(HERE, 'render.py');
const PROJECT_DIR = process.env.PROJECT_DIR || '/home/coder/project';
const DEFAULT_OUT_DIR = process.env.PDF_OUTPUT_DIR || path.join(PROJECT_DIR, 'Documents');

// Named style presets are MCP-owned state — the ONLY thing that touches this
// file is this server (via save/list/delete + preset resolution in render_pdf).
// The brain never reads or writes it directly. It lives under a hidden,
// component-owned dir on the project volume so it survives restarts/redeploys.
const STYLE_DIR = path.join(PROJECT_DIR, '.pdf-mcp');
const STYLE_STORE = path.join(STYLE_DIR, 'styles.json');
// The knobs a preset may carry (mirrors render.py's validated surface). Anything
// else is dropped on save so the store stays clean; render.py clamps values.
const STYLE_KEYS = ['accent', 'text', 'muted', 'link', 'font', 'size', 'density', 'rules', 'title_rule', 'justify', 'table', 'table_header', 'page'];
// The house.css baseline for every knob. A saved preset is filled out to the FULL
// set from this, so a layout pins the WHOLE look (not just the one thing someone
// mentioned) — that's what keeps documents consistent instead of "same colour but
// the font drifted".
const STYLE_DEFAULTS = {
  accent: 'slate', text: 'ink', muted: '#6b7075', link: 'blue',
  font: 'serif', size: 10.5, density: 'normal', rules: false,
  title_rule: true, justify: false, table: 'grid', table_header: 'shaded', page: 'A4',
};

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

// Keep only recognised knobs from a style object (shallow whitelist).
function sanitizeStyle(raw) {
  const out = {};
  if (raw && typeof raw === 'object') {
    for (const k of STYLE_KEYS) if (raw[k] !== undefined && raw[k] !== null) out[k] = raw[k];
  }
  return out;
}

// Read the preset store → { default, presets, last }. `last` is the effective
// style of the most recent render, so "save this look" can capture the FULL set
// of knobs that produced the approved document, not just what someone named.
// Missing/corrupt file → empty store (never throws).
async function readStyles() {
  try {
    const j = JSON.parse(await fs.readFile(STYLE_STORE, 'utf8'));
    const presets = (j && typeof j.presets === 'object' && j.presets) ? j.presets : {};
    const last = (j && typeof j._last === 'object' && j._last) ? j._last : {};
    return { default: typeof j?.default === 'string' ? j.default : null, presets, last };
  } catch { return { default: null, presets: {}, last: {} }; }
}

// Persist the readStyles shape ({default, presets, last}). `last` is serialised as
// the internal `_last` key so it never collides with a preset name.
async function writeStyles(store) {
  await fs.mkdir(STYLE_DIR, { recursive: true, mode: 0o770 });
  const out = { default: store.default ?? null, presets: store.presets || {} };
  if (store.last && Object.keys(store.last).length) out._last = store.last;
  const tmp = STYLE_STORE + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(out, null, 2));
  await fs.rename(tmp, STYLE_STORE);   // atomic swap
}

// A preset name: short, filesystem/JSON-friendly, human-typable.
function cleanName(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase().replace(/[^\w -]/g, '').replace(/\s+/g, '-').slice(0, 40);
  return s;
}

// Spawn a child process, feed optional stdin, collect stdout/stderr.
function run(cmd, cmdArgs, stdin = null) {
  return new Promise((resolve) => {
    const p = spawn(cmd, cmdArgs, { cwd: PROJECT_DIR });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out, err: err || String(e) }));
    p.on('close', (code) => resolve({ code, out, err }));
    if (stdin != null) { p.stdin.write(stdin); p.stdin.end(); }
  });
}

// Resolve a user-supplied path to an absolute one under the project. Relative
// paths are taken against the project root (what the bot sees as its cwd).
function abs(p) {
  if (!p) return null;
  return path.isAbsolute(p) ? p : path.resolve(PROJECT_DIR, p);
}

async function fileSize(p) { try { return (await fs.stat(p)).size; } catch { return 0; } }

// Page count via pdfinfo (poppler-utils). Best-effort — absence is not fatal.
async function pageCount(pdfPath) {
  const r = await run('pdfinfo', [pdfPath]);
  if (r.code !== 0) return null;
  const m = r.out.match(/^Pages:\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

const server = new Server(
  { name: 'pdf-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'render_pdf',
      description:
        'Turn a document into a clean, professionally typeset PDF. This is the ONLY correct way to make a ' +
        'PDF here — never write raw PDF bytes or a Python PDF builder by hand. Give it markdown, either as an ' +
        'existing .md file (source_path) or inline (markdown). Tables, headings, lists, code, blockquotes and ' +
        'accented/Unicode text all render correctly. Returns the absolute PDF path, page count and size. ' +
        'After rendering, use preview_pdf to SEE it before you send it to anyone. ' +
        'To change the LOOK (colour, font, size, spacing), use `preset` (a saved named layout) and/or the `style` ' +
        'knobs below — NEVER edit the document content or its structure to achieve a visual effect, and never ' +
        'hand-write CSS. If no preset is given, the saved default layout (if any) is applied automatically.',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string', description: 'Path to a markdown (.md) file to render (relative to the project or absolute). Use this OR markdown.' },
          markdown:    { type: 'string', description: 'Inline markdown content to render. Use this OR source_path.' },
          out_path:    { type: 'string', description: 'Where to write the PDF. Defaults to Documents/<name>.pdf (from source_path) or Documents/document.pdf.' },
          title:       { type: 'string', description: 'The document headline, rendered as a prominent title block at the top of the first page. ALWAYS set this for a real document (letter, proposal, report, invoice) — without a title the PDF opens straight into body text with no headline. (If the markdown already starts with a single "# Heading", that is used as the title automatically and you can omit this.)' },
          preset:      { type: 'string', description: 'Name of a saved layout to render in (see list_pdf_styles / save_pdf_style). Its knobs form the base look; the `style` object below overrides individual knobs. Omit to use the saved default layout, if one is set.' },
          style:       {
            type: 'object',
            description:
              'The ONLY safe way to change the visual look — every value is validated, so nothing here can break the layout. ' +
              'Use this when someone asks to restyle the document (warmer colour, bigger text, tighter spacing, Letter paper). ' +
              'Do NOT change the markdown content or structure to get a visual effect.',
            properties: {
              accent:       { type: 'string', description: 'Heading + title colour. A named colour (slate, blue, navy, teal, green, plum, maroon, orange, gray) or a #rrggbb hex. Default slate.' },
              text:         { type: 'string', description: 'Body text colour (named colour or #rrggbb hex). Default near-black.' },
              muted:        { type: 'string', description: 'Secondary text colour — the date/meta line and page numbers (named or #rrggbb hex). Default grey.' },
              link:         { type: 'string', description: 'Hyperlink colour (named or #rrggbb hex). Default blue.' },
              font:         { type: 'string', enum: ['serif', 'sans'], description: 'Body font. serif (default, formal) or sans (modern). Headings are always sans.' },
              size:         { type: 'number', description: 'Base text size in pt, clamped to 9–13. Default 10.5.' },
              density:      { type: 'string', enum: ['compact', 'normal', 'relaxed'], description: 'Spacing/margins. compact = tighter, relaxed = airier. Default normal.' },
              rules:        { type: 'boolean', description: 'Draw a hairline under section headings. Default false (clean, no lines).' },
              title_rule:   { type: 'boolean', description: 'Draw the rule under the document title. Default true.' },
              justify:      { type: 'boolean', description: 'Justify body text (flush both margins) instead of left-aligned. Default false.' },
              table:        { type: 'string', enum: ['grid', 'lined', 'plain'], description: 'Table style. grid = full borders + zebra (default); lined = horizontal rules only; plain = borderless, spacing only.' },
              table_header: { type: 'string', enum: ['shaded', 'accent', 'plain'], description: 'Table header row. shaded = grey fill (default); accent = accent-coloured text + underline; plain = just bold.' },
              page:         { type: 'string', enum: ['A4', 'Letter'], description: 'Paper size. Default A4.' },
            },
          },
        },
      },
    },
    {
      name: 'preview_pdf',
      description:
        'Rasterise one page of a PDF to a PNG image so you can Read it and actually SEE how it looks — layout, ' +
        'tables, spacing — before sending it. Returns the PNG path; open it with the Read tool to view it. ' +
        'Always preview a freshly rendered PDF before delivering it, especially when asked to "check it visually".',
      inputSchema: {
        type: 'object',
        properties: {
          pdf_path: { type: 'string', description: 'Path to the PDF to preview (relative to the project or absolute).' },
          page:     { type: 'number', description: 'Page number to render (1-based). Default 1.' },
        },
        required: ['pdf_path'],
      },
    },
    {
      name: 'save_pdf_style',
      description:
        'Save a named layout (a set of style knobs) so PDFs can be rendered in it later with render_pdf({ preset }). ' +
        'Use this when someone is happy with a look and asks to remember/save it ("save this style as X", "use this ' +
        'from now on"). Pass the exact style you just rendered with. Set set_default:true to make it the layout ' +
        'applied automatically when no preset is named. Saving an existing name overwrites it. Multiple layouts can be saved.',
      inputSchema: {
        type: 'object',
        properties: {
          name:        { type: 'string', description: 'Short name for the layout, e.g. "brand", "invoice", "letter".' },
          style:       { type: 'object', description: 'The style knobs to store (accent/font/size/density/rules/page) — same shape as render_pdf\'s style.' },
          set_default: { type: 'boolean', description: 'Also make this the default layout (applied when render_pdf gets no preset). Default false.' },
        },
        required: ['name', 'style'],
      },
    },
    {
      name: 'list_pdf_styles',
      description: 'List the saved named layouts with their knobs, and which one is the default. Use it to see what is available before rendering with a preset or when someone asks which styles are saved.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'delete_pdf_style',
      description: 'Delete a saved named layout. If it was the default, the default is cleared.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name of the layout to delete.' } },
        required: ['name'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === 'render_pdf') {
    const hasFile = args.source_path && String(args.source_path).trim();
    const hasInline = args.markdown && String(args.markdown).trim();
    if (!hasFile && !hasInline) return fail('Give me something to render: a source_path (.md file) or inline markdown.');
    if (hasFile && hasInline) return fail('Pass either source_path or markdown, not both.');

    // Decide the output path.
    let out = abs(args.out_path);
    if (!out) {
      const base = hasFile ? path.basename(String(args.source_path)).replace(/\.md$/i, '') : 'document';
      out = path.join(DEFAULT_OUT_DIR, `${base}.pdf`);
    }
    if (!/\.pdf$/i.test(out)) out += '.pdf';

    const pyArgs = ['--out', out];
    if (args.title && String(args.title).trim()) pyArgs.push('--title', String(args.title).trim());

    // Resolve the effective style: a named preset (or the saved default) forms the
    // base, and any per-call `style` overrides it knob-by-knob. render.py still
    // validates/clamps the merged result, so nothing here can break the layout.
    const store = await readStyles();
    let base = {};
    if (args.preset && String(args.preset).trim()) {
      const nm = cleanName(args.preset);
      if (!store.presets[nm]) return fail(`No saved layout named "${nm}". Use list_pdf_styles to see what's available, or save_pdf_style to create it.`);
      base = store.presets[nm];
    } else if (store.default && store.presets[store.default]) {
      base = store.presets[store.default];
    }
    const effectiveStyle = { ...sanitizeStyle(base), ...sanitizeStyle(args.style) };
    if (Object.keys(effectiveStyle).length) pyArgs.push('--style', JSON.stringify(effectiveStyle));

    // Remember the FULL effective look of this render so a later "save this style"
    // can capture every knob that produced it — not just the one someone named.
    try { await writeStyles({ ...store, last: { ...STYLE_DEFAULTS, ...effectiveStyle } }); } catch { /* best-effort */ }

    let r;
    if (hasFile) {
      const inPath = abs(args.source_path);
      try { await fs.access(inPath); } catch { return fail(`Markdown source not found: ${inPath}`); }
      r = await run('python3', [RENDER_PY, '--in', inPath, ...pyArgs]);
    } else {
      r = await run('python3', [RENDER_PY, '--stdin', ...pyArgs], String(args.markdown));
    }

    if (r.code !== 0) return fail(`PDF render failed: ${(r.err || r.out || 'unknown error').trim()}`);

    const size = await fileSize(out);
    const pages = await pageCount(out);
    const kb = (size / 1024).toFixed(1);
    return ok(
      `Rendered PDF → ${out}\n` +
      `${pages != null ? `${pages} page${pages === 1 ? '' : 's'}, ` : ''}${kb} KB.\n` +
      `Next: call preview_pdf on this path to SEE it before you send it. ` +
      `To deliver it to a Telegram group, emit a [[SEND_FILE ${out}]] marker; in a 1:1 DM, use the Telegram sendDocument tool. ` +
      `Do NOT tell anyone you sent a file unless you actually invoked one of those.`,
    );
  }

  if (name === 'preview_pdf') {
    if (!args.pdf_path) return fail('Which PDF? Pass pdf_path.');
    const pdf = abs(args.pdf_path);
    try { await fs.access(pdf); } catch { return fail(`PDF not found: ${pdf}`); }
    const page = Number.isFinite(args.page) && args.page > 0 ? Math.floor(args.page) : 1;
    const stem = pdf.replace(/\.pdf$/i, '') + `.preview-p${page}`;

    // pdftoppm writes <stem>.png (or <stem>-NN.png with -f/-l on some builds).
    const r = await run('pdftoppm', ['-png', '-r', '110', '-f', String(page), '-l', String(page), '-singlefile', pdf, stem]);
    if (r.code !== 0) return fail(`Could not rasterise the PDF: ${(r.err || 'pdftoppm failed').trim()}`);
    const png = `${stem}.png`;
    if (!(await fileSize(png))) return fail(`Preview render produced no image (does page ${page} exist?).`);
    return ok(`Preview of page ${page} → ${png}\nOpen it with the Read tool to view the page and check the layout before sending.`);
  }

  if (name === 'save_pdf_style') {
    const nm = cleanName(args.name);
    if (!nm) return fail('Give the layout a short name (letters/numbers/dashes).');
    const store = await readStyles();
    // A layout pins the WHOLE look, so it stays consistent — never just one knob.
    // Base = the house defaults, layered with the last render's full effective
    // style (what the approved document actually looked like), then any explicit
    // knobs passed here win. Result always carries all six knobs.
    const style = { ...STYLE_DEFAULTS, ...sanitizeStyle(store.last), ...sanitizeStyle(args.style) };
    const existed = !!store.presets[nm];
    store.presets[nm] = style;
    if (args.set_default === true) store.default = nm;
    await writeStyles(store);
    const knobs = STYLE_KEYS.map((k) => `${k}=${style[k]}`).join(', ');
    return ok(`${existed ? 'Updated' : 'Saved'} layout "${nm}" — full look pinned (${knobs})${store.default === nm ? '. Now the default' : ''}. Render in it with render_pdf({ preset: "${nm}" }); every document in this layout will match.`);
  }

  if (name === 'list_pdf_styles') {
    const store = await readStyles();
    const names = Object.keys(store.presets);
    if (!names.length) return ok('No saved layouts yet. Save one with save_pdf_style once a look is dialled in.');
    const lines = names.map((n) => {
      const knobs = Object.entries(store.presets[n]).map(([k, v]) => `${k}=${v}`).join(', ') || '(no knobs)';
      return `- ${n}${store.default === n ? ' [default]' : ''}: ${knobs}`;
    });
    return ok(`Saved layouts:\n${lines.join('\n')}`);
  }

  if (name === 'delete_pdf_style') {
    const nm = cleanName(args.name);
    const store = await readStyles();
    if (!store.presets[nm]) return fail(`No saved layout named "${nm}".`);
    delete store.presets[nm];
    if (store.default === nm) store.default = null;
    await writeStyles(store);
    return ok(`Deleted layout "${nm}".`);
  }

  return fail(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
