#!/usr/bin/env node
// ASSET FIDELITY TIERS — the acceptance bar for "way higher poly, done right" (b3.4a; assets-16,
// assets-09, vm:assets:6; PLAN section 3.12 + D27 + section 6).
//
// Before this file, fidelity was judged by eye in audits: test-hero-assets graded 13 hero files,
// test-asset-bounds / test-far-lod-integrity graded bounds and 16 far files, and nothing read the
// triangle band, the LOD chain, the texture set or the wire compression of the other ~90 GLBs. A
// rebuild could regress to primitives, or ship an unbudgeted LOD0, and every gate stayed green.
//
// THE TABLE. Every `<key>.glb` in public/assets/models (not `_far` / `_lods` siblings) belongs to
// EXACTLY ONE tier below. A tier carries the D27 / section 3.12 numbers for its family:
//   [band]        LOD0 triangles inside the tier's band (both ends: too coarse is a primitive tell,
//                 too fine outruns the perf budget; D6 says higher poly arrives through LODs).
//   [lods]        `<key>_lods.glb` exists and holds the LOD chain as nodes whose names end in
//                 LOD1 / LOD2 / far (b3.4d build_lods.py writes it; the old `<key>_far.glb` migrates
//                 into it), each level under its ratio (or absolute) ceiling and strictly coarser than
//                 the level above.
//   [textures]    every textured material carries the tier's maps: baseColor + normal + ORM
//                 (metallicRoughnessTexture, ORM packed) for hard surfaces, baseColor + normal for
//                 foliage cards. Emissive panes (emissive, no baseColor map, e.g. lantern glass) are
//                 exempt; a file with NO map at all fails.
//   [verts]       verts / tris <= 1.3 on non-foliage LOD0 (assets-09: split-vertex faceting costs 3x
//                 vertices; boulder_a 3.00, mine_head 2.79). Foliage cards are exempt.
//   [compression] the packed sibling named by src/client/assets/model-manifest.json exists, carries
//                 EXT_meshopt_compression, and every image in it is KTX2 (KHR_texture_basisu).
//
// THE RATCHET. HEAD at b3.4a fails far more rows than one slice can fix, so the known-failing rows
// are listed in RATCHET below. The rules, each of which FAILS the suite:
//   - a failing row that is NOT in the ratchet (a new regression, or a ratchet row someone removed
//     while it still fails);
//   - a ratchet row that now PASSES (stale: delete it, so the list only ever shrinks);
//   - a ratchet row that is not in the ratchet at the commit that created this file, or not in the
//     committed HEAD copy (the list may not grow; read from git);
//   - a GLB with no tier, a GLB in two tiers, or a tier key with no GLB on disk.
// Section 3.12's bar is "the test-asset-tiers ratchet ends empty".
//
// Mutation proof (rule 5): PIRATES_BR_MUTATE=tiers:<band|lods|textures|verts|compression|stale|grow|member|parts|sockets>
// breaks exactly one clause and the suite must go red; `--prove` runs all ten as child processes and
// fails unless every one of them exits non-zero.
//
//   node scripts/test-asset-tiers.mjs            grade
//   node scripts/test-asset-tiers.mjs --prove    grade + all mutation proofs (~1 s)
//   node scripts/test-asset-tiers.mjs --list <tier>   print the tier's keys (render_contact_sheet.py)
//   node scripts/test-asset-tiers.mjs --tiers          print tier -> keys as JSON
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'public/assets/models');
const MANIFEST = path.join(ROOT, 'src/client/assets/model-manifest.json');
const SELF_REL = 'scripts/test-asset-tiers.mjs';

// ── the family table (PLAN 3.12 LOD0 bands; section 6 LOD chains) ─────────────────────────────
// lods: per-level ceiling as a ratio of LOD0 (`r`) and/or an absolute triangle cap (`max`); `min`
// is an absolute floor (the story far proxy is 2-4k and eager). `need` lists the levels required.
const HARD = ['base', 'normal', 'orm'];
const CHAIN = (l1, l2, far) => ({ need: ['LOD1', 'LOD2', 'far'], LOD1: { r: l1 }, LOD2: { r: l2 }, far: { r: far } });
export const TIERS = {
  'fp-weapons': { family: 'weapons-tools', band: [18000, 30000], tex: HARD,
    lods: { need: ['LOD1', 'LOD2', 'far'], LOD1: { min: 5000, max: 8000 }, LOD2: { max: 1500 }, far: { r: 0.04 } },
    keys: ['cutlass', 'flintlock', 'flintknock', 'blunderbuss', 'eye_of_reach'] },
  'fp-tools': { family: 'weapons-tools', band: [3000, 10000], tex: HARD,
    lods: { need: ['LOD1', 'LOD2'], LOD1: { min: 1500, max: 3000 }, LOD2: { max: 500 } },
    keys: ['tool_bucket', 'tool_hammer', 'tool_planks'] },
  cannon: { family: 'ship-hardware-kit', band: [14000, 20000], tex: HARD, lods: CHAIN(0.40, 0.12, 0.04), keys: ['cannon'] },
  wheel: { family: 'ship-hardware-kit', band: [10000, 14000], tex: HARD, lods: CHAIN(0.40, 0.12, 0.04), keys: ['wheel'] },
  capstan: { family: 'ship-hardware-kit', band: [8000, 12000], tex: HARD, lods: CHAIN(0.40, 0.12, 0.04), keys: ['capstan'] },
  lantern: { family: 'ship-hardware-kit', band: [3000, 5000], tex: HARD, lods: CHAIN(0.40, 0.12, 0.04), keys: ['ship_lantern'] },
  // Props 2.5-8k, far <= 150 tris (section 6 row 14). rowboat is a ship-hardware-kit byte row but a
  // prop-sized mesh; it is graded here until the ship kit (b4.3) gives it its own band.
  props: { family: 'props-poi', band: [2500, 8000], tex: HARD,
    lods: { need: ['LOD1', 'LOD2', 'far'], LOD1: { r: 0.40 }, LOD2: { r: 0.12 }, far: { max: 150 } },
    keys: ['barrel', 'keg', 'chest_closed', 'chest_open', 'crate', 'campfire', 'bedroll', 'lantern_post', 'tent_a', 'tent_b',
      'tent_c', 'bone_pile', 'driftwood_log', 'grave_marker', 'signal_pyre', 'wall_torch', 'bone_pile_cave', 'skull_shrine',
      'cave_painting_panel', 'rope_bridge_short', 'rowboat'] },
  // Flora: cross-card far (2-4 cards; a double-sided card may be modelled as 4 tris, so <= 16).
  palms: { family: 'flora-canopy', band: [10000, 16000], tex: ['base', 'normal'], foliage: true,
    lods: { need: ['LOD1', 'LOD2', 'far'], LOD1: { r: 0.40 }, LOD2: { r: 0.12 }, far: { max: 16 } },
    keys: ['palm_a', 'palm_b', 'palm_c', 'palm_tall', 'palm_ground'] },
  bushes: { family: 'flora-canopy', band: [3000, 6000], tex: ['base', 'normal'], foliage: true,
    lods: { need: ['LOD1', 'LOD2', 'far'], LOD1: { r: 0.40 }, LOD2: { r: 0.12 }, far: { max: 16 } },
    keys: ['bush', 'bush_berry', 'fern_plant', 'flower_bush'] },
  flowers: { family: 'flora-canopy', band: [1500, 3000], tex: ['base', 'normal'], foliage: true,
    lods: { need: ['LOD1', 'LOD2', 'far'], LOD1: { r: 0.40 }, LOD2: { r: 0.12 }, far: { max: 16 } },
    keys: ['flower_patch', 'wildflowers'] },
  // Rocks: 35% / 10% / 3% (section 6 rows 12-13). crag is the single-mass cliff piece: cliff band.
  boulders: { family: 'rocks-cliffs', band: [8000, 15000], tex: HARD, lods: CHAIN(0.35, 0.10, 0.03), keys: ['boulder_a', 'boulder_b', 'boulder_c'] },
  searocks: { family: 'rocks-cliffs', band: [15000, 25000], tex: HARD, lods: CHAIN(0.35, 0.10, 0.03), keys: ['searock_a', 'searock_b', 'searock_c'] },
  arches: { family: 'rocks-cliffs', band: [20000, 30000], tex: HARD, lods: CHAIN(0.35, 0.10, 0.03), keys: ['rock_arch'] },
  cliff: { family: 'rocks-cliffs', band: [10000, 16000], tex: HARD, lods: CHAIN(0.35, 0.10, 0.03), keys: ['crag'] },
  'cave-clusters': { family: 'rocks-cliffs', band: [3000, 8000], tex: HARD, lods: CHAIN(0.35, 0.10, 0.03),
    keys: ['stalactite_cluster_a', 'stalactite_cluster_b', 'stalagmite_cluster_a', 'stalagmite_cluster_b', 'crystal_vein_a',
      'crystal_vein_b', 'cave_ledge', 'cave_pool_rim', 'rock_arch_cave'] },
  buildings: { family: 'buildings-story', band: [25000, 60000], tex: HARD, lods: CHAIN(0.40, 0.12, 0.03),
    keys: ['dock_mid', 'dock_end', 'watchtower', 'shipwreck', 'standing_stones', 'fort', 'tavern', 'stall'] },
  // Story scenes 60-120k with an EAGER far proxy of 2-4k (section 6 rows 1b and 23).
  'story-scenes': { family: 'buildings-story', band: [60000, 120000], tex: HARD,
    lods: { need: ['LOD1', 'LOD2', 'far'], LOD1: { r: 0.40 }, LOD2: { r: 0.12 }, far: { min: 2000, max: 4000 } },
    keys: ['smuggler_cache', 'skull_totem', 'wrecker_tower', 'whale_skeleton', 'rum_still', 'crow_roost', 'mermaid_shrine',
      'castaway_camp', 'kraken_wreck', 'dig_site', 'gallows', 'parley_table', 'mine_head', 'widow_memorial', 'gibbet_cage'] },
  shark: { family: 'creatures-kraken', band: [8000, 12000], tex: HARD, lods: { need: ['LOD1'], LOD1: { r: 0.40 } }, keys: ['shark'] },
  critters: { family: 'creatures-kraken', band: [2500, 4000], tex: HARD, lods: { need: ['LOD1'], LOD1: { r: 0.40 } },
    keys: ['crab', 'chicken', 'pig', 'gull'] },
  // Characters: 16-22k dressed, LOD1 <= 8k, LOD2 <= 2.5k, LOD3 (far) <= 700 (section 3.11).
  characters: { family: 'characters', band: [16000, 22000], tex: HARD,
    lods: { need: ['LOD1', 'LOD2', 'far'], LOD1: { max: 8000 }, LOD2: { max: 2500 }, far: { max: 700 } }, keys: ['pirate_base'] },
  'fp-arms': { family: 'characters', band: [1500, 4000], tex: HARD, lods: null, keys: ['pirate_fp_arms'] },
  // Ship kit I (b4.3a, ships-07/08): ONE file of ship-only parts. The file band is the sum; every PART is also
  // graded on its own band (figureheads 12-20k, the rest 2-10k: PLAN section 6 row 10) and its own LOD1/LOD2
  // (`<node>_LOD1` / `<node>_LOD2` in ship_kit_a_lods.glb; glazing panes serve every level), and every named
  // socket empty the client mounts by (b4.3c) must be present.
  'ship-kit': { family: 'ship-hardware-kit', band: [60000, 110000], tex: HARD,
    lods: { need: ['LOD1', 'LOD2'], LOD1: { r: 0.40 }, LOD2: { r: 0.12 } }, keys: ['ship_kit_a'],
    parts: Object.fromEntries([
      ...['sloop', 'brigantine', 'galleon'].map((c) => [`figurehead_${c}`, { band: [12000, 20000], nodes: [`figurehead_${c}`] }]),
      ...['stern_gallery_galleon', 'stern_gallery_galleon_upper', 'stern_gallery_brigantine', 'stern_transom_sloop',
        'quarter_gallery_galleon', 'quarter_gallery_brigantine'].map((k) => [k, { band: [2000, 10000], nodes: [k, `${k}_glass`] }]),
      ['gunport', { band: [2000, 10000], nodes: ['gunport', 'gunport_lid'] }],
      ['rudder', { band: [2000, 10000], nodes: ['rudder', 'rudder_gudgeons'] }],
      ['cathead', { band: [2000, 10000], nodes: ['cathead'] }],
    ]),
    sockets: ['sock_figurehead_sloop', 'sock_figurehead_brigantine', 'sock_figurehead_galleon', 'sock_stern_gallery_galleon',
      'sock_stern_gallery_galleon_upper', 'sock_stern_gallery_galleon_upper_lantern_0', 'sock_stern_gallery_galleon_upper_lantern_1',
      'sock_stern_gallery_galleon_upper_lantern_2', 'sock_stern_gallery_brigantine', 'sock_stern_gallery_brigantine_lantern_0',
      'sock_stern_gallery_brigantine_lantern_1', 'sock_stern_transom_sloop', 'sock_stern_transom_sloop_lantern_0',
      'sock_quarter_gallery_galleon', 'sock_quarter_gallery_brigantine', 'sock_gunport', 'sock_gunport_hinge', 'sock_gunport_muzzle',
      'sock_rudder_axis', 'sock_rudder_pintle_0', 'sock_rudder_pintle_1', 'sock_rudder_pintle_2', 'sock_rudder_pintle_3',
      'sock_rudder_tiller', 'sock_cathead', 'sock_cathead_sheave'] },
  // Ship kit II (b4.3b, ships-07/09 + verifier assets missing[0]): deck, rig and ground-tackle parts, ONE file,
  // PLAN section 6 row 11 (1-8k each; the lantern keeps the 3-5k lantern family band). Same per-part LOD chain
  // (ship_kit_b_lods.glb) and named sockets (rigging endpoints for ships-09: shroud, pins, blocks, futtocks).
  'ship-kit-ii': { family: 'ship-hardware-kit', band: [35000, 75000], tex: HARD,
    lods: { need: ['LOD1', 'LOD2'], LOD1: { r: 0.40 }, LOD2: { r: 0.12 } }, keys: ['ship_kit_b'],
    parts: {
      channel: { band: [2000, 8000], nodes: ['channel'] },
      deadeye_pair: { band: [1000, 6000], nodes: ['deadeye_pair'] },
      pin_rail: { band: [2000, 8000], nodes: ['pin_rail'] },
      bell: { band: [2000, 8000], nodes: ['bell', 'bell_belfry'] },
      taffrail_lantern: { band: [3000, 5000], nodes: ['taffrail_lantern', 'taffrail_lantern_glass'] },
      crows_nest: { band: [3000, 8000], nodes: ['crows_nest'] },
      cannonball_rack: { band: [2000, 8000], nodes: ['cannonball_rack'] },
      barrel: { band: [1500, 5000], nodes: ['barrel'] },
      bilge_pump: { band: [2000, 8000], nodes: ['bilge_pump', 'bilge_pump_handle'] },
      anchor: { band: [3000, 8000], nodes: ['anchor'] },
      anchor_cable: { band: [1000, 4000], nodes: ['anchor_cable'] },
      hawse: { band: [1000, 4000], nodes: ['hawse'] },
      rig_block: { band: [1000, 4000], nodes: ['rig_block'] },
    },
    sockets: ['sock_channel', 'sock_channel_notch_0', 'sock_channel_notch_1', 'sock_channel_notch_2', 'sock_channel_notch_3',
      'sock_deadeye_pair', 'sock_deadeye_shroud', 'sock_deadeye_chain',
      'sock_pin_rail', ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => `sock_pin_rail_pin_${k}`),
      'sock_bell', 'sock_bell_pivot', 'sock_bell_rope', 'sock_taffrail_lantern', 'sock_taffrail_lantern_flame',
      'sock_crows_nest', 'sock_crows_nest_floor', 'sock_crows_nest_entry', ...[0, 1, 2, 3].map((k) => `sock_crows_nest_futtock_${k}`),
      'sock_cannonball_rack', ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `sock_cannonball_${k}`),
      'sock_barrel', 'sock_barrel_top', 'sock_bilge_pump', 'sock_bilge_pump_spout', 'sock_bilge_pump_pivot', 'sock_bilge_pump_grip',
      'sock_anchor_ring', 'sock_anchor_crown', 'sock_anchor_bill_0', 'sock_anchor_bill_1',
      'sock_anchor_cable_start', 'sock_anchor_cable_end', 'sock_hawse', 'sock_hawse_lead', 'sock_rig_block', 'sock_rig_block_sheave'] },
  // Animation-only container (retargeted clips, no mesh): graded on membership and compression only.
  'clips-only': { family: 'characters', band: null, tex: null, lods: null, noMesh: true, keys: ['pirate_clips'] },
};
export const CLAUSES = ['band', 'lods', 'textures', 'verts', 'compression'];
export const tierOf = (key) => Object.entries(TIERS).find(([, t]) => t.keys.includes(key))?.[0] ?? null;

// ── the ratchet: known-failing rows at b3.4a (HEAD 2026-09-26). Only ever shrinks. ────────────
// RATCHET-BEGIN
export const RATCHET = [
  // fp-weapons
  // fp-tools
  'tool_bucket:lods', 'tool_bucket:textures', 'tool_bucket:verts',
  'tool_hammer:lods', 'tool_hammer:textures', 'tool_hammer:verts',
  'tool_planks:lods', 'tool_planks:textures', 'tool_planks:verts',
  // cannon
  'cannon:lods',
  // wheel
  'wheel:lods',
  // capstan
  'capstan:lods',
  // lantern
  'ship_lantern:lods',
  // props
  'barrel:band', 'barrel:lods', 'barrel:textures',
  'keg:band', 'keg:lods', 'keg:textures',
  'chest_closed:band', 'chest_closed:lods', 'chest_closed:textures', 'chest_closed:verts',
  'chest_open:band', 'chest_open:lods', 'chest_open:textures', 'chest_open:verts',
  'crate:band', 'crate:lods', 'crate:textures', 'crate:verts',
  'campfire:band', 'campfire:lods', 'campfire:textures', 'campfire:verts',
  'bedroll:band', 'bedroll:lods', 'bedroll:textures',
  'lantern_post:band', 'lantern_post:lods', 'lantern_post:textures', 'lantern_post:verts',
  'tent_a:band', 'tent_a:lods', 'tent_a:textures',
  'tent_b:lods', 'tent_b:textures',
  'tent_c:band', 'tent_c:lods', 'tent_c:textures',
  'bone_pile:band', 'bone_pile:lods', 'bone_pile:textures',
  'driftwood_log:band', 'driftwood_log:lods', 'driftwood_log:textures',
  'grave_marker:band', 'grave_marker:lods', 'grave_marker:textures', 'grave_marker:verts',
  'signal_pyre:band', 'signal_pyre:lods', 'signal_pyre:textures',
  'wall_torch:band', 'wall_torch:lods', 'wall_torch:textures', 'wall_torch:verts',
  'bone_pile_cave:band', 'bone_pile_cave:lods', 'bone_pile_cave:textures', 'bone_pile_cave:verts',
  'skull_shrine:band', 'skull_shrine:lods', 'skull_shrine:textures', 'skull_shrine:verts',
  'cave_painting_panel:band', 'cave_painting_panel:lods', 'cave_painting_panel:textures', 'cave_painting_panel:verts',
  'rope_bridge_short:band', 'rope_bridge_short:lods', 'rope_bridge_short:textures',
  'rowboat:lods', 'rowboat:textures',
  // palms
  'palm_a:band', 'palm_a:lods', 'palm_a:textures',
  'palm_b:band', 'palm_b:lods', 'palm_b:textures',
  'palm_c:band', 'palm_c:lods', 'palm_c:textures',
  'palm_tall:band', 'palm_tall:lods', 'palm_tall:textures',
  'palm_ground:band', 'palm_ground:lods', 'palm_ground:textures',
  // bushes
  'bush:band', 'bush:lods', 'bush:textures',
  'bush_berry:band', 'bush_berry:lods', 'bush_berry:textures',
  'fern_plant:band', 'fern_plant:lods', 'fern_plant:textures',
  'flower_bush:band', 'flower_bush:lods', 'flower_bush:textures',
  // flowers
  'flower_patch:lods', 'flower_patch:textures',
  'wildflowers:band', 'wildflowers:lods', 'wildflowers:textures',
  // boulders
  'boulder_a:textures',
  'boulder_b:textures',
  'boulder_c:textures',
  // searocks
  'searock_a:textures',
  'searock_b:textures',
  'searock_c:textures',
  // arches
  'rock_arch:textures',
  // cliff
  'crag:textures',
  // cave-clusters
  'stalactite_cluster_a:textures',
  'stalactite_cluster_b:textures',
  'stalagmite_cluster_a:textures',
  'stalagmite_cluster_b:textures',
  'crystal_vein_a:band', 'crystal_vein_a:lods', 'crystal_vein_a:textures', 'crystal_vein_a:verts',
  'crystal_vein_b:band', 'crystal_vein_b:lods', 'crystal_vein_b:textures', 'crystal_vein_b:verts',
  'cave_ledge:textures',
  'cave_pool_rim:textures',
  'rock_arch_cave:textures',
  // buildings
  'dock_mid:band', 'dock_mid:lods', 'dock_mid:textures',
  'dock_end:band', 'dock_end:lods', 'dock_end:textures',
  'watchtower:band', 'watchtower:lods', 'watchtower:textures', 'watchtower:verts',
  'shipwreck:band', 'shipwreck:lods', 'shipwreck:textures', 'shipwreck:verts',
  'standing_stones:band', 'standing_stones:lods', 'standing_stones:textures', 'standing_stones:verts',
  'fort:band', 'fort:lods', 'fort:textures',
  'tavern:band', 'tavern:lods', 'tavern:textures', 'tavern:verts',
  'stall:band', 'stall:lods', 'stall:textures',
  // story-scenes
  'smuggler_cache:band', 'smuggler_cache:lods', 'smuggler_cache:textures',
  'skull_totem:band', 'skull_totem:lods', 'skull_totem:textures', 'skull_totem:verts',
  'wrecker_tower:band', 'wrecker_tower:lods', 'wrecker_tower:textures',
  'whale_skeleton:band', 'whale_skeleton:lods', 'whale_skeleton:textures',
  'rum_still:band', 'rum_still:lods', 'rum_still:textures',
  'crow_roost:band', 'crow_roost:lods', 'crow_roost:textures',
  'mermaid_shrine:band', 'mermaid_shrine:lods', 'mermaid_shrine:textures',
  'castaway_camp:band', 'castaway_camp:lods', 'castaway_camp:textures',
  'kraken_wreck:band', 'kraken_wreck:lods', 'kraken_wreck:textures',
  'dig_site:band', 'dig_site:lods', 'dig_site:textures',
  'gallows:band', 'gallows:lods', 'gallows:textures',
  'parley_table:band', 'parley_table:lods', 'parley_table:textures',
  'mine_head:band', 'mine_head:lods', 'mine_head:textures', 'mine_head:verts',
  'widow_memorial:band', 'widow_memorial:lods', 'widow_memorial:textures', 'widow_memorial:verts',
  'gibbet_cage:band', 'gibbet_cage:lods', 'gibbet_cage:textures',
  // shark
  'shark:lods', 'shark:textures',
  // critters
  'crab:band', 'crab:lods', 'crab:textures',
  'chicken:band', 'chicken:lods', 'chicken:textures',
  'pig:band', 'pig:lods', 'pig:textures',
  'gull:band', 'gull:lods', 'gull:textures',
  // characters
  'pirate_base:band', 'pirate_base:lods', 'pirate_base:textures',
  // fp-arms
  'pirate_fp_arms:textures', 'pirate_fp_arms:compression',
  // clips-only
  'pirate_clips:compression',
];
// RATCHET-END

// ── measurement ─────────────────────────────────────────────────────────────────────────────
function readJson(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file}: not a GLB`);
  const jl = buf.readUInt32LE(12);
  return JSON.parse(buf.subarray(20, 20 + jl).toString());
}
function meshTris(j, mi) {
  let tris = 0, verts = 0;
  for (const p of j.meshes[mi].primitives) {
    const pc = j.accessors[p.attributes.POSITION].count;
    verts += pc;
    tris += (p.indices != null ? j.accessors[p.indices].count : pc) / 3;
  }
  return { tris, verts };
}
function totals(j) {
  let tris = 0, verts = 0;
  for (let mi = 0; mi < (j.meshes || []).length; mi++) { const s = meshTris(j, mi); tris += s.tris; verts += s.verts; }
  return { tris, verts };
}
/** Triangles under each node whose name ends in LOD1 / LOD2 / far (subtree sums; instancing counted per use). */
function lodLevels(j) {
  const out = {};
  const sub = (ni) => {
    const n = j.nodes[ni];
    let t = n.mesh != null ? meshTris(j, n.mesh).tris : 0;
    for (const c of n.children || []) t += sub(c);
    return t;
  };
  (j.nodes || []).forEach((n, ni) => {
    const m = /(?:^|[_\-.])(LOD1|LOD2|far)$/i.exec(n.name || '');
    if (!m) return;
    const lvl = m[1].toLowerCase() === 'far' ? 'far' : m[1].toUpperCase();
    out[lvl] = (out[lvl] ?? 0) + sub(ni);
  });
  return out;
}
/** Triangles per named mesh node (kit tiers grade parts by node name). */
function nodeTris(j) {
  const out = {};
  for (const n of j.nodes || []) if (n.mesh != null) out[n.name] = (out[n.name] ?? 0) + meshTris(j, n.mesh).tris;
  return out;
}
function texSet(j) {
  const mats = j.materials || [];
  const graded = mats.filter((m) => !((m.emissiveFactor || [0, 0, 0]).some((v) => v > 0) && !m.pbrMetallicRoughness?.baseColorTexture));
  const has = { base: (m) => m.pbrMetallicRoughness?.baseColorTexture, normal: (m) => m.normalTexture,
    orm: (m) => m.pbrMetallicRoughness?.metallicRoughnessTexture };
  return { graded, has, mats };
}

export function measure(key, manifest) {
  const j = readJson(path.join(DIR, `${key}.glb`));
  const { tris, verts } = totals(j);
  const lodsFile = path.join(DIR, `${key}_lods.glb`);
  const lods = fs.existsSync(lodsFile) ? lodLevels(readJson(lodsFile)) : null;
  const { graded, has, mats } = texSet(j);
  const packedName = manifest[key];
  let packed = null;
  if (packedName && fs.existsSync(path.join(DIR, 'packed', packedName))) {
    const pj = readJson(path.join(DIR, 'packed', packedName));
    packed = { meshopt: (pj.extensionsUsed || []).includes('EXT_meshopt_compression'),
      images: (pj.images || []).map((i) => i.mimeType || path.extname(i.uri || '')),
      basisuTextures: (pj.textures || []).filter((t) => t.extensions?.KHR_texture_basisu).length,
      textures: (pj.textures || []).length };
  }
  const kit = TIERS[tierOf(key)]?.parts ? { nodes: nodeTris(j), names: (j.nodes || []).map((n) => n.name),
    lodNodes: fs.existsSync(lodsFile) ? nodeTris(readJson(lodsFile)) : null } : null;
  return { key, tris, verts, lods, graded, has, mats: mats.length, packed, packedName, kit };
}

/** Grade one measured key against its tier: { clause: null (pass) | 'why it fails' }. */
export function grade(tierName, m) {
  const t = TIERS[tierName];
  const r = {};
  if (t.noMesh) {
    r.band = m.tris === 0 ? null : `${m.tris} tris in an animation-only container`;
  } else {
    const [lo, hi] = t.band;
    r.band = m.tris >= lo && m.tris <= hi ? null : `${m.tris} tris outside [${lo}, ${hi}]`;
    if (t.parts) {
      const bad = Object.entries(t.parts).map(([p, spec]) => [p, spec, spec.nodes.reduce((a, n) => a + (m.kit?.nodes[n] ?? 0), 0)])
        .filter(([, spec, v]) => v < spec.band[0] || v > spec.band[1]).map(([p, spec, v]) => `part ${p} ${v} outside [${spec.band}]`);
      if (bad.length) r.band = [r.band, ...bad].filter(Boolean).join('; ');
    }
  }
  if (t.lods) {
    if (!m.lods) r.lods = `no ${m.key}_lods.glb (needs ${t.lods.need.join('/')})`;
    else {
      const bad = [];
      let prev = m.tris;
      for (const lvl of t.lods.need) {
        const v = m.lods[lvl];
        const c = t.lods[lvl] || {};
        if (v == null || v <= 0) { bad.push(`${lvl} missing`); continue; }
        if (c.r != null && v > m.tris * c.r) bad.push(`${lvl} ${v} > ${(c.r * 100).toFixed(0)}% of ${m.tris}`);
        if (c.max != null && v > c.max) bad.push(`${lvl} ${v} > ${c.max}`);
        if (c.min != null && v < c.min) bad.push(`${lvl} ${v} < ${c.min}`);
        if (v >= prev) bad.push(`${lvl} ${v} not coarser than ${prev}`);
        prev = v;
      }
      for (const [p, spec] of Object.entries(t.parts || {})) {
        const meshNodes = spec.nodes.filter((n) => !n.endsWith('_glass'));
        const lod0 = meshNodes.reduce((a, n) => a + (m.kit?.nodes[n] ?? 0), 0);
        let prevP = lod0;
        for (const lvl of t.lods.need) {
          const v = meshNodes.reduce((a, n) => a + (m.kit?.lodNodes?.[`${n}_${lvl}`] ?? 0), 0);
          const c = t.lods[lvl] || {};
          if (v <= 0) bad.push(`part ${p} ${lvl} missing`);
          else if ((c.r != null && v > lod0 * c.r) || v >= prevP) bad.push(`part ${p} ${lvl} ${v} vs LOD0 ${lod0}`);
          prevP = v;
        }
      }
      r.lods = bad.length ? bad.join('; ') : null;
    }
  } else r.lods = null;
  if (t.tex) {
    const missing = [];
    if (m.graded.length === 0) missing.push('no graded material');
    for (const k of t.tex) {
      const n = m.graded.filter((mat) => m.has[k](mat)).length;
      if (n < m.graded.length) missing.push(`${k} ${n}/${m.graded.length}`);
    }
    r.textures = missing.length ? `maps missing: ${missing.join(', ')}` : null;
  } else r.textures = null;
  r.verts = t.foliage || t.noMesh || m.tris === 0 ? null
    : (m.verts / m.tris <= 1.3 ? null : `verts/tris ${(m.verts / m.tris).toFixed(2)} > 1.3`);
  if (!m.packed) r.compression = m.packedName ? `packed/${m.packedName} missing` : 'not in model-manifest.json (ships raw)';
  else {
    const bad = [];
    if (!m.packed.meshopt) bad.push('no EXT_meshopt_compression');
    const raw = m.packed.images.filter((x) => !/ktx2/.test(x));
    if (raw.length) bad.push(`${raw.length} non-KTX2 image(s) ${raw.join(',')}`);
    if (m.packed.basisuTextures < m.packed.textures) bad.push(`${m.packed.textures - m.packed.basisuTextures} texture(s) without KHR_texture_basisu`);
    r.compression = bad.length ? bad.join('; ') : null;
  }
  return r;
}

/** Ratchet rows as written in a copy of this file (git blob text), or null. */
function ratchetIn(text) {
  const m = /\/\/ RATCHET-BEGIN([\s\S]*?)\/\/ RATCHET-END/.exec(text || '');
  if (!m) return null;
  return new Set([...m[1].matchAll(/'([a-z0-9_]+:[a-z]+)'/g)].map((x) => x[1]));
}
function git(args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

// ── the run ─────────────────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--list') {
    const t = TIERS[argv[1]];
    if (!t) { console.error(`unknown tier ${argv[1]}; tiers: ${Object.keys(TIERS).join(', ')}`); process.exit(2); }
    console.log(t.keys.join(','));
    return;
  }
  if (argv[0] === '--tiers') { console.log(JSON.stringify(Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [k, t.keys])))); return; }
  if (argv.includes('--prove')) return prove();

  const mutate = (process.env.PIRATES_BR_MUTATE ?? '').replace(/^tiers:/, '');
  let failures = 0, checks = 0;
  const expect = (label, ok, detail = '') => {
    checks += 1;
    if (ok) console.log(`  ✓ ${label}`);
    else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
  };
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const ratchet = new Set(RATCHET);
  const tiers = structuredClone(TIERS);
  if (mutate) console.log(`  ! mutation: ${mutate}`);

  // [member] every LOD0 GLB in exactly one tier; every tier key on disk.
  const onDisk = fs.readdirSync(DIR).filter((f) => f.endsWith('.glb') && !/_(far|lods)\.glb$/.test(f)).map((f) => f.slice(0, -4)).sort();
  if (mutate === 'member') { const k = tiers.props.keys.shift(); console.log(`  ! ${k} dropped from its tier`); }
  const owners = new Map();
  for (const [tn, t] of Object.entries(tiers)) for (const k of t.keys) owners.set(k, [...(owners.get(k) || []), tn]);
  const unassigned = onDisk.filter((k) => !owners.has(k));
  const doubled = [...owners].filter(([, ts]) => ts.length > 1).map(([k, ts]) => `${k} (${ts.join(', ')})`);
  const ghosts = [...owners.keys()].filter((k) => !onDisk.includes(k));
  expect(`[member] ${onDisk.length} LOD0 GLBs each in exactly one of ${Object.keys(tiers).length} tiers`,
    !unassigned.length && !doubled.length && !ghosts.length,
    [unassigned.length && `no tier: ${unassigned.join(', ')}`, doubled.length && `two tiers: ${doubled.join(', ')}`,
      ghosts.length && `tier key with no GLB: ${ghosts.join(', ')}`].filter(Boolean).join(' | '));

  // Measure + grade every row.
  const rows = [];
  for (const [tn, t] of Object.entries(tiers)) {
    for (const k of t.keys) {
      if (!onDisk.includes(k)) continue;
      const m = measure(k, manifest);
      rows.push({ key: k, tier: tn, m, g: grade(tn, m) });
    }
  }
  // Clause mutations: perturb the first row that PASSES the clause; if none passes on HEAD, drop the
  // clause's first ratchet row instead (the "removed ratchet row that still fails" rule).
  if (CLAUSES.includes(mutate)) {
    const victim = rows.find((r) => r.g[mutate] == null && !(mutate === 'lods' && !tiers[r.tier].lods)
      && !(mutate === 'verts' && (tiers[r.tier].foliage || tiers[r.tier].noMesh)) && !(mutate === 'textures' && !tiers[r.tier].tex)
      && !(mutate === 'band' && tiers[r.tier].noMesh));
    if (victim) {
      const m = { ...victim.m, packed: victim.m.packed && { ...victim.m.packed } };
      if (mutate === 'band') m.tris = tiers[victim.tier].band[1] + 1;
      if (mutate === 'lods') m.lods = null;
      if (mutate === 'textures') m.has = { ...victim.m.has, normal: () => false, base: () => false };
      if (mutate === 'verts') m.verts = m.tris * 3;
      if (mutate === 'compression') m.packed = { ...m.packed, meshopt: false };
      victim.g = grade(victim.tier, m);
      console.log(`  ! ${victim.key}:${mutate} perturbed (a passing row made to fail)`);
    } else {
      const drop = [...ratchet].find((x) => x.endsWith(`:${mutate}`));
      if (drop) { ratchet.delete(drop); console.log(`  ! ratchet row ${drop} removed while it still fails`); }
    }
  }
  // [parts] / [sockets]: a kit part out of its own band fails band; a missing socket empty fails the suite.
  if (mutate === 'parts') {
    const v = rows.find((r) => tiers[r.tier].parts);
    if (v) {
      const [p, spec] = Object.entries(tiers[v.tier].parts)[0];
      v.g = grade(v.tier, { ...v.m, kit: { ...v.m.kit, nodes: { ...v.m.kit.nodes, [spec.nodes[0]]: spec.band[1] + 1 } } });
      console.log(`  ! ${v.key} part ${p} pushed over its band`);
    }
  }
  for (const r of rows.filter((x) => tiers[x.tier].sockets)) {
    const names = new Set(r.m.kit?.names ?? []);
    if (mutate === 'sockets') { names.delete(tiers[r.tier].sockets[0]); console.log(`  ! ${tiers[r.tier].sockets[0]} dropped`); }
    const missing = tiers[r.tier].sockets.filter((n) => !names.has(n));
    expect(`[sockets] ${r.key}: ${tiers[r.tier].sockets.length} named socket empties present`, missing.length === 0, `missing: ${missing.join(', ')}`);
  }
  if (mutate === 'stale') {
    const passing = rows.flatMap((r) => CLAUSES.filter((c) => r.g[c] == null).map((c) => `${r.key}:${c}`)).find((x) => !ratchet.has(x));
    if (passing) { ratchet.add(passing); console.log(`  ! passing row ${passing} added to the ratchet`); }
  }

  // Grade against the ratchet.
  const failing = new Set();
  const perTier = {};
  for (const r of rows) {
    const pt = (perTier[r.tier] ??= { rows: 0, red: 0 });
    for (const c of CLAUSES) {
      pt.rows += 1;
      const id = `${r.key}:${c}`;
      if (r.g[c] != null) { failing.add(id); pt.red += 1; }
      if (r.g[c] != null && !ratchet.has(id)) expect(`[${c}] ${r.key} (${r.tier})`, false, `${r.g[c]} — not in the ratchet: fix the asset (a ratchet row may never be added)`);
      if (r.g[c] == null && ratchet.has(id)) expect(`[${c}] ${r.key} passes: delete '${id}' from the ratchet`, false, 'the ratchet only shrinks: a fixed row leaves the list in the fixing commit');
    }
  }
  for (const id of ratchet) if (!rows.some((r) => id.startsWith(`${r.key}:`))) expect(`ratchet row ${id} names a key that is graded`, false);
  for (const [tn, pt] of Object.entries(perTier)) {
    console.log(`  · ${tn.padEnd(14)} ${String(pt.rows).padStart(3)} rows, ${String(pt.red).padStart(3)} red`);
  }
  expect(`${failing.size} red rows are exactly the ratchet (${ratchet.size} rows; section 3.12: ends empty)`,
    [...failing].every((x) => ratchet.has(x)) && [...ratchet].every((x) => failing.has(x)));

  // [ratchet only shrinks] vs the commit that created this file and vs the committed HEAD copy.
  const grown = mutate === 'grow' ? new Set([...ratchet, 'barrel:grown']) : ratchet;
  if (mutate === 'grow') console.log('  ! a row not present at the baseline added to the ratchet');
  const created = (git(['log', '--diff-filter=A', '--format=%H', '--', SELF_REL]) || '').trim().split('\n').filter(Boolean).pop();
  const baselines = [];
  if (created) baselines.push([`creation ${created.slice(0, 8)}`, ratchetIn(git(['show', `${created}:${SELF_REL}`]))]);
  const headCopy = ratchetIn(git(['show', `HEAD:${SELF_REL}`]));
  if (headCopy) baselines.push(['HEAD', headCopy]);
  if (!baselines.length) console.log('  · ratchet-growth check skipped: no git history for this file (container / pre-commit)');
  for (const [label, base] of baselines) {
    if (!base) continue;
    const extra = [...grown].filter((x) => !base.has(x));
    expect(`[ratchet] no row absent at ${label} (${base.size} there, ${grown.size} now)`, extra.length === 0, `grew: ${extra.join(', ')}`);
  }

  console.log(`\n${rows.length} assets x ${CLAUSES.length} clauses = ${rows.length * CLAUSES.length} rows, ${failing.size} red (ratcheted); ${checks} checks, ${failures} failed`);
  if (checks === 0 || rows.length === 0) { console.error('VACUOUS: nothing graded'); process.exit(1); }
  process.exit(failures > 0 ? 1 : 0);
}

function prove() {
  const muts = [...CLAUSES, 'stale', 'grow', 'member', 'parts', 'sockets'];
  let bad = 0;
  const clean = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, PIRATES_BR_MUTATE: '' }, encoding: 'utf8' });
  console.log(`  ${clean.status === 0 ? '✓' : '✗ FAIL:'} unmutated run exits 0 (got ${clean.status})`);
  if (clean.status !== 0) { bad += 1; process.stderr.write(clean.stderr.split('\n').slice(0, 20).join('\n') + '\n'); }
  for (const mu of muts) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, PIRATES_BR_MUTATE: `tiers:${mu}` }, encoding: 'utf8' });
    const red = (r.stderr.match(/✗ FAIL: [^\n]*/g) || []).slice(0, 2).join(' | ');
    if (r.status === 1 && red) console.log(`  ✓ PIRATES_BR_MUTATE=tiers:${mu} goes red: ${red}`);
    else { bad += 1; console.error(`  ✗ FAIL: PIRATES_BR_MUTATE=tiers:${mu} did not go red on a graded line (exit ${r.status}) — this clause cannot fail\n     ${(r.stderr || '').split('\n').slice(0, 4).join('\n     ')}`); }
  }
  console.log(`\n${muts.length + 1} proofs, ${bad} failed`);
  process.exit(bad ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
