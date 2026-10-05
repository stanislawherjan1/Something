/**
 * Full-width banner at the top of an AI Settings tile: the setting's own icon,
 * zoomed past the banner's edges and drawn as a halftone on a regular dot
 * grid. The icon goes (sharp, plus a soft blur for falloff) into an offscreen
 * mask; every grid dot is then sized and shaded by the mask under it, with a
 * little seeded noise in size and tone, the odd dot dropped and the odd one
 * lit — technical, but not mechanical. Over it sits the language of a
 * technical drawing: a hairline grid with crosshairs, dashed axes and a
 * construction circle through the picture, registration marks in the
 * corners, and one small yellow point where the axes cross.
 *
 * The picture is either a lucide icon (`icon`) or an image (`image`) — the
 * bot's avatar, the Claude or Telegram mark — read either by its shape
 * (`mode="alpha"`), by how dark it is (`mode="dark"`) or by its edges
 * (`mode="edges"`, for logos on their own coloured square), so every banner is
 * the same monochrome halftone. The random stream is seeded per tile, so a
 * banner looks the same on every render.
 */
import { useEffect, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cn } from '@/lib/utils';
import { useTheme } from '@/context/ThemeContext';

const STEP = 5;          // grid pitch, px
const ICON_SCALE = 1.3;  // icon size as a multiple of the banner's height
const ICON_X = 0.7;      // icon centre, as a fraction of the banner's width…
const ICON_Y = 0.56;     // …and height — same spot on every tile, bleeding off the edges
const STROKE = 2;        // icon line weight on its 24-unit grid

// Small deterministic PRNG (mulberry32) seeded from a string.
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

// One download per picture for the whole page: the bot's face appears in the
// header, every chat message and the notifications, and each used to fetch it.
const images = new Map();
function loadImage(src) {
  if (!images.has(src)) {
    images.set(src, new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => { images.delete(src); resolve(null); };
      img.src = src;
    }));
  }
  return images.get(src);
}

// Finished drawings, by everything that shapes them: a second avatar of the
// same size (or the same banner after a view switch) paints at once instead of
// redoing the dot field pixel by pixel.
const frames = new Map();
const FRAME_LIMIT = 80;
const nameOf = (C) => (C ? C.displayName || C.name || 'icon' : '');

function iconSrc(Icon, size) {
  const svg = renderToStaticMarkup(<Icon width={size} height={size} color="#000" strokeWidth={STROKE} />);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// The picture as a canvas whose alpha is its intensity: its own alpha, or —
// for line art and marks on a background — how dark each pixel is.
function shapeOf(img, size, mode) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, size, size);
  if (mode === 'edges') {
    // Brand logos often sit on their own coloured square, which as a halftone
    // is just a heavy block. Use the edges instead: where colour or opacity
    // changes sharply, so the mark reads as a contour.
    const d = cx.getImageData(0, 0, size, size);
    const p = d.data;
    const lum = new Float32Array(size * size);
    for (let i = 0, k = 0; i < p.length; i += 4, k++) {
      const a = p[i + 3] / 255;
      lum[k] = a * (0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]) / 255 + (1 - a); // over white
    }
    const out = cx.createImageData(size, size);
    for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
      const k = y * size + x;
      const gx = lum[k + 1] - lum[k - 1], gy = lum[k + size] - lum[k - size];
      out.data[k * 4 + 3] = Math.min(255, Math.hypot(gx, gy) * 900);
    }
    cx.putImageData(out, 0, 0);
    // Thicken the contour a little so it catches the dot grid.
    const t = document.createElement('canvas');
    t.width = size; t.height = size;
    const tx = t.getContext('2d');
    tx.filter = 'blur(2.5px)';
    tx.drawImage(c, 0, 0); tx.drawImage(c, 0, 0); tx.drawImage(c, 0, 0);
    return t;
  }
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

// `scale` overrides the zoom for a picture that needs more of itself showing.
// `soft`: a looser halftone — the picture spreads into a wider halo of dots,
// many of them faint (for tiles that carry their own icon on top).
// `opacity`: the whole banner lighter.
// `lineArt`: thin-lined pictures (the bot's avatar) — sample each dot's whole
// cell so the lines are not lost between dots.
// `center`: the picture sits in the middle (avatars) instead of the banner's
// off-centre, edge-bleeding spot.
// `icons`: several pictures spread across a wide banner instead of one.
// `abstract`: no picture at all — seeded clusters of denser dots ('clusters'),
// clusters joined by faint links ('constellation'), a soft band ('wave'),
// rings from one point ('rings'), a fade from the left ('ramp'), an orbit, or
// the wave failing ('wave-broken', 'wave-blocked', 'wave-scatter', 'wave-fault').
// In use: 'constellation' + soft (Team), 'wave' + soft (sign-in), 'wave-fault'
// + soft (sign-in failed, access denied). Kept on purpose for later surfaces: 'ramp' + soft and 'rings' + soft.
export default function TileBanner({ icon: Icon, icons, abstract, image, mode = 'alpha', scale = ICON_SCALE, seed = 'tile', opacity = 1, center = false, step = STEP, plain = false, lineArt = false, soft = false, paper = false, className }) {
  const boxRef = useRef(null);
  const canvasRef = useRef(null);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const box = boxRef.current, canvas = canvasRef.current;
    if (!box || !canvas) return;
    let cancelled = false;
    let failed = false;

    const draw = async () => {
      const w = box.clientWidth, h = box.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      const key = JSON.stringify([nameOf(Icon), (icons || []).map(nameOf), abstract, image, mode, scale, seed, center, step, plain, lineArt, soft, paper, resolvedTheme, w, h, dpr]);
      const hit = frames.get(key);
      if (hit) {
        canvas.width = w * dpr; canvas.height = h * dpr;
        const c = canvas.getContext('2d');
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.clearRect(0, 0, canvas.width, canvas.height);
        c.drawImage(hit, 0, 0);
        return;
      }
      failed = false;
      await render(w, h, dpr);
      if (cancelled || failed || !canvas.width) return;
      const snap = document.createElement('canvas');
      snap.width = canvas.width; snap.height = canvas.height;
      snap.getContext('2d').drawImage(canvas, 0, 0);
      if (frames.size >= FRAME_LIMIT) frames.delete(frames.keys().next().value);
      frames.set(key, snap);
    };

    const render = async (w, h, dpr) => {
      canvas.width = w * dpr; canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Mask: the icon sharp, plus a blurred copy so dots swell gradually towards it.
      let mask = null;
      let net = null;   // network mode: nodes + links, drawn crisp over the dots
      if (abstract?.startsWith('network')) {
        // A network forming: jittered nodes, a few hubs, each linked to its nearest neighbours.
        const pr = rng(seed + ':net');
        const dense = abstract === 'network-dense';
        const gap = dense ? 70 : 105;   // px per column, so a wider banner shows more, not stretched
        const cols = Math.ceil(w / gap) + 1;
        const nodes = [];
        for (let i = 0; i < cols; i++) {
          const per = 1 + (pr() < (dense ? 0.6 : 0.35) ? 1 : 0);
          for (let j = 0; j < per; j++) {
            nodes.push({
              x: gap * (i + 0.15 + pr() * 0.7),
              y: h * (0.16 + pr() * 0.68),
              hub: pr() < 0.18,
            });
          }
        }
        const links = new Set();
        nodes.forEach((a, i) => {
          const near = nodes.map((b, j) => [j, Math.hypot(a.x - b.x, a.y - b.y)]).filter(([j]) => j !== i).sort((p, q) => p[1] - q[1]);
          near.slice(0, a.hub ? 4 : 2).forEach(([j]) => links.add(i < j ? `${i}-${j}` : `${j}-${i}`));
        });
        net = { nodes, links: [...links].map((k) => k.split('-').map(Number)), accent: Math.floor(pr() * nodes.length) };
        const m = document.createElement('canvas');
        m.width = w; m.height = h;
        const mc = m.getContext('2d', { willReadFrequently: true });
        for (const n of nodes) {
          const r = h * (n.hub ? 0.42 : 0.2);
          const g = mc.createRadialGradient(n.x, n.y, 0, n.x, n.y, r);
          g.addColorStop(0, `rgba(0,0,0,${n.hub ? 0.8 : 0.5})`); g.addColorStop(1, 'rgba(0,0,0,0)');
          mc.fillStyle = g; mc.beginPath(); mc.arc(n.x, n.y, r, 0, Math.PI * 2); mc.fill();
        }
        mask = mc.getImageData(0, 0, w, h).data;
      } else if (abstract) {
        // Abstract fields: a few seeded blobs of density, optionally linked.
        const pr = rng(seed + ':shape');
        const m = document.createElement('canvas');
        m.width = w; m.height = h;
        const mc = m.getContext('2d', { willReadFrequently: true });
        const blob = (x, y, r, a) => {
          const g = mc.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)');
          mc.fillStyle = g; mc.beginPath(); mc.arc(x, y, r, 0, Math.PI * 2); mc.fill();
        };
        if (abstract === 'rings') {
          // Rings spreading from one point, like a signal. Fixed pixels, so a
          // wider banner shows more of the rings instead of stretching them.
          // Scaled by the shorter side, so a tall side banner gets the same
          // rings as a wide one, centred inside it instead of far off its edge.
          const u = Math.min(w, h);
          const cx = Math.min(u * 2.6, w * 0.55), cy = h * 0.55;
          for (let r = u * 0.18; r < Math.max(w, h) + u * 3; r += u * 0.36) {
            mc.strokeStyle = `rgba(0,0,0,${Math.max(0.12, 0.85 - r / (u * 9))})`;
            mc.lineWidth = u * 0.09;
            mc.beginPath(); mc.arc(cx, cy, r, 0, Math.PI * 2); mc.stroke();
          }
          blob(cx, cy, u * 0.3, 0.9);
        } else if (abstract === 'ramp') {
          // Dense on the left, thinning out to nothing over ~600px.
          const g = mc.createLinearGradient(0, 0, 600, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.85)'); g.addColorStop(1, 'rgba(0,0,0,0)');
          mc.fillStyle = g; mc.fillRect(0, 0, w, h);
        } else if (abstract === 'orbit') {
          // A tilted ellipse with a few bodies on it.
          const cx = h * 2.4, cy = h * 0.5;
          mc.save(); mc.translate(cx, cy); mc.rotate(-0.18);
          mc.strokeStyle = 'rgba(0,0,0,0.7)'; mc.lineWidth = h * 0.08;
          mc.beginPath(); mc.ellipse(0, 0, h * 2.1, h * 0.42, 0, 0, Math.PI * 2); mc.stroke();
          mc.restore();
          blob(cx, cy, h * 0.34, 0.95);
          for (const t of [0.6, 2.4, 4.1]) {
            const x = cx + Math.cos(t) * h * 2.1 * Math.cos(-0.18) - Math.sin(t) * h * 0.42 * Math.sin(-0.18);
            const y = cy + Math.cos(t) * h * 2.1 * Math.sin(-0.18) + Math.sin(t) * h * 0.42 * Math.cos(-0.18);
            blob(x, y, h * 0.16, 0.95);
          }
        } else if (abstract === 'wave' || abstract.startsWith('wave-')) {
          // The sign-in wave; the 'wave-*' shapes are the same wave, failing:
          // broken off, stopped at a wall, dissolving, or knocked out of line.
          const jr = rng(seed + ':fail');
          const BREAK = 200;   // px — where it fails, inside the sign-in card
          for (let x = 0; x <= w; x += 6) {
            let y = h * (0.5 + 0.28 * Math.sin(x / 1000 * Math.PI * 2.2 + pr() * 0.3));
            let a = 0.22, r = h * 0.32;
            const past = x - BREAK;
            if (abstract === 'wave-broken' && past > -30 && past < 40) continue;
            if (abstract === 'wave-blocked' && past > 0) continue;
            if (abstract === 'wave-scatter' && past > 0) {
              const k = Math.min(1, past / 160);
              y += (jr() - 0.5) * h * 1.1 * k;
              a *= 1 - 0.75 * k; r *= 1 - 0.55 * k;
            }
            if (abstract === 'wave-fault' && past > 0) { if (past < 14) continue; y += h * 0.3; }
            blob(x, y, r, a);
          }
          if (abstract === 'wave-blocked') {
            // The wall it ran into: a dense upright bar.
            for (let y = 0; y <= h; y += 4) blob(BREAK + 10, y, h * 0.12, 0.5);
          }
        } else {
          // Laid out in fixed pixels (one cluster per `gap`), so resizing the
          // banner reveals more of the same drawing instead of stretching it.
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
      } else if (icons?.length) {
        // A row of pictures across the banner, alternating a little up and down.
        const size = Math.round(h * scale);
        const m = document.createElement('canvas');
        m.width = w; m.height = h;
        const mc = m.getContext('2d', { willReadFrequently: true });
        const n = icons.length;
        for (let i = 0; i < n; i++) {
          // Scattered, not a row: sizes and heights vary, neighbours overlap.
          const sz = Math.round(size * [1, 0.7, 1.25, 0.8, 1.05, 0.75][i % 6]);
          const loaded = await loadImage(iconSrc(icons[i], sz));
          if (cancelled) return;
          const img = loaded && shapeOf(loaded, sz, 'alpha');
          if (!img) continue;
          const x = (w * (i + 0.55)) / (n + 0.1) - sz / 2, y = h * [0.55, 0.3, 0.7, 0.35, 0.6, 0.45][i % 6] - sz / 2;
          mc.filter = soft ? 'blur(22px)' : 'blur(7px)'; mc.globalAlpha = soft ? 1 : 0.6; mc.drawImage(img, x, y);
          if (soft) { mc.filter = 'blur(9px)'; mc.globalAlpha = 0.65; mc.drawImage(img, x, y); }
          mc.filter = 'none'; mc.globalAlpha = soft ? 0.32 : 1; mc.drawImage(img, x, y);
        }
        mask = mc.getImageData(0, 0, w, h).data;
      } else if (Icon || image) {
        const size = Math.round(Math.min(w, h) * scale);
        const loaded = await loadImage(Icon ? iconSrc(Icon, size) : image);
        if (cancelled) return;
        if (!loaded) failed = true;   // drawn without it, but never cached that way
        const img = loaded && shapeOf(loaded, size, Icon ? 'alpha' : mode);
        if (img) {
          const m = document.createElement('canvas');
          m.width = w; m.height = h;
          const mc = m.getContext('2d', { willReadFrequently: true });
          const x = w * (center ? 0.5 : ICON_X) - size / 2, y = h * (center ? 0.5 : ICON_Y) - size / 2;
          // Soft: a halo around the picture, but its own lines stay readable —
          // at 26px every icon melted into the same round blot.
          mc.filter = plain ? 'blur(0.6px)' : soft ? 'blur(12px)' : 'blur(7px)'; mc.globalAlpha = soft ? 0.7 : 0.6; mc.drawImage(img, x, y);
          if (soft) { mc.filter = 'blur(4px)'; mc.globalAlpha = 0.6; mc.drawImage(img, x, y); }
          mc.filter = 'none';      mc.globalAlpha = soft ? 0.7 : 1; mc.drawImage(img, x, y);
          mask = mc.getImageData(0, 0, w, h).data;
        }
      }

      // `paper`: always ink on light paper, whatever the theme (the bot's
      // pictures): a portrait inverted to light-on-dark reads as a negative.
      const ink = resolvedTheme === 'dark' && !paper ? '240,238,232' : '40,37,32';
      // Dot size scales with the pitch, so a fine grid (small avatars) keeps the same look.
      const k = step / STEP;
      // Small pictures: each dot takes the strongest value in its whole cell
      // (a one-pixel sample misses thin lines between dots), and the result is
      // stretched so every picture's darkest cell is full strength — faint
      // line art reads as clearly as bold.
      const cellValue = (gx, gy) => {
        if (!mask) return 0;
        if (!plain && !lineArt) return mask[((gy | 0) * w + (gx | 0)) * 4 + 3] / 255;
        // Half the cell's strongest value, half its average: thin lines still
        // register, but a dot is not all-or-nothing.
        let m = 0, sum = 0, cnt = 0;
        const x0 = Math.max(0, (gx - step / 2) | 0), x1 = Math.min(w - 1, (gx + step / 2) | 0);
        const y0 = Math.max(0, (gy - step / 2) | 0), y1 = Math.min(h - 1, (gy + step / 2) | 0);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const v = mask[(y * w + x) * 4 + 3]; m = Math.max(m, v); sum += v; cnt++; }
        return (0.5 * m + 0.5 * sum / cnt) / 255;
      };
      let peak = 1;
      if ((plain || lineArt) && mask) {
        peak = 0;
        for (let gy = step / 2; gy < h; gy += step) for (let gx = step / 2; gx < w; gx += step) peak = Math.max(peak, cellValue(gx, gy));
        peak = peak || 1;
      }
      for (let gy = step / 2; gy < h; gy += step) {
        for (let gx = step / 2; gx < w; gx += step) {
          // Randomness per grid cell, not per draw order, so a resize keeps every dot in place.
          const rand = rng(`${seed}:${Math.round(gx / step)}:${Math.round(gy / step)}`);
          const a = Math.min(1, cellValue(gx, gy) / peak);
          const n = rand();
          if (a < 0.04 && n < 0.12) continue;                 // the odd dot missing
          // Soft: holes inside the figure too, and slow patches of tone across
          // it (a cheap smooth noise over the grid), so it reads as weather,
          // not as an outline.
          if (soft && a >= 0.04 && n < 0.05 + 0.06 * a) continue;
          const patch = soft ? 0.72 + 0.28 * Math.sin(gx * 0.045 + gy * 0.07 + seed.length) * Math.cos(gx * 0.03 - gy * 0.05) : 1;
          const lit = a < 0.04 && n > 0.985;                  // the odd one lit
          const r = k * (lit ? 1.15 : (0.5 + rand() * 0.25) + (plain ? 1.35 : 1.25) * a * (0.8 + rand() * 0.4));
          // Small pictures need more contrast: a fainter field, a darker figure.
          // Small pictures keep the banners' field and tone, a touch stronger.
          const alpha = lit ? 0.45 : 0.15 + rand() * 0.08 + (plain ? 0.5 : 0.42) * a;
          // Soft: every dot's tone wanders, so the figure dissolves at its edges.
          const tone = soft ? alpha * patch * (0.4 + rand() * 0.6) : alpha;
          ctx.fillStyle = `rgba(${ink},${Math.min(tone, 0.85).toFixed(3)})`;
          ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.fill();
        }
      }

      if (plain) return;   // small pictures (avatars): dots only, no drawing furniture
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
      // Registration marks in the corners.
      for (const [cx, cy, sx, sy] of [[6, 6, 1, 1], [w - 6, 6, -1, 1], [6, h - 6, 1, -1], [w - 6, h - 6, -1, -1]]) {
        ctx.moveTo(cx, cy + sy * 7); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * 7, cy);
      }
      ctx.stroke();
      if (mask && !icons?.length && !abstract) {
        const size = Math.round(Math.min(w, h) * scale);
        const ix = w * (center ? 0.5 : ICON_X), iy = h * (center ? 0.5 : ICON_Y);
        // Dashed axes and a construction circle through the picture's centre.
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = hair(0.22);
        ctx.beginPath();
        ctx.moveTo(0, iy); ctx.lineTo(w, iy);
        ctx.moveTo(ix, 0); ctx.lineTo(ix, h);
        ctx.stroke();
        ctx.beginPath(); ctx.arc(ix, iy, size * 0.36, 0, Math.PI * 2); ctx.stroke();
        ctx.setLineDash([]);
        // The one accent: a small yellow point where the axes cross.
        ctx.fillStyle = '#f2c14e';
        ctx.fillRect(ix - 2, iy - 2, 4, 4);
      }
      if (net) {
        // Links as hairlines (some dashed — still forming), nodes as small marks, one yellow.
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
          if (n.hub) {
            ctx.strokeStyle = hair(0.35);
            ctx.beginPath(); ctx.arc(n.x, n.y, 7, 0, Math.PI * 2); ctx.stroke();
          }
        });
      }
    };

    draw();
    const ro = new ResizeObserver(() => draw());
    ro.observe(box);
    return () => { cancelled = true; ro.disconnect(); };
  }, [Icon, icons, abstract, image, mode, scale, seed, center, step, plain, lineArt, soft, paper, resolvedTheme]);

  return (
    <div ref={boxRef} className={cn('relative h-24 w-full overflow-hidden bg-[#efede7]', !paper && 'dark:bg-[#24221f]', className)}>
      <canvas ref={canvasRef} className="absolute inset-0 size-full" style={opacity < 1 ? { opacity } : undefined} aria-hidden="true" />
    </div>
  );
}
