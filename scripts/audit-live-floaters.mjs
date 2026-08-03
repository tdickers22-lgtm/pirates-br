#!/usr/bin/env node
// LIVE floater audit — the only floating-prop test that measures what the
// player actually sees.
//
// scripts/audit-floating-props.mjs checks placement against the ANALYTIC
// heightfield (getIslandSurfaceY). That test passes while boulders visibly hang
// in the air, because the rendered island is a POLAR MESH: its triangles are
// chords under the analytic curve, and every stamp rim (dock/tavern/camp pads),
// terrace step and convex ridge leaves the drawn ground centimetres-to-metres
// BELOW the function the props were seated on.
//
// So this audit joins a real match, lets every island build, rebuilds each
// island's rendered terrain surface from its own triangles, and measures every
// rendered prop against THAT:
//
//   gap = box.min.y − max(rendered ground under the footprint ring)
//
// max(), not min(): a prop on a slope legitimately has daylight under its
// downhill edge. A FLOATER has daylight under its whole base — nothing under
// the footprint reaches it.
//
//   node scripts/audit-live-floaters.mjs [outDir]
//     PIRATES_BR_FLOAT_LIMIT=0.25   gap (m) that counts as a floater
import { chromium } from 'playwright';
import { browserArgs } from './lib/browser-args.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

// EVERY BROWSER SUITE HERE READS PIRATES_BR_URL. A graded run points it at a
// Vite the runner owns rather than at the developer's :3000, and a suite that
// hard-codes the port sends itself somewhere else — which reads as
// ERR_CONNECTION_REFUSED half a second in, an exit code indistinguishable from
// a real failure.
const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');

const OUT = process.argv[2] ?? 'test-results/live-floaters';
mkdirSync(OUT, { recursive: true });
const LIMIT = Number(process.env.PIRATES_BR_FLOAT_LIMIT ?? 0.25);

const browser = await chromium.launch({
  args: browserArgs(['--ignore-gpu-blocklist']),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (err) => console.log(`  [pageerror] ${err}`));

// Other agents editing this tree make vite full-reload the page mid-run, which
// wipes the match out from under us. Stub the HMR client so this tab never
// listens for reloads.
await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: [
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {};',
    'export const removeStyle = () => {};',
    'export const injectQuery = (u) => u;',
    'export default {};',
  ].join('\n'),
}));

await page.goto(`${BASE_URL}/?debug`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
await page.click('#menu-solo-btn', { noWaitAfter: true });
// 3rd arg is the options bag — as the 2nd it is silently the page-fn ARG and the
// 30s default applies (a busy dev server then "times the join out").
await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
await page.waitForTimeout(2500);
await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));

// Force every island to build (normally 1 per frame) so the audit covers the
// whole roster, not just the spawn area.
await page.evaluate(() => window.__piratesBR.drainIslandBuildQueue(40));
await page.waitForFunction(
  () => window.__piratesBR.islandMeshes.size >= (window.__piratesBR.state?.islands?.length ?? 99),
  null,
  { timeout: 60_000 },
);
await page.waitForTimeout(1200);

const report = await page.evaluate((limit) => {
  const g = window.__piratesBR;
  const THREE = g.renderer.THREE ?? null;

  /** Rendered-surface sampler over ONE island's terrain triangles.
   *  Uniform XZ bucket grid → barycentric lookup; returns the highest triangle
   *  covering (x, z), which is the ground a prop would rest on. */
  function makeMeshSampler(mesh) {
    const geo = mesh.geometry;
    const p = geo.attributes.position.array;
    const index = geo.index ? geo.index.array : null;
    const triCount = index ? index.length / 3 : p.length / 9;
    const CELL = 6;
    const buckets = new Map();
    const key = (ix, iz) => `${ix}|${iz}`;
    const tri = (t) => (index
      ? [index[t * 3] * 3, index[t * 3 + 1] * 3, index[t * 3 + 2] * 3]
      : [t * 9, t * 9 + 3, t * 9 + 6]);
    for (let t = 0; t < triCount; t++) {
      const [a, b, c] = tri(t);
      const minX = Math.min(p[a], p[b], p[c]);
      const maxX = Math.max(p[a], p[b], p[c]);
      const minZ = Math.min(p[a + 2], p[b + 2], p[c + 2]);
      const maxZ = Math.max(p[a + 2], p[b + 2], p[c + 2]);
      for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
        for (let iz = Math.floor(minZ / CELL); iz <= Math.floor(maxZ / CELL); iz++) {
          const k = key(ix, iz);
          const list = buckets.get(k);
          if (list) list.push(t); else buckets.set(k, [t]);
        }
      }
    }
    return (x, z) => {
      const list = buckets.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
      if (!list) return null;
      let best = null;
      for (const t of list) {
        const [a, b, c] = tri(t);
        const x1 = p[a], z1 = p[a + 2], x2 = p[b], z2 = p[b + 2], x3 = p[c], z3 = p[c + 2];
        const d = (z2 - z3) * (x1 - x3) + (x3 - x2) * (z1 - z3);
        if (Math.abs(d) < 1e-9) continue;
        const w1 = ((z2 - z3) * (x - x3) + (x3 - x2) * (z - z3)) / d;
        const w2 = ((z3 - z1) * (x - x3) + (x1 - x3) * (z - z3)) / d;
        const w3 = 1 - w1 - w2;
        if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue;
        const y = w1 * p[a + 1] + w2 * p[b + 1] + w3 * p[c + 1];
        if (best === null || y > best) best = y;
      }
      return best;
    };
  }

  // Ground cover / FX / water layers are not "props standing on the ground".
  const SKIP_NAMES = new Set([
    'island-terrain', 'island-shore-skirt', 'island-proxy-root',
    'island-grass', 'island-ferns', 'island-shells', 'island-pebbles',
    'island-contact-shadows',
  ]);
  // Pieces that CLAIM to be seated on the ground: the server prop registry
  // (props-/prop-) and the client decor scatter (decor-). Those are the audit's
  // contract. Everything else — bridges, rope ladders, lookout platforms, dock
  // decking, ruins — is scenery whose base may legitimately be in the air, and
  // is reported separately as unclaimed.
  const CLAIMED = /^(props?-|decor-)/;
  // ── ELEVATED SCENERY, NAMED ────────────────────────────────────────────────
  // "unclaimed" was a shrug: everything that wasn't a prop or decor got listed
  // with a gap and no verdict, so the report could never reach zero and a row
  // that mattered would have sat in that pile unread. The pile is not
  // mysterious — it is two kinds of thing, both elevated on purpose, and both
  // resting on rock this audit's terrain sampler cannot see. So name them, with
  // the reason, and gate on what is left: an unclaimed tag that ISN'T in this
  // vocabulary is a piece nobody has accounted for, and that is a finding.
  //
  // Adding to this list is a deliberate act. If a new structure shows up here,
  // either it genuinely stands off the ground (say why, in one line) or it is
  // the floater this audit exists to catch.
  const ELEVATED_BY_DESIGN = [
    {
      re: /^cave-portal-rock/,
      why: 'brow crags and jambs framing a cave mouth: they are seated on the THROAT COLLAR '
        + '(CaveBuilder\'s minLocalY), which is the mouth\'s own rock and not part of the terrain '
        + 'mesh — the daylight under a brow crag is the doorway it caps',
    },
    {
      re: /^bridge-span/,
      why: 'a rope bridge between two peaks is a span; its deck is over the valley by definition',
    },
  ];
  const bidDesign = (tag) => ELEVATED_BY_DESIGN.find((e) => e.re.test(tag)) ?? null;
  const SKIP_MATCH = /waterfall|mist|smoke|spray|steam|ember|plume|geyser|cloud|vine|bird|glow|halo|foam|water|splash|light|particle/i;
  const DIAG = Math.SQRT1_2;
  const RING = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [DIAG, DIAG], [DIAG, -DIAG], [-DIAG, DIAG], [-DIAG, -DIAG]];

  const islands = g.state.islands;
  const out = {
    limit,
    islands: [],
    totals: { checked: 0, floaters: 0, byDesign: 0, unaccounted: 0, indoorBlades: 0 },
    vocabulary: ELEVATED_BY_DESIGN.map((e) => ({ pattern: String(e.re), why: e.why, count: 0 })),
  };

  for (const island of islands) {
    const group = g.islandMeshes.get(island.id);
    if (!group) continue;
    const terrain = group.getObjectByName('island-terrain');
    if (!terrain) continue;
    const sample = makeMeshSampler(terrain);
    const rows = [];
    const byDesign = [];
    const unaccounted = [];
    let checked = 0;

    const items = [];
    const detail = group.userData.detailRoot ?? group;
    const mul = (a, b) => {
      const c = new Array(16).fill(0);
      for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
          let s = 0;
          for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
          c[col * 4 + row] = s;
        }
      }
      return c;
    };
    const boxOf = (bb, m) => {
      const corners = [
        [bb.min.x, bb.min.y, bb.min.z], [bb.max.x, bb.min.y, bb.min.z],
        [bb.min.x, bb.min.y, bb.max.z], [bb.max.x, bb.min.y, bb.max.z],
        [bb.min.x, bb.max.y, bb.min.z], [bb.max.x, bb.max.y, bb.min.z],
        [bb.min.x, bb.max.y, bb.max.z], [bb.max.x, bb.max.y, bb.max.z],
      ];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [cx, cy, cz] of corners) {
        const x = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
        const y = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
        const z = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      }
      return { minX, maxX, minY, maxY, minZ, maxZ };
    };
    const merge = (a, b) => (a === null ? b : {
      minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
      minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
      minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ),
    });
    // ONE row per placed PIECE, not per sub-mesh: a watchtower's upper drum or a
    // palm's crown is 8 m above the ground by design. A piece is a top-level
    // child of the island's detail/micro root (its whole subtree merged), or one
    // instance of an InstancedMesh.
    const roots = [...detail.children];
    const micro = group.userData.microRoot;
    if (micro) roots.push(...micro.children);
    for (const root of roots) {
      if (SKIP_NAMES.has(root.name) || SKIP_MATCH.test(root.name)) continue;
      if (root === micro) continue;
      // A BATCH THINNED BY DISTANCE IS STILL A BATCH THIS AUDIT HAS TO READ.
      // island/InstanceLod lowers an InstancedMesh's `count` by distance and
      // hides it outright once the count reaches zero, so on a far island the
      // two lines below would quietly audit a fraction of the props and report
      // it as a clean island. The batch records the count it was BUILT with;
      // read that instead, and treat "hidden by the instance LOD" as visible.
      const lod = root.userData?.instanceLod ?? null;
      if (!root.visible && !(lod && lod.hidden)) continue;
      const label = root.name || (root.isMesh ? root.geometry.type : root.type);
      const local = (obj) => {
        const wm = obj.matrixWorld.elements.slice();
        wm[12] -= group.position.x;
        wm[13] -= group.position.y;
        wm[14] -= group.position.z;
        return wm;
      };
      if (root.isInstancedMesh) {
        if (!root.geometry.boundingBox) root.geometry.computeBoundingBox();
        const bb = root.geometry.boundingBox;
        if (!bb) continue;
        const wm = local(root);
        const im = root.instanceMatrix.array;
        const instances = lod ? lod.full : root.count;
        for (let i = 0; i < instances; i++) {
          items.push({ tag: `${label}#${i}`, ...boxOf(bb, mul(wm, im.slice(i * 16, i * 16 + 16))) });
        }
        continue;
      }
      let box = null;
      let skip = false;
      root.traverse((obj) => {
        if (SKIP_MATCH.test(obj.name)) { skip = true; return; }
        if (!obj.isMesh || !obj.visible) return;
        if (!obj.geometry.boundingBox) obj.geometry.computeBoundingBox();
        if (!obj.geometry.boundingBox) return;
        box = merge(box, boxOf(obj.geometry.boundingBox, local(obj)));
      });
      if (skip || !box) continue;
      items.push({ tag: label, ...box });
    }

    for (const it of items) {
      const sx = it.maxX - it.minX;
      const sz = it.maxZ - it.minZ;
      const foot = Math.max(sx, sz);
      if (foot < 0.4) continue;              // flecks can't visibly float
      if (it.maxY - it.minY < 0.2 && foot > 12) continue; // ground decals/pads
      const cx = (it.minX + it.maxX) * 0.5;
      const cz = (it.minZ + it.maxZ) * 0.5;
      // Ring radius from the piece's NARROW axis, capped: a palm's crown is 7 m
      // across but it stands on a trunk, and a 3.5 m uphill sample would hide a
      // real floater behind the hillside.
      const rr = Math.min(2, Math.max(0.25, Math.min(sx, sz) * 0.5));
      let ground = null;
      for (const [ox, oz] of RING) {
        const y = sample(cx + ox * rr, cz + oz * rr);
        if (y === null) continue;
        if (ground === null || y > ground) ground = y;
      }
      if (ground === null) continue;         // offshore / outside the mesh
      if (it.minY < -1) continue;            // submerged skirts
      checked++;
      const gap = it.minY - ground;
      if (gap > limit) {
        const row = { tag: it.tag, x: +cx.toFixed(1), z: +cz.toFixed(1), foot: +foot.toFixed(2), minY: +it.minY.toFixed(2), ground: +ground.toFixed(2), gap: +gap.toFixed(2) };
        if (CLAIMED.test(it.tag)) {
          rows.push(row);
        } else {
          const entry = bidDesign(it.tag);
          if (entry) {
            const slot = out.vocabulary.find((v) => v.pattern === String(entry.re));
            if (slot) slot.count += 1;
            byDesign.push(row);
          } else {
            unaccounted.push(row);
          }
        }
      }
    }
    // Second contract: no ground cover inside a building's floor. Blades came
    // up through the tavern's floorboards and out of tent canvas.
    let indoorBlades = 0;
    if (island.tavern) {
      const tx = island.tavern.position.x - island.position.x;
      const tz = island.tavern.position.z - island.position.z;
      for (const layer of ['island-grass', 'island-ferns']) {
        const mesh = group.getObjectByName(layer);
        if (!mesh || !mesh.isInstancedMesh) continue;
        const m = mesh.instanceMatrix.array;
        for (let i = 0; i < mesh.count; i++) {
          const dx = m[i * 16 + 12] - tx;
          const dz = m[i * 16 + 14] - tz;
          // Well inside the shell: the disc the scatter masks is wider, and a
          // tuft at the doorstep is fine.
          if (dx * dx + dz * dz < 3.2 * 3.2) indoorBlades++;
        }
      }
    }
    rows.sort((a, b) => b.gap - a.gap);
    byDesign.sort((a, b) => b.gap - a.gap);
    unaccounted.sort((a, b) => b.gap - a.gap);
    out.totals.indoorBlades += indoorBlades;
    out.totals.checked += checked;
    out.totals.floaters += rows.length;
    out.totals.byDesign += byDesign.length;
    out.totals.unaccounted += unaccounted.length;
    out.islands.push({
      id: island.id, name: island.name, x: island.position.x, z: island.position.z,
      checked, rows, byDesign, unaccounted, indoorBlades,
    });
  }
  return out;
}, LIMIT);

let printed = 0;
for (const isl of report.islands) {
  if (isl.rows.length === 0) continue;
  console.log(`── ${isl.name} (${isl.id})  ${isl.checked} rendered pieces checked`);
  for (const r of isl.rows.slice(0, 14)) {
    console.log(`   ✗ ${r.tag} at local (${r.x}, ${r.z}) foot=${r.foot}m  base=${r.minY} mesh=${r.ground}  GAP=${r.gap}m`
      + `   world (${(isl.x + r.x).toFixed(1)}, ${(isl.z + r.z).toFixed(1)})`);
    printed++;
  }
  if (isl.rows.length > 14) console.log(`   … ${isl.rows.length - 14} more`);
}
// Anything with a gap that ISN'T claimed and ISN'T in the vocabulary: nobody
// has said what this piece is standing on. Listed loudly, and it fails.
const unaccounted = report.islands
  .flatMap((isl) => isl.unaccounted.map((r) => ({ ...r, island: isl.name })))
  .sort((a, b) => b.gap - a.gap);
if (unaccounted.length > 0) {
  console.log('\nUNACCOUNTED scenery with daylight under it — neither seated nor declared elevated:');
  for (const r of unaccounted.slice(0, 20)) {
    console.log(`   ✗ ${r.island}: ${r.tag} at (${r.x}, ${r.z}) base=${r.minY} mesh=${r.ground} GAP=${r.gap}m`);
  }
  if (unaccounted.length > 20) console.log(`   … ${unaccounted.length - 20} more`);
  console.log('   → either seat it on the drawn ground, or add it to ELEVATED_BY_DESIGN with the reason it stands off.');
}
if (report.totals.byDesign > 0) {
  console.log('\nelevated by design (declared, with the rock they actually rest on):');
  for (const v of report.vocabulary) {
    if (v.count === 0) continue;
    console.log(`   · ${v.count.toString().padStart(3)} × ${v.pattern}`);
    console.log(`         ${v.why}`);
  }
}
writeFileSync(`${OUT}/live-floaters.json`, JSON.stringify(report, null, 1));
console.log(`\nlive floater audit: ${report.totals.checked} rendered pieces on ${report.islands.length} islands`);
console.log(`  seated props/decor floating > ${LIMIT}m above the DRAWN ground: ${report.totals.floaters} (${printed} listed)`);
console.log(`  scenery standing off the ground with no account of why: ${report.totals.unaccounted}`);
console.log(`  ground-cover blades inside a tavern floor: ${report.totals.indoorBlades}`);
console.log(`  (elevated by design, declared: ${report.totals.byDesign})`);
console.log(`report: ${OUT}/live-floaters.json`);

await browser.close();
if (report.totals.floaters > 0 || report.totals.unaccounted > 0 || report.totals.indoorBlades > 0) process.exit(1);
console.log('OK: every seated prop and decor piece touches the ground it is drawn on,'
  + ' and every piece that stands off it says why');
