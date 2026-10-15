// The demo's business and people. Everything here is invented: Saltmarsh
// Ceramics, its team, clients and suppliers don't exist. The six teammates
// are the people on the landing page (same names, same faces, same asks).

import mara from '../people/mara.jpg';
import leo from '../people/leo.jpg';
import tom from '../people/tom.jpg';
import ivy from '../people/ivy.jpg';
import jonas from '../people/jonas.jpg';
import lena from '../people/lena.jpg';

export const COMPANY = {
  name: 'Saltmarsh Ceramics',
  short: 'Saltmarsh',
  // One line, as the bot would say it.
  line: 'A small ceramics studio and online shop: handmade tableware sold on Shopify, to cafés wholesale and at two seasonal markets.',
  currency: '€',
};

export const BOT = { name: 'Aria' };

// slug → person. `role` is the workspace role; `job` is what they do.
export const PEOPLE = {
  nora:  { slug: 'nora',  name: 'Nora',  email: 'nora@saltmarsh.example',  role: 'admin',  job: 'Founder',             avatar: null,  telegramChatId: '700100001', language: 'English' },
  mara:  { slug: 'mara',  name: 'Mara',  email: 'mara@saltmarsh.example',  role: 'member', job: 'Marketing and the newsletter', avatar: mara,  telegramChatId: '700100002', language: 'English' },
  leo:   { slug: 'leo',   name: 'Leo',   email: 'leo@saltmarsh.example',   role: 'member', job: 'Ads and analytics',    avatar: leo,   telegramChatId: '700100003', language: 'English' },
  tom:   { slug: 'tom',   name: 'Tom',   email: 'tom@saltmarsh.example',   role: 'member', job: 'Wholesale accounts',   avatar: tom,   telegramChatId: '700100004', language: 'English' },
  ivy:   { slug: 'ivy',   name: 'Ivy',   email: 'ivy@saltmarsh.example',   role: 'member', job: 'Content and photos',   avatar: ivy,   telegramChatId: null,        language: 'English' },
  jonas: { slug: 'jonas', name: 'Jonas', email: 'jonas@saltmarsh.example', role: 'member', job: 'Finance and suppliers', avatar: jonas, telegramChatId: '700100006', language: 'English' },
  lena:  { slug: 'lena',  name: 'Lena',  email: 'lena@saltmarsh.example',  role: 'member', job: 'Studio and stock',     avatar: lena,  telegramChatId: '700100007', language: 'English' },
};

// The two people you can look through: the founder (admin) and Mara (member).
export const VIEWERS = { admin: 'nora', member: 'mara' };
