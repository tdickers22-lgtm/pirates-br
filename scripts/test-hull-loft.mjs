#!/usr/bin/env node
// THE LOFT SNAPSHOT GATE (DECK-01 / ships-24 phase 1).
//
// src/shared/hull.ts is the renderer's hull loft, moved into shared/ so the
// server can stand crew on the same shape it draws. A move like that is only
// safe if it is BIT-IDENTICAL: a silently reshaped hull would move gunports,
// hole decals, the covering board and (once phase 2 lands) the collision
// footprint, and every one of those changes reads as "the ship looks fine" in a
// screenshot. So this gate pins every derived number the loft produces against
// scripts/fixtures/hull-loft.snapshot.json, captured from the pre-move renderer
// (max |delta| 0 over 975 numbers at the time of the move).
//
// It also holds the two invariants the loft has to keep for gameplay:
//  • the loft SHEER stays OUTBOARD of the shared walk taper at every station,
//    so the deck clamp can never strand a pirate past a rendered line;
//  • nothing outside src/shared/hull.ts re-declares LOFT_STATIONS — a second
//    copy is exactly the four-hand-kept-tables bug this move exists to end.
import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getHullProfile, hullSurfacePointAt, LOFT_STATIONS } from '../src/shared/hull.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { getShipDeckWalkHalfWidth } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const snap = JSON.parse(readFileSync(new URL('./fixtures/hull-loft.snapshot.json', import.meta.url), 'utf8'));
const TYPES = ['sloop', 'brigantine', 'galleon'];
const SURF_Z = [-0.5, -0.3, -0.1, 0.1, 0.3, 0.45, 0.5];
const SURF_Y = [0, 0.25, 0.5, 0.75, 1.0];

console.log('— loft snapshot: derived shape is bit-identical to the pre-move renderer —');
for (const type of TYPES) {
  const want = snap[type];
  const p = getHullProfile(type);
  let worst = 0;
  let worstAt = '';
  const rec = (a, b, where) => { const d = Math.abs(a - b); if (d > worst) { worst = d; worstAt = where; } };
  rec(p.W, want.W, 'W'); rec(p.H, want.H, 'H'); rec(p.L, want.L, 'L'); rec(p.draft, want.draft, 'draft');
  expect(`${type}: station count ${p.stations.length}`, p.stations.length === want.stations.length,
    `got ${p.stations.length}, snapshot ${want.stations.length}`);
  for (let i = 0; i < Math.min(p.stations.length, want.stations.length); i++) {
    const a = p.stations[i], b = want.stations[i];
    rec(a.baseZ, b.baseZ, `st${i}.baseZ`); rec(a.sheerY, b.sheerY, `st${i}.sheerY`); rec(a.keelY, b.keelY, `st${i}.keelY`);
    for (let k = 0; k < a.slots.length; k++) {
      rec(a.slots[k].x, b.slots[k][0], `st${i}.slot${k}.x`);
      rec(a.slots[k].y, b.slots[k][1], `st${i}.slot${k}.y`);
      rec(a.slots[k].z, b.slots[k][2], `st${i}.slot${k}.z`);
    }
  }
  let s = 0;
  for (const zf of SURF_Z) for (const yf of SURF_Y) {
    const r = hullSurfacePointAt(p, zf * p.L, yf * p.H);
    rec(r.x, want.surface[s][0], `surface z=${zf} y=${yf} .x`);
    rec(r.nx, want.surface[s][1], `surface z=${zf} y=${yf} .nx`);
    rec(r.ny, want.surface[s][2], `surface z=${zf} y=${yf} .ny`);
    s += 1;
  }
  expect(`${type}: every derived number matches the snapshot (max |delta| ${worst.toExponential(2)})`,
    worst <= 1e-12, `worst at ${worstAt} = ${worst}`);
}

console.log('— standing contract: the drawn deck edge is never inboard of the walk clamp —');
for (const type of TYPES) {
  const stats = SHIP_STATS[type];
  const p = getHullProfile(type);
  let tightest = Infinity;
  let tightestZ = 0;
  // Sample the knots AND the crossings between them, in W units.
  for (let i = 0; i <= 400; i++) {
    const zf = -0.5 + i / 400;
    const sheerHalf = hullSurfacePointAt(p, zf * p.L, p.stations[3].sheerY).x;
    const walkHalf = getShipDeckWalkHalfWidth(stats, zf * stats.length);
    const marginW = (sheerHalf - walkHalf) / stats.width;
    if (marginW < tightest) { tightest = marginW; tightestZ = zf; }
  }
  expect(`${type}: loft sheer outboard of the walk taper everywhere (tightest ${tightest.toFixed(4)} W at z=${tightestZ.toFixed(3)} L)`,
    tightest >= -0.001, `tightest margin ${tightest} W at z=${tightestZ} L`);
}

console.log('— single source: no second LOFT_STATIONS anywhere in src/ —');
const hits = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.tsx?$/.test(name)) continue;
    if (full.endsWith('src/shared/hull.ts')) continue;
    const text = readFileSync(full, 'utf8');
    if (/\b(const|let|var)\s+LOFT_STATIONS\b/.test(text)) hits.push(full);
  }
})(new URL('../src', import.meta.url).pathname);
expect('LOFT_STATIONS is declared only in src/shared/hull.ts', hits.length === 0, `also declared in: ${hits.join(', ')}`);

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log('\nPASS: the shared loft is the renderer\'s loft, to the last bit.');
