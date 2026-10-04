/**
 * Halftone banners — a vanilla port of the workspace's TileBanner.jsx, so the
 * landing page draws the very same pictures as AI Settings, Team and sign-in.
 *
 * Any element with `data-halftone` gets a canvas. Options as data attributes:
 *   data-abstract="wave|wave-fault|constellation|rings|ramp|clusters|network"
 *   data-image="/integrations/x.svg"  data-mode="alpha|dark|edges"
 *   data-seed="…"  data-soft  data-center  data-scale="1.3"
 * The random stream is seeded, so a banner looks the same on every render; a
 * resize reveals more of the drawing instead of stretching it.
 */

const STEP = 5;
const ICON_X = 0.7;
const ICON_Y = 0.56;

function rng(seed) {
  let h = 1779033703;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 3432918353), h = (h << 13) | (h >>> 19);
  return () => {
    h |= 0; h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const images = new Map();
function loadImage(src) {
  if (!images.has(src)) {
    images.set(src, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    }));
  }
  return images.get(src);
}

function shapeOf(img, size, mode) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, size, size);
  if (mode === 'dark') {
    const d = cx.getImageData(0, 0, size, size);
    const p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      const lum = (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) / 255;
      const v = Math.min(1, (p[i + 3] / 255) * (1 - lum) * 1.5);
      p[i] = p[i + 1] = p[i + 2] = 0; p[i + 3] = v * 255;
    }
    cx.putImageData(d, 0, 0);
  }
  return c;
}


async function render(box, canvas) {
  const w = box.clientWidth, h = box.clientHeight;
  if (!w || !h) return;
  const o = box.dataset;
  const abstract = o.abstract || '';
  const seed = o.seed || 'tile';
  const soft = 'soft' in o;
  const center = 'center' in o;
  const scale = parseFloat(o.scale || '1.3');
  // `plain` + `step`: a portrait as a fine halftone (BotPicture), dots only,
  // sampled per cell.
  const plain = 'plain' in o;
  const step = parseFloat(o.step || String(STEP));
  // `cutout`: only the picture's own dots, no field around it — a figure
  // floating on the page instead of a picture in a frame.
  const cutout = 'cutout' in o;
  const dpr = window.devicePixelRatio || 1;

  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  let mask = null;
  let net = null;
  const m = document.createElement('canvas');
  m.width = w; m.height = h;
  const mc = m.getContext('2d', { willReadFrequently: true });
  const blob = (x, y, r, a) => {
    const g = mc.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    mc.fillStyle = g; mc.beginPath(); mc.arc(x, y, r, 0, Math.PI * 2); mc.fill();
  };

  if (abstract === 'network') {
    const pr = rng(seed + ':net');
    const gap = 105;
    const cols = Math.ceil(w / gap) + 1;
    const nodes = [];
    for (let i = 0; i < cols; i++) {
      const per = 1 + (pr() < 0.35 ? 1 : 0);
      for (let j = 0; j < per; j++) nodes.push({ x: gap * (i + 0.15 + pr() * 0.7), y: h * (0.16 + pr() * 0.68), hub: pr() < 0.18 });
    }
    const links = new Set();
    nodes.forEach((a, i) => {
      const near = nodes.map((b, j) => [j, Math.hypot(a.x - b.x, a.y - b.y)]).filter(([j]) => j !== i).sort((p, q) => p[1] - q[1]);
      near.slice(0, a.hub ? 4 : 2).forEach(([j]) => links.add(i < j ? `${i}-${j}` : `${j}-${i}`));
    });
    net = { nodes, links: [...links].map((k) => k.split('-').map(Number)), accent: Math.floor(pr() * nodes.length) };
    for (const n of nodes) blob(n.x, n.y, h * (n.hub ? 0.42 : 0.2), n.hub ? 0.8 : 0.5);
    mask = mc.getImageData(0, 0, w, h).data;
  } else if (abstract) {
    const pr = rng(seed + ':shape');
    if (abstract === 'rings') {
      const u = Math.min(w, h);
      const cx = parseFloat(o.cx || '0') * w || Math.min(u * 2.6, w * 0.55), cy = h * 0.55;
      for (let r = u * 0.18; r < Math.max(w, h) + u * 3; r += u * 0.36) {
        mc.strokeStyle = `rgba(0,0,0,${Math.max(0.12, 0.85 - r / (u * 9))})`;
        mc.lineWidth = u * 0.09;
        mc.beginPath(); mc.arc(cx, cy, r, 0, Math.PI * 2); mc.stroke();
      }
      blob(cx, cy, u * 0.3, 0.9);
    } else if (abstract === 'ramp') {
      const g = mc.createLinearGradient(0, 0, 600, 0);
      g.addColorStop(0, 'rgba(0,0,0,0.85)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      mc.fillStyle = g; mc.fillRect(0, 0, w, h);
    } else if (abstract === 'wave' || abstract.startsWith('wave-')) {
      const BREAK = parseFloat(o.break || '200');
      const amp = parseFloat(o.amp || '0.28');
      for (let x = 0; x <= w; x += 6) {
        let y = h * (0.5 + amp * Math.sin(x / 1000 * Math.PI * 2.2 + pr() * 0.3));
        const past = x - BREAK;
        if (abstract === 'wave-fault' && past > 0) { if (past < 14) continue; y += h * 0.3; }
        blob(x, y, h * 0.32, 0.22);
      }
    } else {
      const gap = 1000 / (5 + Math.floor(pr() * 3));
      const n = Math.ceil(w / gap) + 1;
      const pts = Array.from({ length: n }, (_, i) => [gap * (i + 0.2 + pr() * 0.6), h * (0.2 + pr() * 0.6), h * (0.22 + pr() * 0.35)]);
      for (const [x, y, r] of pts) blob(x, y, r, 0.55 + pr() * 0.4);
      if (abstract === 'constellation') {
        mc.strokeStyle = 'rgba(0,0,0,0.75)'; mc.lineWidth = 3;
        mc.beginPath(); pts.forEach(([x, y], i) => (i ? mc.lineTo(x, y) : mc.moveTo(x, y))); mc.stroke();
      }
    }
    mask = mc.getImageData(0, 0, w, h).data;
  } else if (o.image) {
    const size = Math.round(Math.min(w, h) * scale);
    const loaded = await loadImage(o.image);
    const img = loaded && shapeOf(loaded, size, o.mode || 'alpha');
    if (img) {
      const x = w * (center ? 0.5 : ICON_X) - size / 2, y = h * (center ? 0.5 : ICON_Y) - size / 2;
      mc.filter = plain ? 'blur(0.6px)' : soft ? 'blur(12px)' : 'blur(7px)'; mc.globalAlpha = soft ? 0.7 : 0.6; mc.drawImage(img, x, y);
      if (soft) { mc.filter = 'blur(4px)'; mc.globalAlpha = 0.6; mc.drawImage(img, x, y); }
      mc.filter = 'none'; mc.globalAlpha = soft ? 0.7 : 1; mc.drawImage(img, x, y);
      mask = mc.getImageData(0, 0, w, h).data;
    }
  }

  // The landing is light only: dark ink on paper.
  const ink = '40,37,32';
  const k = step / STEP;
  const cellValue = (gx, gy) => {
    if (!mask) return 0;
    if (!plain) return mask[((gy | 0) * w + (gx | 0)) * 4 + 3] / 255;
    let mx = 0, sum = 0, cnt = 0;
    const x0 = Math.max(0, (gx - step / 2) | 0), x1 = Math.min(w - 1, (gx + step / 2) | 0);
    const y0 = Math.max(0, (gy - step / 2) | 0), y1 = Math.min(h - 1, (gy + step / 2) | 0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = mask[(y * w + x) * 4 + 3]; mx = Math.max(mx, v); sum += v; cnt++; }
    return (0.5 * mx + 0.5 * sum / cnt) / 255;
  };
  let peak = 1;
  if (plain && mask) {
    peak = 0;
    for (let gy = step / 2; gy < h; gy += step) for (let gx = step / 2; gx < w; gx += step) peak = Math.max(peak, cellValue(gx, gy));
    peak = peak || 1;
  }

  for (let gy = step / 2; gy < h; gy += step) {
    for (let gx = step / 2; gx < w; gx += step) {
      const rand = rng(`${seed}:${Math.round(gx / step)}:${Math.round(gy / step)}`);
      const a = Math.min(1, cellValue(gx, gy) / peak);
      const n = rand();
      if (a < 0.04 && n < 0.12) continue;
      if (cutout && a < 0.1) continue;
      if (soft && a >= 0.04 && n < 0.05 + 0.06 * a) continue;
      const patch = soft ? 0.72 + 0.28 * Math.sin(gx * 0.045 + gy * 0.07 + seed.length) * Math.cos(gx * 0.03 - gy * 0.05) : 1;
      const lit = a < 0.04 && n > 0.985;
      const r = k * (lit ? 1.15 : (0.5 + rand() * 0.25) + (plain ? 1.35 : 1.25) * a * (0.8 + rand() * 0.4));
      const alpha = lit ? 0.45 : 0.15 + rand() * 0.08 + (plain ? 0.5 : 0.42) * a;
      const tone = soft ? alpha * patch * (0.4 + rand() * 0.6) : alpha;
      ctx.fillStyle = `rgba(${ink},${Math.min(tone, 0.85).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // `furniture` on a portrait: the banners' drawing language around the face —
  // dashed axes, corner registration marks, and on some faces the one yellow
  // point, in a corner.
  if (plain && 'furniture' in o) {
    const hair = (op) => `rgba(${ink},${op})`;
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.47;
    const pr = rng(seed + ':furniture');
    ctx.lineWidth = 0.6;
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = hair(0.13);
    ctx.beginPath();
    ctx.moveTo(0, cy); ctx.lineTo(cx - R * 0.8, cy); ctx.moveTo(cx + R * 0.8, cy); ctx.lineTo(w, cy);
    ctx.moveTo(cx, 0); ctx.lineTo(cx, cy - R * 0.8); ctx.moveTo(cx, cy + R * 0.8); ctx.lineTo(cx, h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = hair(0.3);
    ctx.beginPath();
    for (const [x, y, sx, sy] of [[2, 2, 1, 1], [w - 2, 2, -1, 1], [2, h - 2, 1, -1], [w - 2, h - 2, -1, -1]]) {
      ctx.moveTo(x, y + sy * 7); ctx.lineTo(x, y); ctx.lineTo(x + sx * 7, y);
    }
    ctx.stroke();
    if (pr() < 0.45) {
      const [x, y] = [[2, 2], [w - 2, 2], [2, h - 2], [w - 2, h - 2]][Math.floor(pr() * 4)];
      ctx.fillStyle = '#f2c14e';
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
  }

  if (plain) return;
  // Drawing furniture — hairlines only, so the dots stay the subject.
  const hair = (op) => `rgba(${ink},${op})`;
  ctx.lineWidth = 0.5;
  const CELL = STEP * 8;
  ctx.strokeStyle = hair(0.07);
  ctx.beginPath();
  for (let x = CELL; x < w; x += CELL) { ctx.moveTo(x + 0.25, 0); ctx.lineTo(x + 0.25, h); }
  for (let y = CELL; y < h; y += CELL) { ctx.moveTo(0, y + 0.25); ctx.lineTo(w, y + 0.25); }
  ctx.stroke();
  ctx.strokeStyle = hair(0.28);
  ctx.beginPath();
  for (let x = CELL; x < w; x += CELL) for (let y = CELL; y < h; y += CELL) {
    ctx.moveTo(x - 3, y + 0.25); ctx.lineTo(x + 3.5, y + 0.25);
    ctx.moveTo(x + 0.25, y - 3); ctx.lineTo(x + 0.25, y + 3.5);
  }
  for (const [cx, cy, sx, sy] of [[6, 6, 1, 1], [w - 6, 6, -1, 1], [6, h - 6, 1, -1], [w - 6, h - 6, -1, -1]]) {
    ctx.moveTo(cx, cy + sy * 7); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * 7, cy);
  }
  ctx.stroke();

  if (mask && o.image) {
    const size = Math.round(Math.min(w, h) * scale);
    const ix = w * (center ? 0.5 : ICON_X), iy = h * (center ? 0.5 : ICON_Y);
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = hair(0.22);
    ctx.beginPath();
    ctx.moveTo(0, iy); ctx.lineTo(w, iy);
    ctx.moveTo(ix, 0); ctx.lineTo(ix, h);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(ix, iy, size * 0.36, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#f2c14e';
    ctx.fillRect(ix - 2, iy - 2, 4, 4);
  }
  if (net) {
    ctx.lineWidth = 0.75;
    net.links.forEach(([i, j], k) => {
      const a = net.nodes[i], b = net.nodes[j];
      ctx.setLineDash(k % 3 === 2 ? [2, 3] : []);
      ctx.strokeStyle = hair(k % 3 === 2 ? 0.3 : 0.4);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    });
    ctx.setLineDash([]);
    net.nodes.forEach((n, i) => {
      if (i === net.accent) { ctx.fillStyle = '#f2c14e'; ctx.fillRect(n.x - 2.5, n.y - 2.5, 5, 5); return; }
      ctx.fillStyle = hair(0.75);
      ctx.beginPath(); ctx.arc(n.x, n.y, n.hub ? 2.6 : 1.7, 0, Math.PI * 2); ctx.fill();
      if (n.hub) { ctx.strokeStyle = hair(0.35); ctx.beginPath(); ctx.arc(n.x, n.y, 7, 0, Math.PI * 2); ctx.stroke(); }
    });
  }
}

export function mountHalftones(root = document) {
  const boxes = [...root.querySelectorAll('[data-halftone]')];
  const redrawAll = () => boxes.forEach((b) => b._draw && b._draw());
  for (const box of boxes) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    box.prepend(canvas);
    let lastW = 0, lastH = 0;
    box._draw = () => render(box, canvas);
    new ResizeObserver(() => {
      if (box.clientWidth === lastW && box.clientHeight === lastH) return;
      lastW = box.clientWidth; lastH = box.clientHeight;
      box._draw();
    }).observe(box);
  }
  return redrawAll;
}
