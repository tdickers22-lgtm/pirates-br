#!/usr/bin/env node
// test-character-variants (b3.2f, characters-02 / characters-03 / vm:characters:7): the PURE variant
// picker in src/client/rendering/factories/characterVariants.ts.
//
//   node --import tsx scripts/test-character-variants.mjs
//
// Rows:
//  1. 1,000 seeded crews (sizes 1-4, squads with one captain, bot crews with an archetype):
//     no two members of a crew share head + hat + coat (lookKey), and the key really is
//     head + hat + coat (two looks with the same key show the same head, hat and coat nodes).
//  2. Negative control: the same 1,000 crews picked WITHOUT the crew resolver collide
//     (so row 1 can fail).
//  3. Deterministic: same id -> same look; crew looks independent of member order.
//  4. Captain rule: every captain wears tricorn|bicorn + coat_frock; no non-captain wears coat_frock.
//  5. Every look wears shirt_linen (R2 F2); a hat always takes the hair_<style>_hat cut, no hat the full style.
//  6. Every node the picker emits exists as a mesh node in pirate_base_<body>.glb (assets-src out),
//     and every look has exactly one hair, one lower, one boots node.
//  7. Variety over 10,000 ids: >= 200 unique head+hat+coat+lower+boots combos; each body type,
//     skin tone and hat option >= 8 %.
//  8. Archetypes: the list equals BOT_PERSONALITIES (server), and every bot look stays inside its
//     archetype wardrobe (captain rule excepted).
//  9. Mixer LOD: full < 15 m, 15 Hz < 40 m, 5 Hz beyond, never Infinity.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  pickLook, pickCrewLooks, mixerIntervalFor, ARCHETYPE_WARDROBE, BODY_TYPES, SKIN_TONES, HATS,
} from '../src/client/rendering/factories/characterVariants.ts';
import { BOT_PERSONALITIES } from '../src/server/systems/bots/personalities.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
let failures = 0;
function check(name, ok, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

// seeded rng (mulberry32) so the 1,000 crews are the same every run
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(20260801);
const ARCH = Object.keys(ARCHETYPE_WARDROBE);
function uuid() {
  let s = '';
  for (let i = 0; i < 32; i++) s += '0123456789abcdef'[Math.floor(R() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const crews = [];
for (let c = 0; c < 1000; c++) {
  const size = 1 + Math.floor(R() * 4);
  const bot = R() < 0.5;
  const archetype = bot ? ARCH[Math.floor(R() * ARCH.length)] : null;
  const members = [];
  for (let i = 0; i < size; i++) {
    members.push({ id: bot ? `bot-${c}-${i}` : uuid(), role: size > 1 && i === 0 ? 'captain' : 'crew', archetype });
  }
  crews.push(members);
}

// 1 + 2
let dupCrews = 0;
let naiveDupCrews = 0;
let keyMismatch = 0;
const byKey = new Map();
const headHatCoat = (l) => l.nodes.filter((n) => /^(hair_|hat_|coat_|vest_)/.test(n)).concat(l.body, `tint${l.hairTint}`).sort().join(',');
for (const members of crews) {
  const looks = pickCrewLooks(members);
  const keys = new Set([...looks.values()].map((l) => l.key));
  if (keys.size !== members.length) dupCrews++;
  const naive = new Set(members.map((m) => pickLook(m.id, m.role, m.archetype, 0).key));
  if (naive.size !== members.length) naiveDupCrews++;
  for (const l of looks.values()) {
    const sig = headHatCoat(l);
    const prev = byKey.get(l.key);
    if (prev !== undefined && prev !== sig) keyMismatch++;
    byKey.set(l.key, sig);
  }
}
check('1,000 crews: no duplicate head+hat+coat within a crew', dupCrews === 0, `${dupCrews} crews collide`);
check('lookKey = head + hat + coat (same key -> same head/hat/coat nodes)', keyMismatch === 0, `${keyMismatch} mismatches`);
check('negative control: without the crew resolver the same crews DO collide', naiveDupCrews > 0, `${naiveDupCrews} crews collide naively`);
// stress: the narrowest wardrobes, 400 four-bot crews per archetype (squad of one captain + 3)
let stressDup = 0; let stressNaive = 0;
for (const arch of ARCH) {
  for (let c = 0; c < 400; c++) {
    const members = [0, 1, 2, 3].map((i) => ({ id: `s-${arch}-${c}-${i}`, role: i === 0 ? 'captain' : 'crew', archetype: arch }));
    const looks = pickCrewLooks(members);
    if (new Set([...looks.values()].map((l) => l.key)).size !== 4) stressDup++;
    if (new Set(members.map((m) => pickLook(m.id, m.role, m.archetype, 0).key)).size !== 4) stressNaive++;
  }
}
check('stress: 2,000 four-bot crews in the narrowest wardrobes, no duplicate', stressDup === 0, `${stressDup} collide, ${stressNaive} would naively`);

// 3
const a = pickLook('player-abc', 'crew');
const b = pickLook('player-abc', 'crew');
check('deterministic by playerId', JSON.stringify(a) === JSON.stringify(b));
let orderDependent = 0;
for (const members of crews.slice(0, 200)) {
  const f = pickCrewLooks(members);
  const r = pickCrewLooks([...members].reverse());
  for (const m of members) if (JSON.stringify(f.get(m.id)) !== JSON.stringify(r.get(m.id))) orderDependent++;
}
check('crew looks independent of member order', orderDependent === 0, `${orderDependent} differ`);

// 4 + 5 + 6
const glbNodes = {};
for (const body of BODY_TYPES) {
  const f = path.join(ROOT, 'assets-src', 'quaternius', 'out', `pirate_base_${body}.glb`);
  if (!existsSync(f)) { check(`body GLB present: ${body}`, false, f); continue; }
  const raw = readFileSync(f);
  const jl = raw.readUInt32LE(12);
  const G = JSON.parse(raw.subarray(20, 20 + jl).toString('utf8'));
  glbNodes[body] = new Set(G.nodes.filter((n) => n.mesh !== undefined).map((n) => n.name));
}
let capBad = 0; let frockCrew = 0; let noShirt = 0; let hatCutBad = 0; let missing = 0; let slotCount = 0;
const missingNames = new Set();
const allLooks = [];
for (const members of crews) {
  const looks = pickCrewLooks(members);
  for (const m of members) {
    const l = looks.get(m.id);
    allLooks.push([m, l]);
    if (m.role === 'captain' && !(['hat_tricorn', 'hat_bicorn'].includes(l.hat) && l.nodes.includes('coat_frock'))) capBad++;
    if (m.role !== 'captain' && l.nodes.includes('coat_frock')) frockCrew++;
    if (!l.nodes.includes('shirt_linen')) noShirt++;
    const hair = l.nodes.filter((n) => n.startsWith('hair_') && n !== 'hair_beard');
    if (hair.length !== 1 || (l.hat ? !hair[0].endsWith('_hat') : hair[0].endsWith('_hat'))) hatCutBad++;
    const n = (re) => l.nodes.filter((x) => re.test(x)).length;
    if (n(/^breeches_/) !== 1 || n(/^boots_/) !== 1 || n(/^hat_/) !== (l.hat ? 1 : 0)) slotCount++;
    for (const node of l.nodes) {
      if (glbNodes[l.body] && !glbNodes[l.body].has(node)) { missing++; missingNames.add(`${l.body}:${node}`); }
    }
  }
}
check('captain rule: captain = tricorn|bicorn + coat_frock', capBad === 0, `${capBad} bad`);
check('coat_frock is the captain\'s alone', frockCrew === 0, `${frockCrew} crew in a frock coat`);
check('every look wears shirt_linen (R2 F2)', noShirt === 0, `${noShirt} bare`);
check('hat -> hair_<style>_hat cut, no hat -> full style, exactly one hair', hatCutBad === 0, `${hatCutBad} bad`);
check('exactly one lower / boots / hat node per look', slotCount === 0, `${slotCount} bad`);
check('every emitted node exists in pirate_base_<body>.glb', missing === 0, [...missingNames].slice(0, 6).join(' '));

// 7
const combos = new Set();
const bodyN = {}; const skinN = {}; const hatN = {};
const N = 10000;
for (let i = 0; i < N; i++) {
  const l = pickLook(`p${i}-${uuid()}`, 'crew');
  combos.add(`${l.key}|${l.lower}|${l.boots}`);
  bodyN[l.body] = (bodyN[l.body] ?? 0) + 1;
  skinN[l.skinTone] = (skinN[l.skinTone] ?? 0) + 1;
  hatN[l.hat ?? 'bare'] = (hatN[l.hat ?? 'bare'] ?? 0) + 1;
}
check('>= 200 unique combos over 10,000 players', combos.size >= 200, `${combos.size}`);
const minShare = (o, keys) => Math.min(...keys.map((k) => (o[k] ?? 0) / N));
check('each body type >= 8 %', minShare(bodyN, BODY_TYPES) >= 0.08, JSON.stringify(bodyN));
check('each of 6 skin tones >= 8 %', minShare(skinN, SKIN_TONES.map((_, i) => String(i))) >= 0.08, JSON.stringify(skinN));
check('each hat option >= 8 %', minShare(hatN, HATS.map((h) => h ?? 'bare')) >= 0.08, JSON.stringify(hatN));

// 8
const serverNames = BOT_PERSONALITIES.map((p) => p.name).sort().join(',');
check('archetypes == BOT_PERSONALITIES', [...ARCH].sort().join(',') === serverNames, `${ARCH} vs ${serverNames}`);
let offWardrobe = 0;
for (const [m, l] of allLooks) {
  if (!m.archetype || m.role === 'captain') continue;
  const w = ARCHETYPE_WARDROBE[m.archetype];
  if (!w.hats.includes(l.hat) || !w.coats.includes(l.coat) || !w.lowers.includes(l.lower)
      || !w.boots.includes(l.boots) || !w.waists.includes(l.waist) || l.accessories.some((x) => !w.accessories.includes(x))) offWardrobe++;
}
check('bot looks stay inside their archetype wardrobe', offWardrobe === 0, `${offWardrobe} off`);

// 9
check('mixer LOD: full rate < 15 m', mixerIntervalFor(14.9 ** 2) === 0 && mixerIntervalFor(0) === 0);
check('mixer LOD: 15 Hz 15-40 m', mixerIntervalFor(15 ** 2) === 1 / 15 && mixerIntervalFor(39.9 ** 2) === 1 / 15);
check('mixer LOD: 5 Hz beyond 40 m, never frozen', mixerIntervalFor(40 ** 2) === 1 / 5 && mixerIntervalFor(1e8) === 1 / 5);

console.log(`\ntest-character-variants: ${checks - failures}/${checks}`);
process.exit(failures ? 1 : 0);
