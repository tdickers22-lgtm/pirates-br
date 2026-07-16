#!/usr/bin/env node
// Floating-prop audit — rocks hovering over shore drops are a placement bug,
// not a rendering one. For every wide-based prop (boulder_* and any blocking
// collider with a broad radius, plus 'none'-shape story vignettes via their
// spacing radius) sample the terrain at the prop's seat footprint (center + 8
// compass points at the FULL footprint radius) and compare against the Y the
// client actually seats the GLB at (getPropGroundY):
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
      footprint = col.radius * prop.scale;
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

console.log(`\nfloating-prop audit: ${audited} wide-based props checked, ${floaters} floater(s) (HOVER > ${HOVER_LIMIT}), ${buried} deep-buried (BURY > ${BURY_LIMIT})`);
if (floaters > 0) {
  console.error('FAIL: props hover above the terrain under their footprint');
  process.exit(1);
}
console.log('OK: every wide-based prop seats on (or into) the terrain under its footprint');
