// The editor's view of one markdown file: which top-level block came from
// which bytes, how to write the document back, and how to fold a newer
// version from disk into what the person is editing.
//
//   load(body)                 → { state, blocks }   blocks to put in the editor
//   snapshot(state, document)  → state                remember how each block looks
//   serialize(state, document) → { body, layout }    untouched blocks keep their bytes
//   afterSave(state, body, layout) → state            the saved text is the new base
//   merge(state, document, theirs) → { state, ops, conflicts }
//
// A block is "untouched" when its JSON still equals the snapshot taken when
// it was loaded or last saved. Untouched blocks are written as their original
// slice with the original whitespace around them; only edited blocks are
// serialized (blocks.js). Merging is three-way at the level of these units:
// base = the text the editor was last in sync with, mine = the editor,
// theirs = disk. A unit only they changed is applied; a unit only I changed
// stays; a unit we both changed keeps mine and is reported as a conflict.

import { parseUnits, blockToMarkdown, isListBlock, RAW } from './blocks.js';

let seq = 0;
const newId = () => `md${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const stable = (block) => JSON.stringify(block);

function buildState(body, parsed, ids, snaps = {}) {
  const units = new Map();
  const order = [];
  let prev = null;
  parsed.units.forEach((u, i) => {
    const id = ids[i];
    const gapBefore = i === 0 ? '' : body.slice(parsed.units[i - 1].end, u.start);
    if (id) {
      units.set(id, { text: u.text, gapBefore, prev, list: u.list, tableAlign: u.tableAlign, snap: snaps[id] ?? null });
      order.push(id);
    }
    prev = id || `gone:${i}`;
  });
  return {
    source: body, lead: parsed.lead, trail: parsed.trail, style: parsed.style,
    units, order, lastId: prev,
  };
}

export function load(body) {
  const parsed = parseUnits(body);
  const ids = parsed.units.map(() => newId());
  const blocks = parsed.units.map((u, i) => ({ ...u.block, id: ids[i] }));
  return { state: buildState(body, parsed, ids), blocks };
}

// Record how each known block looks in the editor right now (BlockNote fills
// in defaults, so the snapshot is taken from the editor, not from our input).
export function snapshot(state, document, onlyMissing = true) {
  for (const b of document) {
    const u = state.units.get(b.id);
    if (u && (!onlyMissing || u.snap === null)) u.snap = stable(b);
  }
  return state;
}

const isUntouched = (state, block) => {
  const u = state.units.get(block.id);
  return !!u && u.snap !== null && u.snap === stable(block);
};

const listy = (state, block) => isListBlock(block) || (block.type === RAW && !!state.units.get(block.id)?.list);
const numbered = (state, block) => block.type === 'numberedListItem' || (block.type === RAW && !!state.units.get(block.id)?.list?.ordered);

function gapBetween(state, prev, cur, prevKept, curKept) {
  const u = state.units.get(cur.id);
  if (prevKept && curKept && u && u.prev === prev.id) return u.gapBefore;
  if (listy(state, prev) && listy(state, cur) && numbered(state, prev) === numbered(state, cur)) {
    const loose = state.units.get(prev.id)?.list?.spread || u?.list?.spread;
    return loose ? '\n\n' : '\n';
  }
  return '\n\n';
}

export function serialize(state, document) {
  let body = '';
  const layout = [];
  let prev = null, prevKept = false, prevNumber = 0;
  for (const block of document) {
    let number = 1;
    if (block.type === 'numberedListItem') {
      const start = Number(block.props?.start);
      number = start > 0 ? start : (prev?.type === 'numberedListItem' ? prevNumber + 1 : 1);
    }
    const kept = isUntouched(state, block);
    const unit = state.units.get(block.id);
    const text = kept ? unit.text : blockToMarkdown(block, { style: state.style, number, tableAlign: unit?.tableAlign, original: unit?.text ?? null });
    if (!text) continue;                        // an empty paragraph says nothing in markdown
    if (prev) body += gapBetween(state, prev, block, prevKept, kept);
    else if (kept && state.units.get(block.id).prev === null) body += state.lead;
    const start = body.length;
    body += text;
    layout.push({ id: block.id, start, end: body.length, snap: stable(block) });
    prev = block; prevKept = kept; prevNumber = number;
  }
  if (prev) body += prevKept && state.lastId === prev.id ? state.trail : (state.source.endsWith('\n') || !state.source ? '\n' : '');
  return { body, layout };
}

// After a successful save of `body` (made by serialize from `layout`), that
// text is what the editor is in sync with.
export function afterSave(state, body, layout) {
  const units = new Map();
  const order = [];
  layout.forEach((l, i) => {
    const old = state.units.get(l.id);
    units.set(l.id, {
      text: body.slice(l.start, l.end),
      gapBefore: i === 0 ? '' : body.slice(layout[i - 1].end, l.start),
      prev: i === 0 ? null : layout[i - 1].id,
      list: old?.list || null,
      tableAlign: old?.tableAlign || null,
      snap: l.snap,
    });
    order.push(l.id);
  });
  return {
    source: body,
    lead: layout.length ? body.slice(0, layout[0].start) : body,
    trail: layout.length ? body.slice(layout[layout.length - 1].end) : '',
    style: state.style,
    units, order, lastId: layout.length ? layout[layout.length - 1].id : null,
  };
}

// Longest common subsequence on unit texts → aligned pairs and hunks.
function align(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf), B = b.slice(pre, b.length - suf);
  const pairs = [];
  for (let i = 0; i < pre; i++) pairs.push([i, i]);
  if (A.length && B.length && A.length * B.length <= 4_000_000) {
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { pairs.push([pre + i, pre + j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; k < suf; k++) pairs.push([a.length - suf + k, b.length - suf + k]);
  return pairs;
}

// Fold `theirs` (the file's body on disk now) into the editor.
// Returns the operations to run on the editor (in order), the new state (its
// new units have snap === null until snapshot() runs after the operations),
// and the conflicts: parts both sides changed, where the editor keeps mine.
export function merge(state, document, theirs) {
  const parsed = parseUnits(theirs);
  const T = parsed.units;
  const baseIds = state.order;
  const pairs = align(baseIds.map(id => state.units.get(id).text), T.map(u => u.text));

  const present = new Map(document.map(b => [b.id, b]));
  const mine = (id) => !present.has(id) || !isUntouched(state, present.get(id));

  const ops = [];
  const conflicts = [];
  const updated = new Set();
  const tIds = new Array(T.length).fill(null);
  let anchor = null;                       // the last block placed, in their order
  let bi = 0, ti = 0;
  const flush = (bEnd, tEnd) => {
    const bHunk = baseIds.slice(bi, bEnd);
    const tHunk = T.slice(ti, tEnd).map((u, k) => ({ u, k: ti + k }));
    if (bHunk.length || tHunk.length) {
      if (bHunk.some(mine)) {
        // Both sides changed this stretch: mine stays, theirs is reported.
        conflicts.push({ theirs: tHunk.map(x => x.u.text).join('\n\n'), mineIds: bHunk.filter(id => present.has(id)) });
        const last = [...bHunk].reverse().find(id => present.has(id));
        if (last) anchor = last;
      } else if (bHunk.length === 1 && tHunk.length === 1 && present.has(bHunk[0]) && present.get(bHunk[0]).type === tHunk[0].u.block.type) {
        // One block changed into one block of the same kind: updated in place,
        // keeping its id, so a caret inside it stays in it.
        const id = bHunk[0];
        tIds[tHunk[0].k] = id;
        updated.add(id);
        ops.push({ op: 'update', id, block: tHunk[0].u.block });
        anchor = id;
      } else {
        const blocks = tHunk.map(({ u, k }) => { tIds[k] = newId(); return { ...u.block, id: tIds[k] }; });
        const gone = bHunk.filter(id => present.has(id));
        if (gone.length && blocks.length) ops.push({ op: 'replace', ids: gone, blocks });
        else if (gone.length) ops.push({ op: 'remove', ids: gone });
        else if (blocks.length) {
          if (anchor) ops.push({ op: 'insertAfter', ref: anchor, blocks });
          else if (document.length) ops.push({ op: 'insertBefore', ref: document[0].id, blocks });
          else ops.push({ op: 'replaceAll', blocks });
        }
        if (blocks.length) anchor = blocks[blocks.length - 1].id;
      }
    }
    bi = bEnd; ti = tEnd;
  };
  for (const [b, t] of pairs) {
    flush(b, t);
    const id = baseIds[b];
    tIds[t] = id;
    if (present.has(id)) anchor = id;
    bi = b + 1; ti = t + 1;
  }
  flush(baseIds.length, T.length);

  // Their text is the new base. Equal units keep their id and snapshot (an
  // edit of mine to one of them still shows as an edit); applied units are new
  // and get their snapshot after the operations run; a conflicted stretch of
  // theirs has no block, so the next save writes mine in its place.
  const snaps = {};
  tIds.forEach(id => { if (id && state.units.has(id) && !updated.has(id)) snaps[id] = state.units.get(id).snap; });
  const next = buildState(theirs, parsed, tIds, snaps);
  next.style = state.style;
  return { state: next, ops, conflicts };
}

// Run merge operations on a BlockNote editor (or anything with its block API).
export function applyOps(editor, ops) {
  for (const o of ops) {
    if (o.op === 'update') {
      const { type, props, content, children } = o.block;
      editor.updateBlock(o.id, { type, props: props || {}, content: content ?? [], children: children || [] });
    } else if (o.op === 'replace') editor.replaceBlocks(o.ids, o.blocks);
    else if (o.op === 'remove') editor.removeBlocks(o.ids);
    else if (o.op === 'insertAfter') editor.insertBlocks(o.blocks, o.ref, 'after');
    else if (o.op === 'insertBefore') editor.insertBlocks(o.blocks, o.ref, 'before');
    else if (o.op === 'replaceAll') editor.replaceBlocks(editor.document, o.blocks);
  }
}

// The ids an operation list adds, for the "changed" highlight.
export const changedIds = (ops) => ops.flatMap(o => (o.op === 'update' ? [o.id] : (o.blocks || []).map(b => b.id)));

// Take a fresh snapshot of just these blocks (after BlockNote settled them).
export function resnapshot(state, document, ids) {
  const want = new Set(ids);
  for (const b of document) if (want.has(b.id) && state.units.has(b.id)) state.units.get(b.id).snap = stable(b);
  return state;
}
