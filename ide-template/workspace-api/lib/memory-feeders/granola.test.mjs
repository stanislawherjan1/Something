/**
 * The Granola feeder's parsers, against the hosted server's shapes as seen on
 * 2026-10-05 (fictional content). Run: node lib/memory-feeders/granola.test.mjs
 */
import { parseMeetings, parseTranscript, parseDate, parseParticipants, parseParticipantsWithAddresses } from './granola.js';
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log(`  FAIL: ${n}${x !== undefined ? `\n        ${JSON.stringify(x).slice(0, 500)}` : ''}`); } };

ok('a date with a GMT offset', parseDate('Oct 5, 2026 5:00 PM GMT+7') === '2026-10-05T10:00:00.000Z', parseDate('Oct 5, 2026 5:00 PM GMT+7'));
ok('...a negative two-digit one', parseDate('Oct 5, 2026 9:15 AM GMT-10') === '2026-10-05T19:15:00.000Z', parseDate('Oct 5, 2026 9:15 AM GMT-10'));
ok('...and an ISO one', parseDate('2026-10-05T10:09:02.346Z') === '2026-10-05T10:09:02.346Z');
ok('nonsense is null', parseDate('whenever') === null);
ok('participants: names only, the creator mark and the company and address dropped', JSON.stringify(parseParticipants('Ola Nowak (note creator) from Quillwork &lt;ola@q.test&gt;, Marta Zielak &lt;marta@v.test&gt;, Kontakt &lt;kontakt@example.test&gt;')) === '["Ola Nowak","Marta Zielak","Kontakt"]', parseParticipants('Ola Nowak (note creator) from Quillwork &lt;ola@q.test&gt;, Marta Zielak &lt;marta@v.test&gt;'));
const list = parseMeetings('The content below is meeting notes...\n\n<meetings_data from="Oct 5, 2026" to="Oct 5, 2026" count="1">\n<meeting id="d5a2-1" title="Location analysis (Maps API) - kontakt@example.test" date="Oct 5, 2026 5:00 PM GMT+7" captured_by_me="true" listed_as_participant="true" is_workspace_visible="false" url="https://notes.example.test/d/d5a2-1">\n    <known_participants>\n    Ola Nowak (note creator) from Quillwork &lt;ola@q.test&gt;, Kontakt &lt;kontakt@example.test&gt;\n    </known_participants>\n  </meeting>\n</meetings_data>');
ok('the participants line keeps addresses, drops the creator mark and the company', JSON.stringify(parseParticipantsWithAddresses('Ola Nowak (note creator) from Quillwork &lt;ola@q.test&gt;, Kontakt &lt;kontakt@example.test&gt;')) === '["Ola Nowak <ola@q.test>","Kontakt <kontakt@example.test>"]' && list[0].participantsLine.join('|') === 'Ola Nowak <ola@q.test>|Kontakt <kontakt@example.test>', list[0]);
ok('a listed meeting: id, title, time, people, link', list.length === 1 && list[0].id === 'd5a2-1' && list[0].title === 'Location analysis (Maps API) - kontakt@example.test' && list[0].at === '2026-10-05T10:00:00.000Z' && list[0].participants.join() === 'Ola Nowak,Kontakt' && list[0].url === 'https://notes.example.test/d/d5a2-1', list);
const notes = parseMeetings('<meetings_data count="1">\n<meeting id="d5a2-1" title="T" date="Oct 5, 2026 5:00 PM GMT+7" url="u">\n  <known_participants>\n  Ola Nowak (note creator)\n  </known_participants>\n  \n  <summary>\n### Updates\n\n- Three months to turn the clinic around\n  - Two clinics, one with ~40-50% occupancy\n</summary>\n</meeting>\n</meetings_data>');
ok('the notes answer carries the summary as markdown, whole', notes[0].summary.startsWith('### Updates') && /Two clinics, one with ~40-50% occupancy/.test(notes[0].summary), notes[0]);
const t = parseTranscript('The content below is meeting notes...\n\n{\n  "id": "d5a2-1",\n  "title": "T",\n  "created_at": "2026-10-05T10:09:02.346Z",\n  "transcript": "Speaker A: Hello.\\nSpeaker B: Hi, ready?",\n  "recording_context": {"description": "..."}\n}');
ok('the transcript answer: the text and its time', t.transcript === 'Speaker A: Hello.\nSpeaker B: Hi, ready?' && t.at === '2026-10-05T10:09:02.346Z', t);
ok('no transcript: empty, not an error', parseTranscript('nothing here').transcript === '');
console.log(`granola-feeder: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
