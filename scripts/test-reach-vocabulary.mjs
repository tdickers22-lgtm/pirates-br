#!/usr/bin/env node
// THE REACH SPEAKS FOR ITSELF — the display layer must never wear another
// game's proper nouns, and must never pay for it with a renamed wire id.
//
// Two halves:
//   NAMES: the display-name lookup answers with the Reach's own vocabulary,
//     while every id it is keyed by (sloop, eye_of_reach, banana, …) is
//     untouched — that is the whole point of a display layer.
//   NO BACKSLIDING: a lint over the rendered surfaces (index.html markup and
//     the STRING LITERALS of every client source) rejects the borrowed nouns.
//     Comments and identifiers are exempt: `getNearbyGoldHoarder` is an id, not
//     a thing a player ever reads.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as THREE from 'three';
import { InteractionPrompts } from '../src/client/systems/InteractionPrompts.ts';
import {
  BROKER_NAME,
  BROKER_NAME_PLURAL,
  FLEET_PENNANT,
  FLEET_PENNANT_ADJ,
  SHIP_CLASS_NAMES,
  WORLD_NAME,
  itemDisplayName,
  shipClassName,
  weaponDisplayName,
  weaponSlotName,
} from '../src/client/ui/DisplayNames.ts';
import { SHIP_STATS, WEAPONS } from '../src/shared/constants/index.ts';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';

const ROOT = new URL('..', import.meta.url).pathname;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

// ── The names themselves ───────────────────────────────────────────────────
console.log('\nDisplay names');

expect('the world has a name and it is the Shattered Reach',
  /Shattered Reach/.test(WORLD_NAME), WORLD_NAME);
expect('the pennant is named', /Black Fin/.test(FLEET_PENNANT), FLEET_PENNANT);
expect('the broker is the Tallyman', BROKER_NAME === 'Tallyman' && BROKER_NAME_PLURAL === 'Tallymen',
  `${BROKER_NAME} / ${BROKER_NAME_PLURAL}`);

expect('the long arm is the Wrecker\'s Glass', weaponDisplayName('eye_of_reach') === "Wrecker's Glass",
  weaponDisplayName('eye_of_reach'));
expect('the knockback pistol is the Squall', weaponDisplayName('flintknock') === 'Squall Pistol',
  weaponDisplayName('flintknock'));
expect('slot tiles drop the " Pistol" suffix', weaponSlotName('flintknock') === 'Squall',
  weaponSlotName('flintknock'));
expect('un-renamed weapons still come from WEAPONS',
  weaponDisplayName('cutlass') === WEAPONS.cutlass.name && weaponDisplayName('blunderbuss') === WEAPONS.blunderbuss.name,
  `${weaponDisplayName('cutlass')} / ${weaponDisplayName('blunderbuss')}`);
expect('an unknown weapon id degrades to a word, not a crash',
  weaponDisplayName('not_a_weapon') === 'attack');

// There used to be a SECOND name per weapon: an override table in the display
// layer shadowing WEAPONS[id].name, which left "Sniper Rifle" and "Flintknock
// Pistol" alive in the armoury one careless `WEAPONS[id].name` from the screen.
// One string per weapon, and the armoury owns it.
expect('the armoury holds the ONLY name each weapon has',
  Object.keys(WEAPONS).every((id) => weaponDisplayName(id) === WEAPONS[id].name),
  Object.keys(WEAPONS).filter((id) => weaponDisplayName(id) !== WEAPONS[id].name).join(','));

expect('the hull classes are the Reach\'s own',
  shipClassName('sloop') === 'Cutter'
  && shipClassName('brigantine') === 'Corsair'
  && shipClassName('galleon') === "Man-o'-War",
  Object.values(SHIP_CLASS_NAMES).join(' / '));
expect('every SHIP_STATS key has a display name',
  Object.keys(SHIP_STATS).every((t) => typeof SHIP_CLASS_NAMES[t] === 'string' && SHIP_CLASS_NAMES[t].length > 0),
  Object.keys(SHIP_STATS).join(','));
expect('a missing hull type degrades, not crashes', shipClassName(null) === 'Hull');

expect('the heal fruit is a Plantain', itemDisplayName('banana') === 'Plantain', itemDisplayName('banana'));
expect('un-renamed loot still prettifies its id', itemDisplayName('wood_plank') === 'Wood Plank',
  itemDisplayName('wood_plank'));

// ── The ids underneath are UNMOVED ─────────────────────────────────────────
console.log('\nWire ids are untouched (a rename that breaks a packet is not a rename)');

expect('SHIP_STATS is still keyed sloop/brigantine/galleon',
  ['sloop', 'brigantine', 'galleon'].every((k) => k in SHIP_STATS), Object.keys(SHIP_STATS).join(','));
expect('WEAPONS is still keyed eye_of_reach/flintknock',
  'eye_of_reach' in WEAPONS && 'flintknock' in WEAPONS, Object.keys(WEAPONS).join(','));

// ── The broker prompt, through the real arbiter ────────────────────────────
console.log('\nThe [X] prompt at the broker');

function resolveAtBroker(overrides = {}) {
  const npc = { id: 'npc-1', role: 'gold_hoarder', position: { x: 10, y: 0, z: 0 }, rotation: 0 };
  const island = { id: 'isl-1', name: 'Smuggler\'s Rest', npcs: [npc] };
  const player = {
    id: 'p1', shipId: null, onShipId: null, state: 'alive',
    // A pace and a half short of his table, eyes on him.
    position: { x: 10, y: 0, z: -1.6 }, rotation: { x: 0, y: 0 },
    atHelm: false, atCannon: false, atCrowNest: false, mastClimb: null,
    weapons: [], activeSlot: 0, equippedTool: null, pocketWood: 0, pocketOre: 0,
    nearChestId: null, nearBarrelId: null, nearShipId: null, carryingChestId: null,
    bucketFilled: false, gold: 0, armor: 0, treasureMapIslandId: null, hasShovel: false,
    ...overrides,
  };
  const view = {
    ui: { interactPrompt: { style: {}, textContent: '', addEventListener() {} } },
    state: { players: [player], ships: [], islands: [island], kegs: [] },
    barrelBrowse: null, tavernDoors: [], visibleInteractKind: null, lastInteractKind: null,
    mermaidAnchor: null, pendingInteractFromUi: false, pendingLaunchFromUi: false,
    createMermaidAnchor: () => null,
    findChestById: () => null,
    findHarvestTarget: () => null,
    findNearbyKeg: () => null,
    findRepairableHole: () => null,
    getBarrelWorldPoint: () => null,
    getChestWorldPoint: () => null,
    getInventoryQty: () => 0,
    getLocalPlayer: () => player,
    // Eyes on the npc: +Z, slightly up toward his head.
    getLookDirection: () => new THREE.Vector3(0, 0.35, 1).normalize(),
    getMermaidReturnShip: () => null,
    getNearbyGoldHoarder: () => ({ npc, island }),
    getNearbyUpgradeStation: () => null,
    getRepairPlankCount: () => 0,
    getHoleRepairWorldPoint: () => new THREE.Vector3(),
    getShipWorldPoint: () => new THREE.Vector3(),
    getTavernDoorWorldPoint: (door, out) => out,
    getTrackedShip: () => null,
    getUpgradePresentation: () => ({ name: '', short: '', icon: '', color: '', hex: 0, effect: '' }),
  };
  return new InteractionPrompts(view).getLookInteraction(player, null, null, null);
}

const askMap = resolveAtBroker();
expect('standing at the broker resolves his station',
  askMap?.kind === 'gold_hoarder', `got ${askMap?.kind ?? 'nothing'}`);
expect('the chart line names the Tallyman, not a Hoarder',
  !!askMap && /Tallyman/.test(askMap.label) && !/Hoarder/.test(askMap.label), askMap?.label ?? '');

const sellChest = resolveAtBroker({ carryingChestId: 'chest-1' });
expect('the payout line names the Tallyman too',
  !!sellChest && /Tallyman pays/.test(sellChest.label) && !/Hoarder/.test(sellChest.label),
  sellChest?.label ?? '');

// ── No backsliding ─────────────────────────────────────────────────────────
console.log('\nNo borrowed nouns survive on a rendered surface');

/** Nouns that belong to somebody else's game (or to a name we retired). */
const BANNED = [
  { re: /Gold Hoarder/, why: "Sea of Thieves' trading company" },
  { re: /\bHoarders?\b/, why: 'retired: the broker is the Tallyman' },
  { re: /Eye of Reach/, why: "Sea of Thieves' proper noun" },
  { re: /Flintknock/, why: "Sea of Thieves' proper noun" },
  { re: /Sniper Rifle/, why: 'retired: anachronistic placeholder' },
  { re: /\bBananas?\b|BANANA/, why: "Sea of Thieves' signature heal" },
  { re: /\b(Sloop|Brigantine|Galleon)\b/, why: "Sea of Thieves' exact class trio" },
  { re: /Battle Map/, why: 'retired: the chart is titled with the world' },
];

/** Strip // and /* *\/ comments so an id-explaining comment is not "rendered". */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/** Every string / template literal in a source file — the text a player can see. */
function stringLiterals(src) {
  const out = [];
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[0]);
  return out;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (full.endsWith('.ts')) acc.push(full);
  }
  return acc;
}

const offences = [];
// src/shared is walked with the client because the ARMOURY lives there: the
// weapon names in WEAPONS[] are what the wheel, the kill feed and the legend
// print, so a placeholder parked in a "balance constant" is a rendered string.
for (const file of [...walk(join(ROOT, 'src/client')), ...walk(join(ROOT, 'src/shared'))]) {
  const text = stringLiterals(stripComments(readFileSync(file, 'utf8'))).join('\n');
  for (const { re, why } of BANNED) {
    const hit = text.split('\n').find((line) => re.test(line));
    if (hit) offences.push(`${relative(ROOT, file)}: ${hit.trim().slice(0, 90)} — ${why}`);
  }
}
{
  const html = stripComments(readFileSync(join(ROOT, 'index.html'), 'utf8'));
  for (const { re, why } of BANNED) {
    const hit = html.split('\n').find((line) => re.test(line));
    if (hit) offences.push(`index.html: ${hit.trim().slice(0, 90)} — ${why}`);
  }
}
expect('no client/shared string literal or markup wears a borrowed noun',
  offences.length === 0, offences.join('\n     '));

// ── The cast the SERVER authors is a rendered surface too ───────────────────
// The source lint above walks src/client only, and the island cast is written
// in src/server/world/MapGenerator.ts. Every one of those names goes over the
// wire onto a nameplate, a cutscene card and a spoken line — and five of them
// were still called "Gold Hoarder <name>" after the rename wave, which is the
// one noun this suite exists to keep out. Scan the roster the generator
// actually PRODUCES, so no authoring path (fixed cast or island fallback) can
// smuggle one back in.
{
  const gen = new MapGenerator(20260727);
  const islands = gen.generateIslands();
  const rendered = [];
  for (const island of islands) {
    for (const npc of island.npcs ?? []) {
      rendered.push(
        { where: `${island.name} · npc name`, text: npc.name ?? '' },
        { where: `${island.name} · cutscene title`, text: npc.cutsceneTitle ?? '' },
        { where: `${island.name} · spoken line`, text: npc.line ?? '' },
      );
    }
  }
  const castOffences = [];
  for (const { where, text } of rendered) {
    for (const { re, why } of BANNED) {
      if (re.test(text)) castOffences.push(`${where}: "${text.slice(0, 70)}" — ${why}`);
    }
  }
  expect(`the generated cast (${rendered.length} rendered strings) wears no borrowed noun`,
    castOffences.length === 0, castOffences.slice(0, 6).join('\n     '));
  expect('the broker in the world is the one the display layer promises',
    islands.some((i) => (i.npcs ?? []).some((n) => n.role === 'gold_hoarder'
      && n.name?.includes(BROKER_NAME))),
    (islands.flatMap((i) => (i.npcs ?? []).filter((n) => n.role === 'gold_hoarder'))
      .map((n) => n.name).slice(0, 4).join(', ')));
  // The ROLE is a wire id and must survive the rename — that is the whole
  // point of a display layer.
  expect('…while his wire role id is still gold_hoarder',
    islands.some((i) => (i.npcs ?? []).some((n) => n.role === 'gold_hoarder')));

  // The pennant is the one proper noun the cast says OUT LOUD, and the server
  // used to spell it itself — a second copy of a name the display layer owns,
  // free to drift. The lines must still SAY it, and MapGenerator must not be
  // where it is written.
  const pennantLines = rendered.filter(({ text }) => text.includes(FLEET_PENNANT_ADJ));
  expect(`the cast still names the crew out loud (${pennantLines.length} lines)`,
    pennantLines.length >= 3, pennantLines.map((l) => l.where).join(', '));
  const genSrc = stripComments(readFileSync(join(ROOT, 'src/server/world/MapGenerator.ts'), 'utf8'));
  const hardcoded = stringLiterals(genSrc)
    .filter((lit) => lit.includes(FLEET_PENNANT_ADJ) && !lit.includes('${'));
  expect('…and the server never spells it itself',
    hardcoded.length === 0, hardcoded.join('\n     '));
  const brokerHardcoded = stringLiterals(genSrc)
    .filter((lit) => lit.includes(BROKER_NAME) && !lit.includes('${'));
  expect('…nor the broker\'s title',
    brokerHardcoded.length === 0, brokerHardcoded.join('\n     '));
}

// The lint has to be able to FAIL, or it is decoration.
expect('the lint would catch a regression',
  BANNED.some(({ re }) => re.test('sell it to a Gold Hoarder')));

console.log(failures === 0 ? '\nALL GOOD\n' : `\n${failures} FAILURE(S)\n`);
process.exit(failures === 0 ? 0 : 1);
