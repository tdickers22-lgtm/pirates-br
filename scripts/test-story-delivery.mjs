#!/usr/bin/env node
// THE STORY HAS TO BE PLAYABLE.
//
// The Reach's fifteen authored scenes and its cast are only worth building if a
// pirate meets them without opening docs/ISLAND_STORY_BIBLE.md. This suite pins
// the delivery, not the prose:
//
//   · every roster island holds at least one story scene that SPEAKS (a
//     vignette beat wired in the client's discovery table),
//   · every story scene placed in the world has a beat — no mute props,
//   · every island has a speaker, no two speakers share a name,
//   · every speaker opens with island LORE (not a recycled tutorial card),
//     while the teaching lines survive as the role's later rotation,
//   · the world names itself on landfall, and the Black Fin thread is named
//     out loud somewhere a player will actually stand.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MapGenerator } from '../src/server/world/MapGenerator.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME_SRC = readFileSync(path.join(ROOT, 'src/client/core/Game.ts'), 'utf8');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

/** Slice a top-level `const NAME ... = {` … `};` block out of the client source. */
function sliceBlock(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return '';
  const end = source.indexOf('\n};', start);
  return end < 0 ? '' : source.slice(start, end);
}

// ── The client's vignette table ────────────────────────────────────────────
const vignetteBlock = sliceBlock(GAME_SRC, 'const STORY_VIGNETTES');
const vignettes = new Map();
for (const match of vignetteBlock.matchAll(
  /^\s{2}(\w+): \{\s*\n\s*title: ([`'"])((?:\\.|(?!\2).)*)\2,\s*\n\s*beat: ([`'"])((?:\\.|(?!\4).)*)\4,\s*\n\s*radius: ([\d.]+),/gm,
)) {
  vignettes.set(match[1], { title: match[3], beat: match[5], radius: Number(match[6]) });
}

console.log('Vignette table:');
expect('the client carries a story-vignette table', vignettes.size >= 15, `${vignettes.size} entries parsed`);
let beatsOk = true;
let beatDetail = '';
for (const [type, v] of vignettes) {
  if (v.title.length < 4 || v.beat.length < 20 || !/[.!?]$/.test(v.beat) || v.radius < 8) {
    beatsOk = false;
    beatDetail += `\n     ${type}: title="${v.title}" beat="${v.beat}" radius=${v.radius}`;
  }
}
expect('every beat is a titled, punctuated sentence with a walkable footprint', beatsOk, beatDetail);

// ── The world as generated ─────────────────────────────────────────────────
const islands = new MapGenerator(20260727).generateIslands();
expect('all 14 roster islands generated', islands.length === 14, `${islands.length}`);

// Story scenes = the hero props the bible authors. Anything in the world that
// the client can announce counts; anything the world places that the client
// CANNOT announce is a mute prop and fails below.
const STORY_SCENE_TYPES = new Set([
  'smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton', 'rum_still',
  'crow_roost', 'mermaid_shrine', 'castaway_camp', 'kraken_wreck', 'dig_site',
  'gallows', 'parley_table', 'mine_head', 'widow_memorial', 'gibbet_cage',
]);

console.log('\nScenes that speak:');
let muteDetail = '';
let everyIslandSpeaks = true;
let noMuteScenes = true;
for (const island of islands) {
  const scenes = (island.props ?? []).filter((p) => STORY_SCENE_TYPES.has(p.type));
  const speaking = scenes.filter((p) => vignettes.has(p.type));
  if (speaking.length === 0) {
    everyIslandSpeaks = false;
    muteDetail += `\n     ${island.name}: ${scenes.length} scene(s), none wired to a beat`;
  }
  for (const scene of scenes) {
    if (!vignettes.has(scene.type)) {
      noMuteScenes = false;
      muteDetail += `\n     ${island.name}: '${scene.type}' is placed but has no vignette beat`;
    }
  }
}
expect('every roster island holds a scene that announces itself', everyIslandSpeaks, muteDetail);
expect('no story scene is placed mute', noMuteScenes, muteDetail);

// ── The cast ───────────────────────────────────────────────────────────────
console.log('\nThe cast:');
const allNpcs = islands.flatMap((i) => (i.npcs ?? []).map((n) => ({ ...n, island: i.name })));
let everyIslandPeopled = true;
let peopleDetail = '';
for (const island of islands) {
  if ((island.npcs ?? []).length === 0) {
    everyIslandPeopled = false;
    peopleDetail += `\n     ${island.name} has nobody to talk to`;
  }
}
expect('every roster island has at least one speaker', everyIslandPeopled, peopleDetail);

const names = allNpcs.map((n) => n.name);
const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
expect('no two speakers in the Reach share a name', dupes.length === 0, dupes.join(', '));

const lines = allNpcs.map((n) => n.line);
const dupeLines = [...new Set(lines.filter((l, i) => lines.indexOf(l) !== i))];
expect('no two speakers recite the same line', dupeLines.length === 0, dupeLines.join('\n     '));

let loreOk = true;
let loreDetail = '';
for (const npc of allNpcs) {
  if (!npc.line || npc.line.length < 60 || !npc.cutsceneTitle || !npc.cue) {
    loreOk = false;
    loreDetail += `\n     ${npc.island} / ${npc.name}: line=${npc.line?.length ?? 0} chars, title="${npc.cutsceneTitle}", cue="${npc.cue}"`;
  }
}
expect('every speaker carries an authored lore line, a title and a cue', loreOk, loreDetail);

// The lore must be about the ISLAND, not a generic card: each island's speakers
// mention something of that island (its name, or a word from its scene beat).
const SCENE_KEYWORDS = {
  "Smuggler's Rest": ['tavern', 'grove', 'trees'],
  'Skull Cove': ['skull', 'totem', 'cove', 'warning'],
  'The Crooked Atoll': ['tower', 'reef', 'wreck', 'light', 'salvage'],
  'Dead Man Shoals': ['ribs', 'bone', 'leviathan', 'tide', 'whale'],
  'Rumrunner Key': ['rum', 'pot', 'mug', 'still'],
  "Crow's Perch": ['pyre', 'watch', 'crow', 'signal', 'feather'],
  "Mermaid's Folly": ['candle', 'shrine', 'sing', 'coin', 'offering'],
  'Castaway Reach': ['raft', 'marks', 'palm', 'beach', 'castaway'],
  'Kraken Tooth': ['harpoon', 'teeth', 'kraken', 'coil'],
  'Booty Bay': ['chart', 'pit', 'chest', 'dig', 'pennant'],
  'Gallows Sands': ['noose', 'cage', 'mound', 'gallows', 'tide'],
  'Parley Point': ['table', 'truce', 'flag', 'blade', 'parley'],
  'Old Maw Caldera': ['mine', 'obsidian', 'glass', 'shift', 'mountain', 'maw'],
  "Widow's Watch": ['lantern', 'cliff', 'lamp', 'light', 'widow'],
};
let keyedOk = true;
let keyedDetail = '';
for (const island of islands) {
  const keywords = SCENE_KEYWORDS[island.name] ?? [];
  for (const npc of island.npcs ?? []) {
    const text = npc.line.toLowerCase();
    if (!keywords.some((k) => text.includes(k))) {
      keyedOk = false;
      keyedDetail += `\n     ${island.name} / ${npc.name}: lore mentions nothing of this island`;
    }
  }
}
expect('every lore line is keyed to its own island', keyedOk, keyedDetail);

// ── Teaching survives ──────────────────────────────────────────────────────
console.log('\nTeaching, and the threads:');
const tipsBlock = sliceBlock(GAME_SRC, 'const NPC_ROLE_TIPS');
const ROLES = ['mysterious_stranger', 'shipwright', 'oracle', 'gold_hoarder', 'bartender'];
const missingRole = ROLES.filter((role) => !new RegExp(`\\n  ${role}: \\[`).test(tipsBlock));
expect('every NPC role keeps a tutorial rotation', missingRole.length === 0, missingRole.join(', '));
expect('the tips teach the four systems (storm, repair, chart, trade)',
  /storm|ring/i.test(tipsBlock) && /patch|plank/i.test(tipsBlock)
  && /chart|map/i.test(tipsBlock) && /chests|gold/i.test(tipsBlock));

// ── The world's own name, and the Black Fin ────────────────────────────────
expect('landfall names the world the player is sailing',
  /flashIslandBanner[\s\S]{0,400}\$\{WORLD_NAME\}/.test(GAME_SRC));

const blackFinLore = allNpcs.filter((n) => /black fin/i.test(n.line));
expect('the Black Fin are named out loud by the cast', blackFinLore.length >= 1,
  blackFinLore.map((n) => `${n.island}/${n.name}`).join(', '));
expect("the dig's pennant names them too",
  /pennant marks the dig/i.test(vignetteBlock) && /FLEET_PENNANT/.test(vignetteBlock));

// ── The widow's lantern is a landmark, not a smudge ────────────────────────
expect("the widow's lantern gets a long-range beacon build",
  /buildStoryBeacons[\s\S]{0,2200}widow_memorial/.test(GAME_SRC));
expect('the beacon holds its size as distance grows (steerable, not fading)',
  /updateStoryBeacons[\s\S]{0,1400}clamp\(dist \* [\d.]+/.test(GAME_SRC));

if (failures > 0) {
  console.error(`\n${failures} story-delivery assertion(s) failed.`);
  process.exit(1);
}
console.log('\nThe Reach tells its own story.');
