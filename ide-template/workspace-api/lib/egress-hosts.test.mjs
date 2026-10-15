/**
 * Only a host name reaches the egress allow-list: a value typed into an
 * integration's settings that is an IP, a wildcard, or carries whitespace is
 * skipped. Run: node lib/egress-hosts.test.mjs
 */
import { isHostName } from './integrations/egress.js';
let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}`); } };
for (const h of ['shop.example.com', 'api.x.ai', 'my-store.myshopify.com', 'a.b.c.d.example.co.uk']) ok(`${h} is a host name`, isHostName(h));
for (const h of ['10.0.0.1', '169.254.169.254', '*.example.com', 'example.com\n*.com', ' example.com', 'example.com ', 'localhost', 'example', '', 'exa mple.com', 'http://example.com', 'example.com/path']) ok(`${JSON.stringify(h)} is not`, !isHostName(h));
console.log(`egress-hosts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
