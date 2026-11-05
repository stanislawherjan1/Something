/**
 * OAuth scopes for a remote MCP whose writes are scopes of their own (a bank):
 * a read-only connection asks for the read scopes only, so the provider itself
 * refuses every write; read and write adds the write scopes; an entry without
 * `mcp.scopes` asks for nothing in particular, as before (the SDK decides).
 * Also: the catalog's Mercury entry is shaped that way and lists its write tools.
 * Run: node lib/integrations-scopes.test.mjs
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra !== undefined ? `\n        ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

const { scopeFor } = await import('./integrations/oauth.js');
const catalog = JSON.parse(readFileSync(new URL('../integrations.catalog.json', import.meta.url), 'utf8')).integrations;
const mercury = catalog.find(e => e.id === 'mercury');

ok('the catalog has Mercury as a remote MCP with its own scopes', mercury?.mcp?.type === 'http' && mercury.mcp.url === 'https://mcp.mercury.com/mcp' && Array.isArray(mercury.mcp.scopes?.write), mercury?.mcp);
ok('…reaching only its own host', JSON.stringify(mercury.mcp.allowedHosts) === '["mcp.mercury.com"]');
const read = scopeFor(mercury, 'read');
ok('read-only asks for reading and refresh, nothing that writes', read === 'read offline_access', read);
const write = scopeFor(mercury, 'write');
ok('read and write adds the payment, transfer, category, budget and receipt scopes', ['read', 'offline_access', 'transactions:request', 'transfers:request', 'categories:create', 'transactions:update', 'budgets:manage', 'receipts:manage'].every(s => write.split(' ').includes(s)), write);
ok('an entry without its own scopes asks for nothing in particular', scopeFor(catalog.find(e => e.id === 'notion'), 'write') === undefined && scopeFor(catalog.find(e => e.id === 'notion'), 'read') === undefined);
ok('Mercury lists every write tool for the read-only hook', ['requestSendMoney', 'requestTransferMoney', 'createReceiptUploadUrl', 'matchReceipt', 'updateTransaction'].every(t => mercury.writeTools.includes(t)), mercury.writeTools);

console.log(`integrations-scopes: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
