/**
 * Which picture the bot wears: a stock one is told apart from an upload. A
 * preset is copied into the same file an upload goes to, so the screens could
 * not tell them apart and drew every preset as a plain photo.
 *
 * Run: node lib/branding-avatar.test.mjs   (wired into `npm test`)
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

process.env.PROJECT_DIR = mkdtempSync(join(tmpdir(), 'branding-avatar-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };

// A real, tiny PNG (1×1, one grey pixel): what an upload looks like.
const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0])),
  chunk('IDAT', deflateSync(Buffer.from([0, 128]))),
  chunk('IEND', Buffer.alloc(0)),
]);

const B = await import('./branding.js');
ok('no picture yet: no stock one either', B.resolve().botAvatarPreset === null);
B.applyPresetAvatar('7');
ok('a preset chosen is known as that preset', B.resolve().botAvatarPreset === 7, B.resolve());
await new Promise((r) => setTimeout(r, 15));   // a new mtime for the next file
B.saveAvatar(png);
ok('an uploaded picture is not a preset', B.resolve().botAvatarPreset === null, B.resolve());
await new Promise((r) => setTimeout(r, 15));
B.applyPresetAvatar('16');
ok('...and choosing a preset again is seen at once', B.resolve().botAvatarPreset === 16, B.resolve());

console.log(`branding-avatar: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
