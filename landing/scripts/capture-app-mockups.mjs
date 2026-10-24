// Captures the web app's screens for the landing page's demo chat, from the
// real app: the demo build plays each conversation (?showcase=<id>, see
// ide-template/frontend/src/demo/showcase.js), and this saves the page it
// ends on as plain HTML with the app's own CSS. The landing page then shows
// these pages: the real components' markup, with no app code to load, nothing
// to click, and a few lines (play.js) that type the question and bring the
// reply in, step by step.
//
// Re-run when the app's look changes (puppeteer-core is not a landing
// dependency: `npm i --no-save puppeteer-core` first, or run it from a folder
// that has it, with OUT pointing at public/mockups/app):
//   cd ide-template/frontend && npm run dev:demo -- --port 5180
//   cd landing && CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/capture-app-mockups.mjs
// Output: public/mockups/app/<id>.html and app.css (commit them).

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const DEMO = process.env.DEMO_URL || 'http://127.0.0.1:5180/demo';
const OUT = process.env.OUT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/mockups/app');
const CONVERSATIONS = { founder: '/tasks', shop: '/', sales: '/files/Wholesale/cafe-demo-plan.md', marketing: '/', team: '/team' };
// A reply that writes a file opens it at the end: until then the middle shows what
// another conversation's page shows there (captured earlier in this loop).
const OPENS_AT_END = { marketing: 'shop' };
const mains = {};

const browser = await puppeteer.launch({ executablePath: process.env.CHROME, headless: 'new' });
await mkdir(OUT, { recursive: true });
let css = '';

for (const [id, route] of Object.entries(CONVERSATIONS)) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1300, height: 720, deviceScaleFactor: 2 });
  // The replay posts 'showcase:done' to its parent; at the top level that is the page itself.
  await page.evaluateOnNewDocument(() => {
    window.addEventListener('message', (e) => { if (e.data?.type === 'showcase:done') window.__done = true; });
    // Each tool line as the chat shows it while the tool runs (one at a time,
    // shimmering), recorded as it appears: the finished chat only keeps "Used N tools".
    // (Recorded on each change of what shimmers: the app reuses and replaces its
    // nodes. "Thinking" is left out: the landing shows no waiting.)
    window.__live = [];
    let last = '';
    new MutationObserver(() => {
      const t = document.querySelector('.shimmer-text');
      const text = t ? t.textContent.trim() : '';
      if (text === last) return;
      last = text;
      const line = t?.closest('.relative');
      if (line && !/^Thinking/.test(text)) window.__live.push(line.outerHTML);
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(`${DEMO}${route}?showcase=${id}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__done === true, { timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 1500));   // the file a reply opens, the last animation

  const { html, main, ask, styles } = await page.evaluate(async () => {
    // The live tool lines go in front of the "Used N tools" they fold into,
    // N lines each, so the replay can roll them in before it.
    const live = [...window.__live];
    for (const group of document.querySelectorAll('.chat-bubble .flex.flex-col > .relative')) {
      const count = Number((group.textContent.match(/Used (\d+) tool/) || [])[1] || 0);
      const box = document.createElement('div');
      box.setAttribute('data-live', '');
      box.innerHTML = live.splice(0, count).join('');
      group.before(box);
    }
    // Images go inside the page (the landing has none of the app's files): logos as
    // they are, photos at twice the size they are shown.
    for (const img of document.querySelectorAll('img')) {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) continue;
      const blob = await (await fetch(src)).blob();
      if (blob.type.includes('svg')) {
        img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(await blob.text())))}`;
        continue;
      }
      const w = Math.max(1, img.clientWidth * 2), h = Math.max(1, img.clientHeight * 2);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const bmp = await createImageBitmap(blob);
      // object-fit: cover, as the app shows them
      const s = Math.max(w / bmp.width, h / bmp.height);
      c.getContext('2d').drawImage(bmp, (w - bmp.width * s) / 2, (h - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
      img.src = c.toDataURL('image/webp', 0.8);
      img.removeAttribute('srcset');
    }
    // Pictures drawn on a canvas (the coworker's halftone face, banners) become images.
    for (const c of document.querySelectorAll('canvas')) {
      try {
        const img = document.createElement('img');
        img.src = c.toDataURL('image/webp', c.width > 600 ? 0.5 : 0.85);   // a banner's dot field survives a low quality
        img.alt = '';
        img.className = c.className;
        img.style.cssText = c.style.cssText;
        if (!img.style.width) img.style.width = `${c.clientWidth}px`;
        if (!img.style.height) img.style.height = `${c.clientHeight}px`;
        c.replaceWith(img);
      } catch { c.remove(); }
    }
    // The chat: the question and each piece of the reply, in the order they arrive.
    const list = document.querySelector('.mx-auto.flex.max-w-2xl.flex-col');
    let n = 0;
    const mark = (el) => el.setAttribute('data-step', String(n++));
    let ask = '';
    for (const msg of list ? [...list.children] : []) {
      const bubble = msg.querySelector('.chat-bubble');
      if (!bubble) continue;
      const isUser = !!msg.querySelector('.justify-end');
      if (isUser) { ask = bubble.textContent.trim(); mark(msg); continue; }
      const parts = bubble.querySelector('.flex.flex-col') || bubble;
      for (const part of [...parts.children]) {
        if (part.hasAttribute('data-live')) continue;
        // A tool line that had already rolled away is left over from the live turn.
        part.querySelectorAll('.pointer-events-none.absolute').forEach((x) => x.remove());
        if (part.classList.contains('relative')) { mark(part); continue; }
        const blocks = [...part.children];
        if (blocks.length) blocks.forEach(mark); else mark(part);
      }
    }
    for (const t of document.querySelectorAll('textarea')) { t.value = ''; t.textContent = ''; }
    document.querySelectorAll('script, iframe, noscript').forEach((x) => x.remove());
    const styles = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch { return ''; } }).join('\n');
    const root = document.getElementById('root');
    const main = document.querySelector('main');
    return { html: root ? root.outerHTML : document.body.innerHTML, main: main ? main.outerHTML : '', ask, styles };
  });
  if (styles.length > css.length) css = styles;
  mains[id] = main;
  // The middle as it was before the reply, swapped for the file when it is done.
  const before = OPENS_AT_END[id] && mains[OPENS_AT_END[id]];
  const page_ = before ? html.replace('<main', () => `${before.replace('<main', '<main data-before=""')}<main data-after=""`) : html;

  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Something</title>
<link rel="stylesheet" href="app.css">
<style>*{scrollbar-width:none!important;pointer-events:none!important;user-select:none!important}*::-webkit-scrollbar{display:none!important}[data-step].pending,[data-live]:not(.on),[data-live]>:not(.on),body:not(.before) main[data-before],body.before main[data-after]{display:none!important}</style>
</head>
<body data-ask="${ask.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
${page_}
<script src="play.js"></script>
</body>
</html>
`;
  await writeFile(path.join(OUT, `${id}.html`), doc);
  console.log(`${id}: ${Math.round(doc.length / 1024)} KB`);
  await page.close();
}

await writeFile(path.join(OUT, 'app.css'), css);
console.log(`app.css: ${Math.round(css.length / 1024)} KB`);
await browser.close();
