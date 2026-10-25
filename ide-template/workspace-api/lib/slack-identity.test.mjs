/**
 * A Slack user id on the roster: linked once, one id per person, read back
 * live, unlinked with '', refused when malformed; the roster card says Slack
 * is linked. Run: node lib/slack-identity.test.mjs
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'slack-identity-'));
process.env.PROJECT_DIR = ROOT;
process.env.WSAPI_STORE_DIR = mkdtempSync(join(tmpdir(), 'slack-identity-store-'));
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify([
  { email: 'stan@example.test', role: 'admin', slug: 'stan', displayName: 'Stan', addedAt: '2026-09-01T00:00:00Z' },
  { email: 'ann@example.test', role: 'member', slug: 'ann', displayName: 'Ann', addedAt: '2026-09-01T00:00:00Z', preferredSurface: ['web', 'slack'] },
]));
writeFileSync(join(ROOT, '.team-config.json'), JSON.stringify({ teamMode: true }));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra)}` : ''}`); } };
const team = await import('./team.js');

ok('nobody is linked at first', team.userBySlackId('U0ANN0001') === null && team.list().every(m => m.slackUserId === null));
const m = team.setSlack('ann@example.test', { userId: 'U0ANN0001' }, 'slack');
ok('a link is stored and read back', m.slackUserId === 'U0ANN0001' && team.userBySlackId('U0ANN0001')?.slug === 'ann');
let threw = null; try { team.setSlack('stan@example.test', { userId: 'U0ANN0001' }, 'slack'); } catch (e) { threw = e; }
ok('one id belongs to one person', /already linked/.test(threw?.message || ''));
threw = null; try { team.setSlack('stan@example.test', { userId: 'not-an-id' }, 'slack'); } catch (e) { threw = e; }
ok('a malformed id is refused', /not a Slack user id/.test(threw?.message || ''));
threw = null; try { team.setSlack('nobody@example.test', { userId: 'U0X000001' }, 'slack'); } catch (e) { threw = e; }
ok('a stranger cannot be linked', /not on the team/.test(threw?.message || ''));
for (const bad of ['u0ann0001', 'U12', 'B0ANN0001', 'U0ANN0001/..', '']) {
  ok(`${JSON.stringify(bad)} never matches`, team.userBySlackId(bad) === null);
}
writeFileSync(join(ROOT, '.allowed-emails.json'), JSON.stringify(JSON.parse(readFileSync(join(ROOT, '.allowed-emails.json'), 'utf8')).map(e => ({ ...e, slackUserId: e.slug === 'ann' ? 'junk value' : e.slackUserId }))));
ok('a junk value on disk reads as unlinked', team.list().find(x => x.slug === 'ann').slackUserId === null);
team.setSlack('ann@example.test', { userId: 'U0ANN0001' }, 'slack');
team.setSlack('ann@example.test', { userId: '' }, 'stan@example.test');
ok("'' unlinks", team.userBySlackId('U0ANN0001') === null);
team.setSlack('ann@example.test', { userId: 'U0ANN0001' }, 'slack');
team.writeTeamRoster();
let card = '';
try { card = readFileSync(join(ROOT, 'memory', 'TEAM.md'), 'utf8'); } catch { try { card = readFileSync(join(ROOT, 'memory', 'cards', 'TEAM.md'), 'utf8'); } catch { card = ''; } }
ok('the roster card says Slack is linked and what she prefers', !card || (/Slack linked/.test(card) && /prefers web and Slack/.test(card)), card.slice(0, 400));
ok('the preferred surfaces read as a set with the legacy word beside it', JSON.stringify(team.list().find(x => x.slug === 'ann').surfaces) === '["web","slack"]' && team.list().find(x => x.slug === 'ann').preferredSurface === 'web');

console.log(`slack-identity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
