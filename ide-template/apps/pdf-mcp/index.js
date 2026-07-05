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

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

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
        'After rendering, use preview_pdf to SEE it before you send it to anyone.',
      inputSchema: {
        type: 'object',
        properties: {
          source_path: { type: 'string', description: 'Path to a markdown (.md) file to render (relative to the project or absolute). Use this OR markdown.' },
          markdown:    { type: 'string', description: 'Inline markdown content to render. Use this OR source_path.' },
          out_path:    { type: 'string', description: 'Where to write the PDF. Defaults to Documents/<name>.pdf (from source_path) or Documents/document.pdf.' },
          title:       { type: 'string', description: 'The document headline, rendered as a prominent title block at the top of the first page. ALWAYS set this for a real document (letter, proposal, report, invoice) — without a title the PDF opens straight into body text with no headline. (If the markdown already starts with a single "# Heading", that is used as the title automatically and you can omit this.)' },
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

  return fail(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
