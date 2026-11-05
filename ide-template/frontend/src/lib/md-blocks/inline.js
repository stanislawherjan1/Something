// Inline content between markdown (mdast phrasing nodes) and BlockNote.
//
// BlockNote keeps a paragraph's text as a flat list of styled runs and links;
// mdast nests strong/emphasis/delete around text. Only what markdown can say
// is mapped: bold, italic, strike, inline code, links and hard breaks. Anything
// else in a paragraph (inline HTML, images inside text, reference links,
// footnotes, a link title) has no BlockNote form that would survive a save, so
// the converter reports it and the caller keeps that block as raw source.

const MARKS = [
  ['delete', 'strike'],
  ['strong', 'bold'],
  ['emphasis', 'italic'],
];
const STYLE_OF = Object.fromEntries(MARKS);
const NODE_OF = Object.fromEntries(MARKS.map(([node, style]) => [style, node]));

export class Unsupported extends Error {}

// mdast phrasing → BlockNote inline content. Throws Unsupported.
export function phrasingToInline(nodes, styles = {}) {
  const out = [];
  for (const n of nodes || []) {
    if (n.type === 'text') pushText(out, n.value.replace(/[ \t]*\r?\n[ \t]*/g, ' '), styles);
    else if (n.type === 'break') pushText(out, '\n', styles);
    else if (n.type === 'inlineCode') pushText(out, n.value, { ...styles, code: true });
    else if (STYLE_OF[n.type]) out.push(...phrasingToInline(n.children, { ...styles, [STYLE_OF[n.type]]: true }));
    else if (n.type === 'link') {
      if (n.title) throw new Unsupported('link title');
      const content = phrasingToInline(n.children, styles);
      if (content.some(c => c.type !== 'text')) throw new Unsupported('nested link');
      out.push({ type: 'link', href: n.url, content });
    } else throw new Unsupported(n.type);
  }
  return merge(out);
}

function pushText(out, text, styles) {
  if (!text) return;
  out.push({ type: 'text', text, styles: clean(styles) });
}

function clean(styles) {
  const s = {};
  for (const k of ['bold', 'italic', 'strike', 'code']) if (styles[k]) s[k] = true;
  return s;
}

const sameStyles = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));

function merge(items) {
  const out = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.type === 'text' && last?.type === 'text' && sameStyles(last.styles, it.styles)) last.text += it.text;
    else out.push(it);
  }
  return out;
}

// BlockNote inline content (or a plain string) → mdast phrasing nodes.
// Runs that share a mark are grouped under one node, so "**a *b***" stays one
// strong node instead of two touching ones (which markdown cannot write).
export function inlineToPhrasing(content) {
  if (typeof content === 'string') content = content ? [{ type: 'text', text: content, styles: {} }] : [];
  const runs = [];
  for (const c of content || []) {
    if (c.type === 'text') runs.push({ kind: 'text', text: c.text, styles: clean(c.styles || {}) });
    else if (c.type === 'link') {
      // "**[text](url)**": a mark on every run of the link's text is put outside it.
      const inner = (c.content || []).map(r => clean(r.styles || {}));
      const shared = {};
      for (const k of ['bold', 'italic', 'strike']) if (inner.length && inner.every(s => s[k])) shared[k] = true;
      const content = (c.content || []).map(r => ({ ...r, styles: Object.fromEntries(Object.entries(clean(r.styles || {})).filter(([k]) => !shared[k])) }));
      runs.push({ kind: 'link', href: c.href, content, styles: shared });
    }
  }
  return group(runs, MARKS.map(([, style]) => style));
}

function group(runs, marks) {
  const out = [];
  let i = 0;
  while (i < runs.length) {
    const mark = marks.find(m => runs[i].styles[m]);
    if (!mark) { out.push(...leaf(runs[i])); i++; continue; }
    let j = i;
    while (j < runs.length && runs[j].styles[mark]) j++;
    const inner = runs.slice(i, j).map(r => ({ ...r, styles: { ...r.styles, [mark]: false } }));
    // A space at the edge of the marked stretch goes outside it ("*a* b", not
    // "*a&#x20;*b"): markdown cannot open or close a mark next to a space.
    const edge = (r, re) => (r.kind === 'text' && !r.styles.code ? (re.exec(r.text) || [''])[0] : '');
    const lead = edge(inner[0], /^\s+/);
    if (lead) inner[0] = { ...inner[0], text: inner[0].text.slice(lead.length) };
    const last = inner.length - 1;
    const trail = inner[last].text ? edge(inner[last], /\s+$/) : '';
    if (trail) inner[last] = { ...inner[last], text: inner[last].text.slice(0, -trail.length) };
    if (lead) out.push({ type: 'text', value: lead });
    const kept = inner.filter(r => r.kind !== 'text' || r.text);
    if (kept.length) out.push({ type: NODE_OF[mark], children: group(kept, marks.filter(m => m !== mark)) });
    if (trail) out.push({ type: 'text', value: trail });
    i = j;
  }
  return out;
}

function leaf(run) {
  if (run.kind === 'link') return [{ type: 'link', url: run.href, title: null, children: inlineToPhrasing(run.content) }];   // its own marks are already outside
  if (run.styles.code) return [{ type: 'inlineCode', value: run.text.replace(/\n/g, ' ') }];
  const parts = run.text.split('\n');
  const out = [];
  parts.forEach((p, k) => {
    if (k > 0) out.push({ type: 'break' });
    if (p) out.push({ type: 'text', value: p });
  });
  return out;
}

// The plain text of BlockNote inline content (for empty checks).
export function inlineText(content) {
  if (typeof content === 'string') return content;
  return (content || []).map(c => (c.type === 'link' ? inlineText(c.content) : c.text || '')).join('');
}
