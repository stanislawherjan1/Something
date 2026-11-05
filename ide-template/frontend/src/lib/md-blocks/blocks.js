// Markdown ↔ BlockNote blocks, one top-level block per "unit" of the source.
//
// A unit is a slice of the file that becomes exactly one top-level block: a
// paragraph, a heading, a table, a code block, one item of a list (with its
// nested items as children), or raw source. Each unit remembers its bytes, so
// a block nobody touched is written back as those bytes (doc.js); only edited
// blocks go through toMarkdown below.
//
// Anything BlockNote has no block for (HTML, footnotes, definitions, a quote
// with several paragraphs, a list item opening with code…) becomes a
// `rawMarkdown` block holding its exact source. Nothing is ever dropped.

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { toMarkdown } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { phrasingToInline, inlineToPhrasing, inlineText, Unsupported } from './inline.js';

const parser = unified().use(remarkParse).use(remarkGfm);

export const RAW = 'rawMarkdown';
const LIST_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);
export const isListBlock = (b) => LIST_TYPES.has(b?.type);

// ── markdown → units ─────────────────────────────────────────────────────────

// Returns { units, lead, trail, style }. units: [{ start, end, text, block,
// list }] in source order; `list` = { ordered, spread } for list items.
export function parseUnits(md) {
  const tree = parser.parse(md);
  const units = [];
  for (const node of tree.children) {
    if (node.type === 'list') {
      node.children.forEach((item, k) => {
        const unit = unitFor(md, item, () => itemBlock(item, node, md), { ordered: !!node.ordered, spread: listSpread(node), first: k === 0 });
        // BlockNote numbers a run of items from the first one's `start`.
        if (k === 0 && node.ordered && unit.block.type === 'numberedListItem' && (node.start ?? 1) !== 1) unit.block.props = { ...unit.block.props, start: node.start };
        units.push(unit);
      });
    } else {
      units.push(unitFor(md, node, () => nodeBlock(node)));
    }
  }
  const first = units[0], last = units[units.length - 1];
  return {
    units,
    lead: first ? md.slice(0, first.start) : md,
    trail: last ? md.slice(last.end) : '',
    style: detectStyle(md, tree),
  };
}

function unitFor(md, node, build, list = null) {
  const start = node.position.start.offset, end = node.position.end.offset;
  const text = md.slice(start, end);
  let block;
  try { block = build(); } catch (e) { if (!(e instanceof Unsupported)) throw e; block = rawBlock(text); }
  // BlockNote has one "left" for both `---` and `:--`; the file's own choice is kept here.
  const tableAlign = node.type === 'table' && block.type === 'table' ? node.align || [] : null;
  return { start, end, text, block, list, tableAlign };
}

const rawBlock = (source) => ({ type: RAW, props: { source } });

function listSpread(list) {
  return !!list.spread || list.children.some(i => i.spread);
}

function itemBlock(item, list, md) {
  const kids = item.children || [];
  let content = [];
  let rest = kids;
  if (kids[0]?.type === 'paragraph') { content = paraInline(kids[0]); rest = kids.slice(1); }
  else if (kids.length) throw new Unsupported('item does not open with text');
  const type = item.checked !== null && item.checked !== undefined ? 'checkListItem'
    : list.ordered ? 'numberedListItem' : 'bulletListItem';
  const block = { type, content, children: childBlocks(rest, md) };
  if (type === 'checkListItem') block.props = { checked: !!item.checked };
  return block;
}

function childBlocks(nodes, md) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'list') for (const it of n.children) out.push(itemBlock(it, n, md));
    else out.push(nodeBlock(n));
  }
  return out;
}

function paraInline(p) {
  return phrasingToInline(p.children);
}

function nodeBlock(node) {
  switch (node.type) {
    case 'heading':
      return { type: 'heading', props: { level: node.depth }, content: phrasingToInline(node.children) };
    case 'paragraph': {
      const only = node.children.length === 1 ? node.children[0] : null;
      if (only?.type === 'image' && !only.title) return { type: 'image', props: { url: only.url, name: only.alt || '', caption: '' } };
      return { type: 'paragraph', content: paraInline(node) };
    }
    case 'blockquote':
      if (node.children.length === 1 && node.children[0].type === 'paragraph') return { type: 'quote', content: paraInline(node.children[0]) };
      throw new Unsupported('complex quote');
    case 'code':
      if (node.meta) throw new Unsupported('code meta');
      return { type: 'codeBlock', props: { language: node.lang || 'text' }, content: [{ type: 'text', text: node.value, styles: {} }] };
    case 'thematicBreak':
      return { type: 'divider' };
    case 'table':
      return tableBlock(node);
    case 'list':
      throw new Unsupported('list inside a block');
    default:
      throw new Unsupported(node.type);
  }
}

const ALIGN_IN = { left: 'left', center: 'center', right: 'right' };

function tableBlock(node) {
  const align = node.align || [];
  const rows = node.children.map(row => ({
    cells: row.children.map((cell, ci) => ({
      type: 'tableCell',
      content: phrasingToInline(cell.children),
      props: { textAlignment: ALIGN_IN[align[ci]] || 'left' },
    })),
  }));
  const width = Math.max(...rows.map(r => r.cells.length));
  for (const r of rows) while (r.cells.length < width) r.cells.push({ type: 'tableCell', content: [], props: { textAlignment: ALIGN_IN[align[r.cells.length]] || 'left' } });
  return { type: 'table', content: { type: 'tableContent', headerRows: 1, rows } };
}

// The markers this file already uses, so an edited block is written the same way.
function detectStyle(md, tree) {
  const style = { bullet: '-', emphasis: '*', strong: '*' };
  const seen = { bullet: false, emphasis: false, strong: false };
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    const at = n.position?.start?.offset;
    if (at !== undefined) {
      if (n.type === 'listItem' && !seen.bullet) {
        const m = /^\s*([-*+])\s/.exec(md.slice(at, at + 8));
        if (m) { style.bullet = m[1]; seen.bullet = true; }
      } else if (n.type === 'emphasis' && !seen.emphasis && (md[at] === '_' || md[at] === '*')) {
        style.emphasis = md[at]; seen.emphasis = true;
      } else if (n.type === 'strong' && !seen.strong && (md[at] === '_' || md[at] === '*')) {
        style.strong = md[at]; seen.strong = true;
      }
    }
    for (const c of n.children || []) visit(c);
  };
  visit(tree);
  return style;
}

// ── blocks → markdown (for blocks that changed) ──────────────────────────────

// One top-level block as markdown, without a trailing newline. `number` is the
// item's number when it is a numbered list item. Returns '' for a block that
// says nothing in markdown (an empty paragraph).
export function blockToMarkdown(block, { style = {}, number = 1, tableAlign = null, original = null } = {}) {
  if (block.type === RAW) return String(block.props?.source ?? '').replace(/\n+$/, '');
  const nodes = block.type === 'table' ? [tableToMdast(block, tableAlign)] : blockToMdast(block, number);
  if (!nodes.length) return '';
  const md = render(nodes, style, { tablePipeAlign: block.type === 'table' && !!original && isPaddedTable(original) });
  // A table rewritten after one cell changed keeps every other row's own line.
  return block.type === 'table' && original ? keepTableLines(original, md) : md;
}

function render(nodes, style, { tablePipeAlign = false } = {}) {
  return toMarkdown({ type: 'root', children: nodes }, {
    extensions: [gfmToMarkdown({ tablePipeAlign })],
    bullet: style.bullet || '-',
    bulletOther: (style.bullet || '-') === '-' ? '*' : '-',
    emphasis: style.emphasis || '*',
    strong: style.strong || '*',
    rule: '-',
    fence: '`',
    fences: true,
    listItemIndent: 'one',
    incrementListMarker: true,
  }).replace(/\n+$/, '');
}

// Cells of one table line, trailing empty ones dropped (a short row and a
// padded one show the same).
function lineCells(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim());
  while (cells.length && !cells[cells.length - 1]) cells.pop();
  return cells;
}
const delimiterKey = (line) => JSON.stringify(lineCells(line).map(c => `${c.startsWith(':') ? 'L' : ''}${c.endsWith(':') ? 'R' : ''}`));

// A table written with its pipes lined up (every line the same width).
function isPaddedTable(text) {
  const lines = text.split('\n').filter(Boolean);
  return lines.length > 2 && lines.every(l => l.length === lines[0].length);
}

function keepTableLines(original, fresh) {
  const O = original.split('\n'), F = fresh.split('\n');
  // A column added or removed changes every row, and a header that does not
  // match the delimiter row is no table at all: then the table is written anew.
  const width = (line) => (line === undefined ? -1 : line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).length);
  if (width(O[1]) !== width(F[1])) return fresh;
  const pool = new Map();
  O.forEach((line, i) => {
    if (i === 1) return;
    const k = JSON.stringify(lineCells(line));
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(line);
  });
  return F.map((line, i) => {
    if (i === 1) return O[1] !== undefined && delimiterKey(O[1]) === delimiterKey(line) && lineCells(O[1]).length === lineCells(line).length ? O[1] : line;
    const same = pool.get(JSON.stringify(lineCells(line)));
    return same?.length ? same.shift() : line;
  }).join('\n');
}

function blockToMdast(block, number = 1) {
  const kids = (block.children || []);
  let own;
  switch (block.type) {
    case 'paragraph': {
      const ph = inlineToPhrasing(block.content);
      own = ph.length ? [{ type: 'paragraph', children: ph }] : [];
      break;
    }
    case 'heading':
      own = [{ type: 'heading', depth: Math.min(6, Math.max(1, Number(block.props?.level) || 1)), children: inlineToPhrasing(block.content) }];
      break;
    case 'quote':
      own = [{ type: 'blockquote', children: [{ type: 'paragraph', children: inlineToPhrasing(block.content) }] }];
      break;
    case 'codeBlock': {
      const lang = block.props?.language;
      own = [{ type: 'code', lang: lang && lang !== 'text' ? lang : null, meta: null, value: inlineText(block.content) }];
      break;
    }
    case 'divider':
      own = [{ type: 'thematicBreak' }];
      break;
    case 'image':
      own = block.props?.url ? [{ type: 'paragraph', children: [{ type: 'image', url: block.props.url, alt: block.props.name || block.props.caption || '', title: null }] }] : [];
      break;
    case 'table':
      own = [tableToMdast(block)];
      break;
    case 'bulletListItem':
    case 'numberedListItem':
    case 'checkListItem':
      return [listToMdast([block], block.type === 'numberedListItem', number)];
    case RAW:
      own = [{ type: 'html', value: String(block.props?.source ?? '') }];
      break;
    default:
      // A block type with no markdown form keeps its text, never vanishes.
      own = inlineText(block.content) ? [{ type: 'paragraph', children: inlineToPhrasing(block.content) }] : [];
  }
  // Markdown has no nesting under a paragraph or a heading: the children follow it.
  return [...own, ...childrenToMdast(kids)];
}

function childrenToMdast(kids) {
  const out = [];
  let i = 0;
  while (i < kids.length) {
    if (isListBlock(kids[i])) {
      const ordered = kids[i].type === 'numberedListItem';
      let j = i;
      while (j < kids.length && isListBlock(kids[j]) && (kids[j].type === 'numberedListItem') === ordered) j++;
      out.push(listToMdast(kids.slice(i, j), ordered, Number(kids[i].props?.start) || 1));
      i = j;
    } else {
      out.push(...blockToMdast(kids[i]));
      i++;
    }
  }
  return out;
}

function listToMdast(items, ordered, start = 1) {
  return {
    type: 'list',
    ordered,
    start: ordered ? start : null,
    spread: false,
    children: items.map(it => ({
      type: 'listItem',
      spread: false,
      checked: it.type === 'checkListItem' ? !!it.props?.checked : null,
      children: [
        ...(inlineText(it.content) || !(it.children || []).length ? [{ type: 'paragraph', children: inlineToPhrasing(it.content) }] : []),
        ...childrenToMdast(it.children || []),
      ],
    })),
  };
}

const ALIGN_OUT = { center: 'center', right: 'right' };

function tableToMdast(block, hint = null) {
  const rows = block.content?.rows || [];
  const cellsOf = (row) => (row.cells || []).map(c => (Array.isArray(c) || typeof c === 'string' ? { content: c, props: {} } : c));
  const width = Math.max(1, ...rows.map(r => cellsOf(r).length));
  const header = rows[0] ? cellsOf(rows[0]) : [];
  const align = Array.from({ length: width }, (_, i) => {
    const a = header[i]?.props?.textAlignment;
    if (ALIGN_OUT[a]) return ALIGN_OUT[a];
    return a === 'left' && hint?.[i] === 'left' ? 'left' : null;
  });
  const cellNode = (c) => ({
    type: 'tableCell',
    children: inlineToPhrasing(flatten(c?.content)),
  });
  return {
    type: 'table',
    align,
    children: (rows.length ? rows : [{ cells: [] }]).map(r => {
      const cells = cellsOf(r);
      return { type: 'tableRow', children: Array.from({ length: width }, (_, i) => cellNode(cells[i])) };
    }),
  };
}

// A table cell cannot hold a line break in markdown.
function flatten(content) {
  if (typeof content === 'string') return content.replace(/\n/g, ' ');
  return (content || []).map(c => (c.type === 'text' ? { ...c, text: c.text.replace(/\n/g, ' ') } : c));
}
