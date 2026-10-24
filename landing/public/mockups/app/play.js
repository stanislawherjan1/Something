// Plays a captured app screen (scripts/capture-app-mockups.mjs): the chat
// starts empty, and on the parent's 'showcase:play' the question is typed into
// the composer, sent, and the reply's pieces appear in the order they arrived.
// Nothing here loads data or listens to the visitor; it only shows and hides.
(() => {
  const steps = [...document.querySelectorAll('[data-step]')].sort((a, b) => a.dataset.step - b.dataset.step);
  const box = document.querySelector('textarea');
  const ask = document.body.dataset.ask || '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const scroller = steps[0] && (function up(el) { while (el && el !== document.body) { const o = getComputedStyle(el).overflowY; if (o === 'auto' || o === 'scroll') return el; el = el.parentElement; } return null; })(steps[0]);
  const settle = () => { if (scroller) scroller.scrollTop = scroller.scrollHeight; };
  // A reply that writes a file: the middle is empty until the file is written.
  const opens = !!document.querySelector('main[data-before]');
  const reset = () => { steps.forEach((s) => s.classList.add('pending')); document.querySelectorAll('[data-live]').forEach((x) => x.classList.remove('on')); document.body.classList.toggle('before', opens); if (box) box.value = ''; settle(); };
  let run = 0;

  async function play() {
    const me = ++run;
    const alive = () => me === run;
    reset();
    await sleep(400);
    if (box) {
      for (let k = 1; k <= ask.length && alive(); k++) { box.value = ask.slice(0, k); await sleep(ask[k - 1] === ' ' ? 45 : 26); }
      await sleep(350);
      box.value = '';
    }
    for (const [k, s] of steps.entries()) {
      if (!alive()) return;
      // Tools run one at a time, each line rolling in over the last, then fold
      // into "Used N tools"; text follows at reading pace.
      const live = s.previousElementSibling?.hasAttribute('data-live') ? s.previousElementSibling : null;
      if (live?.children.length) {
        await sleep(250);
        live.classList.add('on');
        for (const line of live.children) {
          if (!alive()) return;
          [...live.children].forEach((x) => x.classList.toggle('on', x === line));
          settle();
          await sleep(750);
        }
        live.classList.remove('on');
      } else {
        await sleep(k === 0 ? 0 : 260);
      }
      s.classList.remove('pending');
      settle();
    }
    if (!alive()) return;
    if (opens) { await sleep(500); if (!alive()) return; document.body.classList.remove('before'); parent.postMessage({ type: 'showcase:opened' }, '*'); }
    parent.postMessage({ type: 'showcase:done' }, '*');
  }

  // Shown finished until played, so a still frame is never an empty screen.
  settle();
  addEventListener('message', (e) => { if (e.data?.type === 'showcase:play') play(); if (e.data?.type === 'showcase:reset') reset(); });
  parent.postMessage({ type: 'showcase:ready' }, '*');
})();
