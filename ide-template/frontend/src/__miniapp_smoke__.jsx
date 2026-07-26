// Temporary SSR smoke entry — built by the miniapp smoke test, never shipped.
import { renderToString } from 'react-dom/server';
import { Renderer } from '@openuidev/react-lang';
import { miniappLibrary, MiniAppDataContext } from '@/lib/miniapp/library.jsx';

// OpenUI Lang: statements, positional args (Zod key order), refs + hoisting.
const SPEC = `root = App([cities, stats, shipping])
cities = Tabs(["Krakow", "Warsaw"], [kra, waw])
kra = Text("Krakow forecast", false)
waw = Text("Warsaw forecast", false)
stats = Grid(2, [s1, s2])
s1 = Stat("Orders today", "17", "+4")
s2 = Stat("Revenue", "2 840", null, "vs 2 610 last week")
shipping = Card("To ship", [orders, chart])
orders = List("orders", "customer", "items", "status", "Nothing to ship")
chart = BarChart("revenue", "day", "total", 160)`;

const data = {
  orders: [
    { customer: 'Anna K.', items: '2× bralette', status: 'paid' },
    { customer: 'Marta W.', items: '1× set', status: 'pending' },
  ],
  revenue: [
    { day: 'Mon', total: 380 }, { day: 'Tue', total: 520 }, { day: 'Wed', total: 610 },
  ],
};

const html = renderToString(
  <MiniAppDataContext.Provider value={{ data, loading: false, errors: {} }}>
    <Renderer response={SPEC} library={miniappLibrary} isStreaming={false} />
  </MiniAppDataContext.Provider>
);

const checks = [
  ['Stat label rendered', html.includes('Orders today')],
  ['Stat value rendered', html.includes('17')],
  ['Delta rendered', html.includes('+4')],
  ['Card title rendered', html.includes('To ship')],
  ['List row rendered', html.includes('Anna K.')],
  ['Badge value rendered', html.includes('paid')],
  ['Tabs labels rendered', html.includes('Krakow') && html.includes('Warsaw')],
  ['Active tab content rendered', html.includes('Krakow forecast')],
  ['Inactive tab hidden', !html.includes('Warsaw forecast')],
];

let failed = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  if (!pass) failed++;
}
if (failed) {
  console.log('--- HTML (first 2000 chars) ---');
  console.log(html.slice(0, 2000));
  process.exit(1);
}
console.log('SMOKE OK — renderer parses OpenUI Lang and renders whitelisted components.');
