// The markdown editor's file layer, with the real BlockNote editor running
// headless. Run: npm test (in ide-template/frontend).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { markdownSchema } from './schema.js';
import { load, snapshot, serialize, afterSave, merge, applyOps } from './doc.js';

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));

function newEditor() {
  return ServerBlockNoteEditor.create({ schema: markdownSchema }).editor;
}
function open(body) {
  const editor = newEditor();
  const { state, blocks } = load(body);
  editor.replaceBlocks(editor.document, blocks.length ? blocks : [{ type: 'paragraph' }]);
  snapshot(state, editor.document);
  return { editor, state };
}
const save = (s, editor) => serialize(s, editor.document).body;

// Meaning of a markdown text: its syntax tree without positions, with runs of
// whitespace in text collapsed (a re-wrapped paragraph says the same thing).
const parser = unified().use(remarkParse).use(remarkGfm);
function meaning(md) {
  const strip = (n) => {
    if (Array.isArray(n)) return n.map(strip);
    if (!n || typeof n !== 'object') return n;
    const o = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'position' || k === 'spread') continue;
      o[k] = k === 'value' && typeof v === 'string' && n.type === 'text' ? v.replace(/\s+/g, ' ')
        : k === 'value' && typeof v === 'string' && n.type === 'inlineCode' ? v.replace(/\r?\n/g, ' ')   // CommonMark: a line ending in a code span is a space
        : strip(v);
    }
    // A short table row shows as one padded with empty cells.
    if (n.type === 'table') {
      const width = Math.max(...o.children.map(r => r.children.length));
      for (const r of o.children) while (r.children.length < width) r.children.push({ type: 'tableCell', children: [] });
    }
    return o;
  };
  return JSON.stringify(strip(parser.parse(md)));
}
const splitFrontmatter = (t) => { const m = /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/.exec(t); return m ? t.slice(m[1].length) : t; };

function corpus() {
  const files = [];
  const add = (dir, pick = (f) => f.endsWith('.md')) => {
    const abs = join(REPO, dir);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, e.name);
      if (e.isDirectory()) add(join(dir, e.name), pick);
      else if (pick(e.name)) files.push(p);
    }
  };
  add('docs', (f) => f.endsWith('.md'));
  add('ide-template/skills/default', (f) => f === 'SKILL.md');
  add('ide-template/bootstrap', (f) => f.endsWith('.md'));
  add('ide-template/frontend/src/demo/data', (f) => f.endsWith('.md'));
  return files.filter(f => !f.includes('/future-plans/') && !f.includes('/postmortems/'));
}

test('every corpus file is written back byte for byte when nothing was touched', () => {
  const files = corpus();
  assert.ok(files.length > 30, `corpus too small: ${files.length}`);
  for (const f of files) {
    const body = splitFrontmatter(readFileSync(f, 'utf8'));
    const { editor, state } = open(body);
    assert.equal(save(state, editor), body, f);
  }
});

test('every corpus file keeps its meaning when every block is rewritten', () => {
  const bad = [];
  for (const f of corpus()) {
    const body = splitFrontmatter(readFileSync(f, 'utf8'));
    const { editor, state } = open(body);
    for (const u of state.units.values()) u.snap = null;      // as if each block had been edited
    const out = save(state, editor);
    if (meaning(out) !== meaning(body)) bad.push(f.slice(REPO.length));
  }
  assert.deepEqual(bad, []);
});

const TABLE = [
  'Intro line.',
  '',
  '| Item | Qty | Price |',
  '|:-----|:---:|------:|',
  '| **Mug** | 2 | `12.00` |',
  '| Bowl | 1 | 30.00 |',
  '',
  'After.',
  '',
].join('\n');

test('a table loads as a table block with its alignment and formatting', () => {
  const { editor } = open(TABLE);
  const t = editor.document.find(b => b.type === 'table');
  assert.ok(t, 'table block');
  assert.equal(t.content.rows.length, 3);
  const aligns = t.content.rows[0].cells.map(c => c.props.textAlignment);
  assert.deepEqual(aligns, ['left', 'center', 'right']);
  const mug = t.content.rows[1].cells[0].content[0];
  assert.equal(mug.text, 'Mug');
  assert.equal(mug.styles.bold, true);
});

test('editing one table cell rewrites only the table, alignment kept', () => {
  const { editor, state } = open(TABLE);
  const t = editor.document.find(b => b.type === 'table');
  const rows = structuredClone(t.content.rows);
  rows[2].cells[1].content = [{ type: 'text', text: '4', styles: {} }];
  editor.updateBlock(t.id, { content: { ...t.content, rows } });
  const out = save(state, editor);
  assert.ok(out.startsWith('Intro line.\n\n'), out);
  assert.ok(out.endsWith('\n\nAfter.\n'), out);
  // Only the changed row's line differs; the others and the alignment row keep their bytes.
  assert.equal(out, TABLE.replace('| Bowl | 1 | 30.00 |', '| Bowl | 4 | 30.00 |'));
});

test('a row added to a table adds one line', () => {
  const { editor, state } = open(TABLE);
  const t = editor.document.find(b => b.type === 'table');
  const rows = structuredClone(t.content.rows);
  rows.push({ cells: ['Plate', '3', '9.00'].map(text => ({ type: 'tableCell', content: [{ type: 'text', text, styles: {} }], props: { textAlignment: 'left' } })) });
  editor.updateBlock(t.id, { content: { ...t.content, rows } });
  assert.equal(save(state, editor), TABLE.replace('| Bowl | 1 | 30.00 |\n', '| Bowl | 1 | 30.00 |\n| Plate | 3 | 9.00 |\n'));
});

test('a column added to a table writes a whole, valid table', () => {
  const { editor, state } = open(TABLE);
  const t = editor.document.find(b => b.type === 'table');
  const rows = structuredClone(t.content.rows);
  rows.forEach((r, i) => r.cells.push({ type: 'tableCell', content: i === 0 ? [{ type: 'text', text: 'Note', styles: {} }] : [], props: { textAlignment: 'left' } }));
  editor.updateBlock(t.id, { content: { ...t.content, columnWidths: [...t.content.columnWidths, undefined], rows } });
  const out = save(state, editor);
  const table = parser.parse(out).children.find(n => n.type === 'table');
  assert.ok(table, `still a table:\n${out}`);
  assert.deepEqual(table.children.map(r => r.children.length), [4, 4, 4]);
  assert.deepEqual(table.align, ['left', 'center', 'right', null]);
  assert.match(out, /^Intro line\.\n\n/);
  assert.match(out, /\n\nAfter\.\n$/);
});

test('a new table made in the editor is saved as a markdown table', () => {
  const { editor, state } = open('Text.\n');
  editor.insertBlocks([{ type: 'table', content: { type: 'tableContent', rows: [{ cells: ['A', 'B'] }, { cells: ['1', '2'] }] } }], editor.document[0].id, 'after');
  const out = save(state, editor);
  assert.match(out, /^Text\.\n\n\| A \| B \|\n\| - \| - \|\n\| 1 \| 2 \|\n$/);
});

const LIST = '# Plan\n\n- one\n- two\n  - two a\n- three\n\n1. first\n2. second\n3. third\n\n- [ ] open\n- [x] done\n';

test('a space typed at the edge of italic text is written outside the mark', () => {
  const { editor, state } = open('- Glaze test for the *sea-glass* finish\n');
  const b = editor.document[0];
  editor.updateBlock(b.id, { content: [
    { type: 'text', text: 'Glaze test for the ', styles: {} },
    { type: 'text', text: ' U14sea-glass ', styles: { italic: true } },
    { type: 'text', text: 'finish', styles: {} },
  ] });
  const out = save(state, editor);
  assert.doesNotMatch(out, /&#x20;/);
  assert.equal(out, '- Glaze test for the  *U14sea-glass* finish\n');
});

test('editing one list item changes one line', () => {
  const { editor, state } = open(LIST);
  const two = editor.document.find(b => b.type === 'bulletListItem' && b.content[0]?.text === 'two');
  editor.updateBlock(two.id, { content: 'two changed' });
  assert.equal(save(state, editor), LIST.replace('- two\n', '- two changed\n'));
});

test('a new item in a numbered list gets the next number and the list stays tight', () => {
  const { editor, state } = open(LIST);
  const second = editor.document.find(b => b.type === 'numberedListItem' && b.content[0]?.text === 'second');
  editor.insertBlocks([{ type: 'numberedListItem', content: 'between' }], second.id, 'after');
  assert.equal(save(state, editor), LIST.replace('2. second\n', '2. second\n3. between\n'));
});

test('ticking a check item changes one line', () => {
  const { editor, state } = open(LIST);
  const open1 = editor.document.find(b => b.type === 'checkListItem' && !b.props.checked);
  editor.updateBlock(open1.id, { props: { checked: true } });
  assert.equal(save(state, editor), LIST.replace('- [ ] open', '- [x] open'));
});

test('HTML and footnotes survive as raw blocks, byte for byte, around an edit', () => {
  const md = 'Top.\n\n<details>\n<summary>More</summary>\n\nHidden **text**.\n</details>\n\nSee note[^1].\n\n[^1]: The note.\n';
  const { editor, state } = open(md);
  assert.ok(editor.document.some(b => b.type === 'rawMarkdown'));
  editor.updateBlock(editor.document[0].id, { content: 'Top changed.' });
  assert.equal(save(state, editor), md.replace('Top.', 'Top changed.'));
});

test('a merge applies their edit while mine stays (different blocks)', () => {
  const base = '# Title\n\nAlpha.\n\nBeta.\n\nGamma.\n';
  const { editor, state } = open(base);
  const alpha = editor.document.find(b => b.content?.[0]?.text === 'Alpha.');
  editor.updateBlock(alpha.id, { content: 'Alpha, mine.' });
  const theirs = base.replace('Gamma.', 'Gamma, theirs.');
  const m = merge(state, editor.document, theirs);
  assert.equal(m.conflicts.length, 0);
  applyOps(editor, m.ops);
  snapshot(m.state, editor.document);
  assert.equal(save(m.state, editor), '# Title\n\nAlpha, mine.\n\nBeta.\n\nGamma, theirs.\n');
  // Their untouched blocks are untouched for the next save too.
  assert.ok(editor.document.find(b => b.content?.[0]?.text === 'Alpha, mine.').id === alpha.id);
});

test('a clean editor takes their insertions and deletions without touching other blocks', () => {
  const base = 'One.\n\nTwo.\n\nThree.\n';
  const { editor, state } = open(base);
  const keepIds = editor.document.filter(b => b.content?.[0]?.text !== 'Two.').map(b => b.id);
  const theirs = 'Zero.\n\nOne.\n\nThree.\n\nFour.\n';
  const m = merge(state, editor.document, theirs);
  applyOps(editor, m.ops);
  snapshot(m.state, editor.document);
  assert.equal(save(m.state, editor), theirs);
  for (const id of keepIds) assert.ok(editor.document.some(b => b.id === id), 'kept block keeps its id');
});

test('both sides changing the same block keeps mine and reports theirs', () => {
  const base = 'One.\n\nTwo.\n';
  const { editor, state } = open(base);
  const two = editor.document.find(b => b.content?.[0]?.text === 'Two.');
  editor.updateBlock(two.id, { content: 'Two, mine.' });
  const m = merge(state, editor.document, 'One.\n\nTwo, theirs.\n');
  assert.equal(m.conflicts.length, 1);
  assert.equal(m.conflicts[0].theirs, 'Two, theirs.');
  applyOps(editor, m.ops);
  snapshot(m.state, editor.document);
  assert.equal(save(m.state, editor), 'One.\n\nTwo, mine.\n');
});

test('after a save the saved text is the base: a later merge is exact', () => {
  const { editor, state } = open('A.\n\nB.\n');
  editor.updateBlock(editor.document[0].id, { content: 'A2.' });
  const { body, layout } = serialize(state, editor.document);
  const s2 = afterSave(state, body, layout);
  assert.equal(save(s2, editor), 'A2.\n\nB.\n');
  const m = merge(s2, editor.document, 'A2.\n\nB.\n\nC.\n');
  assert.equal(m.conflicts.length, 0);
  applyOps(editor, m.ops);
  snapshot(m.state, editor.document);
  assert.equal(save(m.state, editor), 'A2.\n\nB.\n\nC.\n');
});

test('a block only they changed is updated in place and keeps its id', () => {
  const { editor, state } = open('One.\n\nTwo.\n\nThree.\n');
  const two = editor.document[1].id;
  const m = merge(state, editor.document, 'One.\n\nTwo, theirs.\n\nThree.\n');
  assert.deepEqual(m.ops.map(o => o.op), ['update']);
  applyOps(editor, m.ops);
  snapshot(m.state, editor.document);
  assert.equal(editor.document[1].id, two);
  assert.equal(save(m.state, editor), 'One.\n\nTwo, theirs.\n\nThree.\n');
  // …and a later edit of mine to it is still seen as an edit.
  editor.updateBlock(two, { content: 'Two, mine now.' });
  assert.equal(save(m.state, editor), 'One.\n\nTwo, mine now.\n\nThree.\n');
});

test('a merge into a table edits the table block in place when only they changed it', () => {
  const { editor, state } = open(TABLE);
  const tableId = editor.document.find(b => b.type === 'table').id;
  const theirs = TABLE.replace('| Bowl | 1 | 30.00 |', '| Bowl | 3 | 30.00 |');
  const m = merge(state, editor.document, theirs);
  applyOps(editor, m.ops);
  snapshot(m.state, editor.document);
  assert.equal(save(m.state, editor), theirs);
  assert.ok(editor.document.some(b => b.id === tableId), 'the table keeps its id');
});
