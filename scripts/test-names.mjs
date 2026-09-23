#!/usr/bin/env node
// Pirate names (b1.2f, online-15): src/shared/names.ts, pure, no port, < 1 s.
//   1. 30 hostile names are rejected or cleaned (slurs with leet/spacing/
//      zero-width, RTL override, zalgo, 200 chars, emoji-only, blank fillers)
//   2. 30 normal names come back unchanged ('Anne Bonny', 'Cassandra',
//      'José', '海賊', Scunthorpe cases)
//   3. in-match dedupe gives ' (2)', ' (3)', case-insensitively
// Blocked words are built from rot13 so this file does not print slurs.
let failures = 0;
function expect(label, ok, detail = '') {
  if (ok) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

let mod = null;
try { mod = await import('../src/shared/names.ts'); } catch (e) { expect('src/shared/names.ts loads', false, e.message); }
const { checkName, dedupeName, cleanName, visibleLength, NAME_MAX } = mod ?? {};
if (!mod) { console.error('\n1 FAILURES'); process.exit(1); }

const r = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const N = r('avttre'), F = r('shpx'), FAG = r('snttbg'), C = r('phag'), S = r('fuvg'), K = r('xvxr'), D = r('qvpx');
const RLO = '\u202E', ZW = '\u200B', ZWJ = '\u200D', LRI = '\u2066', BOM = '\uFEFF';
const leet = (w) => w.replace(/i/g, '1').replace(/e/g, '3').replace(/a/g, '4').replace(/o/g, '0');
const spaced = (w) => w.split('').join(' ');

// Each hostile case: rejected, or accepted only as something visibly cleaner
// (no control/format char, <= 20 visible, not equal to the raw input).
const HOSTILE = [
  N, N.toUpperCase(), leet(N), spaced(N), N.split('').join(ZW), `xX${leet(N)}Xx`, `${N}s4life`,
  N.replace('i', 'iii'), F, `${F}face`, spaced(F), `Big ${D}`, spaced(D), FAG, leet(FAG), `${C}y`,
  `Sir ${S}`, K, `The ${K}`, N.split('').join('.'),
  // not slurs, but hostile shapes: cleaned or rejected
  `${RLO}evil`, `Anne${ZWJ}${ZW}Bonny${BOM}`, `${LRI}Mallory${LRI}`, 'x'.repeat(200), '🏴‍☠️🏴‍☠️🏴‍☠️',
  '!!!???...', 'A', 'Z̷̢̛̖͇̓̈́̋a̸̧̛̖̓l̵̨̛g̸o̵', '\u3164\u3164\u3164', ' \t\n ',
];
console.log(`1. ${HOSTILE.length} hostile names rejected or cleaned`);
const HIDDEN = /[\p{Cc}\p{Cf}]/u;
for (const raw of HOSTILE) {
  const res = checkName(raw);
  const label = JSON.stringify(raw).slice(0, 40);
  if (!res.ok) { expect(`rejected (${res.reason}): ${label}`, true); continue; }
  const cleaned = res.name !== raw && !HIDDEN.test(res.name) && visibleLength(res.name) <= NAME_MAX;
  expect(`cleaned: ${label} -> ${JSON.stringify(res.name)}`, cleaned, `accepted as ${JSON.stringify(res.name)}`);
}
expect('exactly 30 hostile cases', HOSTILE.length === 30, `${HOSTILE.length}`);
{
  const r1 = checkName(`${RLO}evil`);
  expect('RTL override stripped, not kept', r1.ok && r1.name === 'evil', JSON.stringify(r1));
  const r2 = checkName('x'.repeat(200));
  expect('200 chars -> 20 visible', r2.ok && visibleLength(r2.name) === 20, JSON.stringify(r2).slice(0, 80));
  const r3 = checkName(`Anne${ZWJ}${ZW}Bonny${BOM}`);
  expect('zero-width joiners and BOM stripped', r3.ok && r3.name === 'AnneBonny', JSON.stringify(r3));
  const slurs = HOSTILE.slice(0, 20).filter((h) => checkName(h).ok);
  expect('every one of the 20 abusive spellings is REJECTED (not merely cleaned)', slurs.length === 0,
    `accepted: ${slurs.map((s) => JSON.stringify(s)).join(', ')}`);
}

const NORMAL = [
  'Anne Bonny', 'Cassandra', 'Jose\u0301', 'Jos\u00e9', 'Long John', '\u6d77\u8cca', 'Blackbeard', 'Calico Jack', 'Mary Read',
  'Grace O\'Malley', 'Ching Shih', 'Zheng Yi Sao', 'Pirate4821', 'Scunthorpe', 'Bass Hitter',
  'Assassin', 'Dickens', 'Hitchcock', 'Niger Delta', 'Shiitake', 'Peacock', 'Cockpit Carl', 'Grape Ape',
  'Therapist', 'Classic Sam', 'Åsa Ødegård', 'Łukasz', 'Мария', 'قرصان', 'Ana-Lucía',
];
console.log(`\n2. ${NORMAL.length} normal names come back unchanged`);
for (const n of NORMAL) {
  const res = checkName(n);
  expect(`accepted unchanged: ${n}`, res.ok && res.name === n.normalize('NFC'), JSON.stringify(res));
}
expect('exactly 30 normal cases', NORMAL.length === 30, `${NORMAL.length}`);
{
  const decomposed = 'Jose\u0301';
  const res = checkName(decomposed);
  expect("'Jose' + combining acute -> NFC 'Jos\u00e9', 4 visible", res.ok && res.name === 'Jos\u00e9' && visibleLength(res.name) === 4,
    JSON.stringify(res));
  expect('cleanName of a non-string is empty', cleanName(7) === '' && checkName(undefined).ok === false);
}

console.log('\n3. in-match dedupe');
expect("free name kept", dedupeName('Pirate4821', ['Anne Bonny']) === 'Pirate4821');
expect("second copy gets ' (2)'", dedupeName('Pirate4821', ['pirate4821']) === 'Pirate4821 (2)');
expect("third copy gets ' (3)'", dedupeName('Pirate4821', ['Pirate4821', 'Pirate4821 (2)']) === 'Pirate4821 (3)');

console.log(failures === 0 ? '\nAll names assertions passed' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
