#!/usr/bin/env node
// WHY A PIECE IS STILL N DRAW CALLS — the merge-blocker census.
//
// `collapseStaticMeshes` (src/client/world/island/StaticBatcher.ts) exists to
// turn a pier into four calls, and its own header says it does. The attribution
// says otherwise: `decor-dock` is 32-40 visible calls on a single island and is
// the #1 row on every island in every scene. Something in that subtree is
// failing `isMergeable`, and the draw report cannot say what — it stops one
// level below the detail root, and the answer is four levels down.
//
// So walk each placed piece and, for every mesh in it, report the FIRST reason
// the batcher would refuse it: named / has children / has userData / instanced /
// skinned / multi-material / invisible. Then group the refusals, because the fix
// for "eleven meshes refused for being named by a GLB exporter nobody reads the
// names of" is not the fix for "two meshes refused for carrying userData".
//
// Counts only, one page, one join. Nothing here is timed.
//
//   PIRATES_GL=swiftshader node scripts/perf-decor-census.mjs --url http://127.0.0.1:3101
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { browserArgs, describeGl } from './lib/browser-args.mjs';
import { sessionQuery } from './perf-probe.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const URL = arg('url', 'http://127.0.0.1:3101').replace(/\/$/, '');
const QUALITY = arg('quality', 'low');
const OUT = arg('out', null);
const PIECES = Number.parseInt(arg('pieces', '18'), 10);
const VIEWPORT = { width: 960, height: 540 };

/**
 * Every mesh under every placed piece of every island, with the batcher's own
 * verdict on it.
 *
 * The predicate is a TRANSCRIPTION of `isMergeable`, in the same order, so a row
 * saying "named" means the batcher's `if (mesh.name) return false` is the line
 * that fired. Keeping them in step is the point: a reason this report invents
 * would send the fix at a check that is not there.
 */
const CENSUS = () => {
  const g = window.__piratesBR;
  const blocker = (n) => {
    if (!n.isMesh) return n.isPoints || n.isLine || n.isSprite ? 'not-a-mesh' : null;
    if (n.isInstancedMesh) return 'instanced';
    if (n.isSkinnedMesh) return 'skinned';
    if (n.name) return 'named';
    if (n.children.length > 0) return 'has-children';
    if (!n.visible) return 'invisible';
    if (Array.isArray(n.material)) return 'multi-material';
    if (!n.geometry || !n.geometry.attributes.position) return 'no-position';
    if (n.geometry.morphAttributes && Object.keys(n.geometry.morphAttributes).length > 0) return 'morphed';
    if (n.userData && Object.keys(n.userData).length > 0) return 'userdata:' + Object.keys(n.userData).join('+');
    return null; // mergeable
  };
  const drawable = (n) => !!(n.isMesh || n.isPoints || n.isLine || n.isSprite);

  const pieces = [];
  for (const [id, group] of g.islandMeshes ?? []) {
    const st = g.state.islands.find((i) => i.id === id);
    const detailRoot = group.userData.detailRoot ?? null;
    if (!detailRoot) continue;
    for (const child of detailRoot.children) {
      const rows = [];
      const walk = (n) => {
        if (drawable(n)) {
          const geo = n.geometry;
          const count = geo && geo.index ? geo.index.count : (geo && geo.attributes.position ? geo.attributes.position.count : 0);
          rows.push({
            name: n.name || `(${n.type})`,
            type: n.type,
            blocker: blocker(n),
            mat: (Array.isArray(n.material) ? n.material[0] : n.material)?.uuid ?? '?',
            tris: Math.round(count / 3) * (n.isInstancedMesh ? n.count : 1),
          });
        }
        for (const c of n.children) walk(c);
      };
      walk(child);
      if (rows.length === 0) continue;
      // THE FLOOR NO MERGE RULE CAN GO BELOW. A batch is one mesh per material,
      // so a piece whose meshes all carry DIFFERENT materials cannot be reduced
      // by one call however permissive the predicate gets — `mergeGeometries` is
      // not the answer to it, an atlas is. Say so per row, or the next reader
      // spends a day loosening a predicate that is already open.
      const matCount = new Map();
      for (const r of rows) matCount.set(r.mat, (matCount.get(r.mat) ?? 0) + 1);
      for (const r of rows) if (matCount.get(r.mat) === 1) r.soleOfMaterial = true;
      pieces.push({
        island: st?.name ?? id,
        piece: child.name || `(${child.type})`,
        draws: rows.length,
        materials: matCount.size,
        rows,
      });
    }
  }
  pieces.sort((a, b) => b.draws - a.draws);
  return pieces;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Decor merge-blocker census — GL: ${describeGl()}  quality=${QUALITY}`);
  const browser = await chromium.launch({ args: browserArgs(['--mute-audio']) });
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    page.on('pageerror', (e) => console.error(`  [pageerror] ${String(e.message).slice(0, 240)}`));
    await page.goto(`${URL}/?${sessionQuery(['debug', `quality=${QUALITY}`])}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
    await page.click('#menu-solo-btn', { noWaitAfter: true });
    await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 240_000 });
    await sleep(14_000);

    const pieces = await page.evaluate(CENSUS);

    // Per PIECE TYPE, because a dock is a dock on every island and the fix is
    // one edit to one builder.
    const byType = new Map();
    for (const p of pieces) {
      const cur = byType.get(p.piece) ?? { piece: p.piece, copies: 0, draws: 0, materials: 0, blockers: {} };
      cur.copies += 1;
      cur.draws += p.draws;
      cur.materials += p.materials;
      for (const r of p.rows) {
        const key = r.soleOfMaterial ? 'sole-of-material' : (r.blocker ?? 'MERGEABLE');
        cur.blockers[key] = (cur.blockers[key] ?? 0) + 1;
      }
      byType.set(p.piece, cur);
    }
    const types = [...byType.values()].sort((a, b) => b.draws / b.copies - a.draws / a.copies);

    console.log('\n  draws/copy  mats/copy  copies  piece                      blockers');
    for (const t of types.slice(0, PIECES)) {
      const per = (t.draws / t.copies).toFixed(1);
      const mats = (t.materials / t.copies).toFixed(1);
      const b = Object.entries(t.blockers)
        .sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${k}×${v}`)
        .join(' ');
      console.log(`  ${per.padStart(10)}  ${mats.padStart(9)}  ${String(t.copies).padStart(6)}  ${t.piece.padEnd(26)} ${b}`);
    }

    const worst = pieces[0];
    if (worst) {
      console.log(`\n  worst single piece: ${worst.piece} on ${worst.island} — ${worst.draws} draws`);
      const seen = new Map();
      for (const r of worst.rows) {
        const key = `${r.name}|${r.blocker}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
      for (const [key, n] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24)) {
        const [name, blocker] = key.split('|');
        console.log(`    ${String(n).padStart(3)}×  ${name.padEnd(30)} ${blocker}`);
      }
    }

    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), quality: QUALITY, types, pieces }, null, 2));
      console.log(`\nwrote ${OUT}`);
    }
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
