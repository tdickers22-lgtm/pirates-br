#!/usr/bin/env node
// ANALYTIC seat audit — the SERVER's ground, not the player's.
//
// ── WHAT THIS IS NOT (read this before believing a green line here) ─────────
// This audit does NOT and CANNOT tell you whether anything floats on screen. It
// samples `getIslandSurfaceY`, the shared analytic heightfield. The island the
// player looks at is a polar TRIANGLE MESH sampled from that field, and a
// triangle is a chord: wherever the field is convex — every stamp rim, terrace
// lip and ridge — the drawn ground runs BELOW the function. A boulder can be
// analytically flush and visibly hanging in the air, and this file will call it
// seated. That is the GroundTruth lesson, and 1,193 real floaters lived behind
// a green run of exactly this script.
//
//   The audit that measures what the player sees is scripts/audit-live-floaters.mjs.
//   It joins a real match, rebuilds each island's rendered surface from its own
//   triangles, and holds every drawn piece to it. THAT one is the authority on
//   floating. This one is not, and no longer claims to be.
//
// ── WHAT IT IS, AND WHY IT IS KEPT ──────────────────────────────────────────
// The analytic field is not a bad approximation of the mesh; it is the SERVER'S
// GROUND, and it is authoritative for everything the server does. Prop capsules,
// harvest reach, locomotion and collision all resolve against it. A prop whose
// seat disagrees with the analytic terrain under its own footprint is therefore
// a real defect with real consequences the browser audit cannot attribute: a
// collider standing in mid-air that players walk under, or a harvestable buried
// out of reach. Those are worth a headless, deterministic, sub-second guard in
// the logic chain — which is what this now is, honestly labelled.
//
// (The third option, re-pointing this file at the drawn mesh, is not available:
// the drawn mesh only exists in a browser. That is precisely why
// audit-live-floaters.mjs is a Playwright suite.)
//
// So: for every wide-based prop (boulder_* and any blocking collider with a
// broad radius, plus 'none'-shape story vignettes via their spacing radius)
// sample the terrain at the prop's seat footprint (center + 8 compass points at
// the FULL footprint radius) and compare against the Y `getPropGroundY` seats
// it at:
//   HOVER = placedY − min(sample)  → base edge dangling over a drop
//   BURY  = max(sample) − placedY  → prop swallowed by the high side
// Floaters (HOVER > 0.35) fail the audit; buried props (BURY > 1.2) are
// reported for eyeballing (half-buried rocks are natural; drowned scenes not).
import { MapGenerator } from '../src/server/world/MapGenerator.ts';
import { getIslandSurfaceY } from '../src/shared/utils/index.ts';
import { PROP_COLLIDERS, getPropGroundY, getPropSpacingRadius } from '../src/shared/props.ts';

const HOVER_LIMIT = 0.35;
const BURY_LIMIT = 1.2;
// Half-beached by design (waterline hulls) or spanning open water on posts.
const EXEMPT = new Set(['shipwreck', 'dock_mid', 'dock_end']);
// Blocking props whose GLB base is wide enough that a center-ish terrain
// sample can miss a shore drop under one edge.
const WIDE_RADIUS = 1.0;
// A blocking capsule is sized to stop a PLAYER, not to describe the masonry.
// The watchtower's stone drum is r 2.02 with its block courses reaching ~2.2
// (scripts/blender/build_landmarks.py), inside a 2.9m capsule — so sampling the
// capsule ring reads ground almost a metre outside anything the model touches,
// and a tower bedded flush on its drum on a hillside reported a 1.1m "float".
// Where the authored base skirt is narrower than the collider, audit THAT.
const BASE_SKIRT_RADIUS = {
  watchtower: 2.2,
};

const DIAG = Math.SQRT1_2;
const RING = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [DIAG, DIAG], [DIAG, -DIAG], [-DIAG, DIAG], [-DIAG, -DIAG],
];

const islands = new MapGenerator(12345).generateIslands();

let audited = 0;
let floaters = 0;
let buried = 0;

for (const island of islands) {
  const rows = [];
  for (const prop of island.props ?? []) {
    if (EXEMPT.has(prop.type)) continue;
    const col = PROP_COLLIDERS[prop.type];
    if (!col) continue;
    let footprint;
    let kind;
    if (col.shape === 'none') {
      // Story vignettes reserve space via spacing radius; their seat footprint
      // (what getPropGroundY beds) is 45% of it — audit that contact ring.
      const spacing = getPropSpacingRadius(prop.type, prop.scale);
      if (spacing < 2.0) continue; // small soft decor (bushes etc.) can't visibly float
      footprint = spacing * 0.45;
      kind = 'scene';
    } else {
      if (col.radius * prop.scale < WIDE_RADIUS && !prop.type.startsWith('boulder_')) continue;
      footprint = (BASE_SKIRT_RADIUS[prop.type] ?? col.radius) * prop.scale;
      kind = prop.type.startsWith('boulder_') ? 'rock' : 'wide';
    }
    audited++;
    const placedY = getPropGroundY(island, prop);
    let lo = getIslandSurfaceY(island, prop.x, prop.z);
    let hi = lo;
    for (const [ox, oz] of RING) {
      const y = getIslandSurfaceY(island, prop.x + ox * footprint, prop.z + oz * footprint);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    const hover = placedY - lo;
    const bury = hi - placedY;
    if (hover > HOVER_LIMIT || bury > BURY_LIMIT) {
      rows.push({ prop, kind, footprint, placedY, lo, hi, hover, bury });
    }
  }
  if (rows.length === 0) continue;
  console.log(`── ${island.id} (${island.profile.biome}/${island.profile.terrainStyle})`);
  rows.sort((a, b) => Math.max(b.hover, b.bury) - Math.max(a.hover, a.bury));
  for (const r of rows) {
    const isFloater = r.hover > HOVER_LIMIT;
    if (isFloater) floaters++;
    if (r.bury > BURY_LIMIT) buried++;
    console.log(
      `  ${isFloater ? '✗ FLOAT' : '· bury '} ${r.prop.type}#${r.prop.id} [${r.kind}] ` +
      `at (${r.prop.x.toFixed(1)}, ${r.prop.z.toFixed(1)}) scale=${r.prop.scale.toFixed(2)} fp=${r.footprint.toFixed(2)}m ` +
      `placedY=${r.placedY.toFixed(2)} terrain[${r.lo.toFixed(2)}..${r.hi.toFixed(2)}] ` +
      `HOVER=${r.hover.toFixed(2)} BURY=${r.bury.toFixed(2)}`,
    );
  }
}

console.log(`\nanalytic seat audit: ${audited} wide-based props checked against the SERVER's heightfield, `
  + `${floaters} unseated (HOVER > ${HOVER_LIMIT}), ${buried} deep-buried (BURY > ${BURY_LIMIT})`);
if (floaters > 0) {
  console.error('FAIL: props sit above the analytic terrain under their footprint — colliders and harvest reach resolve against that surface');
  process.exit(1);
}
// Deliberately NOT "nothing floats": this audit cannot see the drawn mesh, and
// a clean run here has coexisted with a thousand visible floaters before.
console.log('OK: every wide-based prop seats on (or into) the SERVER\'s terrain under its footprint');
console.log('    (says nothing about what the player sees — that is scripts/audit-live-floaters.mjs)');
