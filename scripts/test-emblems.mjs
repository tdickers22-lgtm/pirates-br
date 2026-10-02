#!/usr/bin/env node
/**
 * test-emblems (b4.3e; crossdevice-15, PLAN D33): crew identity never relies on hue alone.
 *
 *  1. [set]     twelve distinct emblem ids (>= CREW_PALETTE), each with real geometry inside the
 *               unit box; palette dye -> emblem is injective.
 *  2. [shape]   every emblem rasterised at 24 px (a hull at range) and 48 px: ink coverage in
 *               [0.12, 0.62] of its box, and every PAIR differs as a silhouette: IoU <= IOU_MAX,
 *               also against the mirror image (a sail seen from behind shows it flipped).
 *  3. [match]   no two crews in a match share an emblem: the greedy pickCrewColor deal for every
 *               mode's crew count, every late join after every founder, and 300 seeded churn steps.
 *  4. [determ]  emblemForCrew is a pure function of (dye, crew id); off-palette dyes hash the id.
 *  5. [layer]   the REAL sailTexture(dye) and flagTexture(dye) paint the crew's emblem (every part
 *               traced at SAIL_EMBLEM / FLAG_EMBLEM, recorded through a 2D-context recorder), the
 *               sail with a dark rim, the flag in an ink with WCAG contrast >= 3 against the dye;
 *               the untinted sail paints none; two crews' sails paint different emblems.
 *  6. [wiring]  flagTexture has no Math.random (every client paints the same ensign); textures.ts
 *               calls drawSailEmblem; ShipRenderer builds ensign + sails from the crew dye.
 *
 * Run: node --import tsx scripts/test-emblems.mjs   (--prove: a mutated set must go red)
 */
import fs from 'node:fs';

// Recording 2D context, installed BEFORE any client import.
function recorder() {
  const log = [];
  const state = { fillStyle: '#000', strokeStyle: '#000' };
  const ctx = new Proxy(state, {
    get: (t, k) => {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (k === 'measureText') return () => ({ width: 0 });
      if (k in t) return t[k];
      if (typeof k !== 'string') return undefined;
      return (...args) => { log.push({ op: k, args, fill: t.fillStyle, stroke: t.strokeStyle }); };
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
  return { ctx, log };
}
const mkCanvas = () => { const r = recorder(); return { width: 0, height: 0, __log: r.log, getContext: () => r.ctx, toDataURL: () => '' }; };
globalThis.document = { createElement: mkCanvas, createElementNS: mkCanvas };
globalThis.window = globalThis;

const E = await import('../src/client/rendering/ship/emblems.ts');
const { CREW_PALETTE, pickCrewColor } = await import('../src/shared/crewPalette.ts');
const { MODES } = await import('../src/shared/constants/index.ts');
const { sailTexture } = await import('../src/client/rendering/ship/textures.ts');
const { flagTexture } = await import('../src/client/rendering/ship/dressing.ts');

const PROVE = process.argv.includes('--prove');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${msg}`); } };
const hex = (c) => '0x' + c.toString(16).toUpperCase().padStart(6, '0');
const IOU_MAX = 0.6;

const EMBLEMS = PROVE ? { ...E.EMBLEMS, kraken: E.EMBLEMS.skull } : E.EMBLEMS;
const IDS = [...E.EMBLEM_IDS];

// 1. The set.
ok(IDS.length >= CREW_PALETTE.length, `[set] ${IDS.length} emblems for ${CREW_PALETTE.length} crew dyes`);
ok(new Set(IDS).size === IDS.length, '[set] emblem ids unique');
for (const id of ['skull', 'anchor', 'star', 'crossed_swords', 'compass_rose', 'kraken', 'crown', 'bell']) ok(IDS.includes(id), `[set] ${id} present`);
for (const id of IDS) {
  const parts = EMBLEMS[id];
  ok(Array.isArray(parts) && parts.some((p) => !p.hole), `[set] ${id} has ink parts`);
  const out = (parts ?? []).flatMap((p) => p.pts).filter(([x, y]) => Math.abs(x) > 1.02 || Math.abs(y) > 1.02);
  ok(out.length === 0, `[set] ${id} inside the unit box (${out.length} points out)`);
}
const dealt = CREW_PALETTE.map((c) => E.emblemForCrew(c));
ok(new Set(dealt).size === CREW_PALETTE.length, `[set] palette -> emblem injective (${new Set(dealt).size}/${CREW_PALETTE.length})`);

// 2. Silhouettes (even-odd per part, parts in order, holes paint background).
function inside(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function raster(id, R, mirror = false) {
  const m = new Uint8Array(R * R);
  for (let r = 0; r < R; r++) for (let q = 0; q < R; q++) {
    let x = -1 + (2 * (q + 0.5)) / R; const y = -1 + (2 * (r + 0.5)) / R;
    if (mirror) x = -x;
    let v = 0;
    for (const p of EMBLEMS[id]) if (inside(p.pts, x, y)) v = p.hole ? 0 : 1;
    m[r * R + q] = v;
  }
  return m;
}
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { i += a[k] & b[k]; u += a[k] | b[k]; } return u ? i / u : 1; };
let worst = { v: 0, pair: '' };
for (const R of [24, 48]) {
  const m = Object.fromEntries(IDS.map((id) => [id, raster(id, R)]));
  const mm = Object.fromEntries(IDS.map((id) => [id, raster(id, R, true)]));
  for (const id of IDS) {
    const cov = m[id].reduce((s, v) => s + v, 0) / (R * R);
    ok(cov >= 0.12 && cov <= 0.62, `[shape] ${id} coverage ${cov.toFixed(2)} at ${R} px in [0.12, 0.62]`);
  }
  for (let i = 0; i < IDS.length; i++) for (let j = i + 1; j < IDS.length; j++) {
    const v = Math.max(iou(m[IDS[i]], m[IDS[j]]), iou(m[IDS[i]], mm[IDS[j]]));
    if (v > worst.v) worst = { v, pair: `${IDS[i]}/${IDS[j]} @${R}` };
    ok(v <= IOU_MAX, `[shape] ${IDS[i]} vs ${IDS[j]} IoU ${v.toFixed(2)} at ${R} px <= ${IOU_MAX}`);
  }
}
console.log(`  [shape] worst pair IoU ${worst.v.toFixed(3)} (${worst.pair})`);

// 3. No two crews in one match share an emblem.
const emblemsOf = (dyes) => dyes.map((c) => E.emblemForCrew(c));
const distinct = (a) => new Set(a).size === a.length;
for (const [mode, spec] of Object.entries(MODES)) {
  const dyes = [];
  for (let k = 0; k < spec.crews; k++) dyes.push(pickCrewColor(dyes));
  ok(distinct(emblemsOf(dyes)), `[match] ${mode} ${spec.crews} crews: ${emblemsOf(dyes).join(',')}`);
  for (let f = 0; f < dyes.length; f++) {
    const left = dyes.filter((_, i) => i !== f);
    left.push(pickCrewColor(left));
    ok(distinct(emblemsOf(left)), `[match] ${mode} late join after founder ${f}`);
  }
}
let s = 20260801 >>> 0;
const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
let afloat = [], churnBad = 0;
for (let step = 0; step < 300; step++) {
  if (afloat.length < 12 && (afloat.length === 0 || rnd() < 0.6)) afloat.push(pickCrewColor(afloat));
  else afloat.splice(Math.floor(rnd() * afloat.length), 1);
  if (!distinct(emblemsOf(afloat))) churnBad++;
}
ok(churnBad === 0, `[match] 300 join/founder churn steps: ${churnBad} with a shared emblem`);

// 4. Determinism.
for (const c of CREW_PALETTE) ok(E.emblemForCrew(c) === E.emblemForCrew(c, 'crew-x'), `[determ] ${hex(c)} keyed on the dye`);
const off = 0x123456;
ok(E.emblemForCrew(off, 'crew-7') === E.emblemForCrew(off, 'crew-7'), '[determ] off-palette dye stable per crew id');
const offIds = new Set(Array.from({ length: 24 }, (_, i) => E.emblemForCrew(off, `crew-${i}`)));
ok(offIds.size >= 6, `[determ] off-palette fallback hashes the crew id (${offIds.size} emblems over 24 ids)`);

// 5. The sail and flag layers, through the real painters.
const firstPts = (id, at) => EMBLEMS[id].map((p) => [at.cx + p.pts[0][0] * at.half, at.cy + p.pts[0][1] * at.half]);
const moveTos = (log) => log.filter((e) => e.op === 'moveTo').map((e) => e.args);
const hits = (log, id, at) => {
  const mv = moveTos(log);
  return firstPts(id, at).filter(([x, y]) => mv.some(([a, b]) => Math.abs(a - x) < 1e-6 && Math.abs(b - y) < 1e-6)).length;
};
const wcag = (a, b) => { const [x, y] = [a, b].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const parseHex = (h) => parseInt(h.slice(1), 16);
for (const c of CREW_PALETTE) {
  const id = E.emblemForCrew(c);
  const n = EMBLEMS[id].length;
  const sail = sailTexture(c).image.__log;
  ok(hits(sail, id, E.SAIL_EMBLEM) === n, `[layer] sail ${hex(c)} paints ${id} (${hits(sail, id, E.SAIL_EMBLEM)}/${n} parts)`);
  ok(sail.some((e) => e.op === 'stroke' && /rgba\(36,26,14/.test(String(e.stroke))), `[layer] sail ${hex(c)} emblem has a dark rim`);
  const flag = flagTexture(c).image.__log;
  ok(hits(flag, id, E.FLAG_EMBLEM) === n, `[layer] flag ${hex(c)} paints ${id} (${hits(flag, id, E.FLAG_EMBLEM)}/${n} parts)`);
  const ink = E.inkOn(c);
  ok(flag.some((e) => e.op === 'fill' && e.fill === ink), `[layer] flag ${hex(c)} inks the emblem in ${ink}`);
  ok(wcag(E.dyeLuminance(parseHex(ink)), E.dyeLuminance(c)) >= 3, `[layer] flag ${hex(c)} ink contrast ${wcag(E.dyeLuminance(parseHex(ink)), E.dyeLuminance(c)).toFixed(2)} >= 3`);
}
const plain = sailTexture().image.__log;
ok(IDS.every((id) => hits(plain, id, E.SAIL_EMBLEM) < EMBLEMS[id].length), '[layer] untinted sail paints no emblem');
const [c0, c1] = CREW_PALETTE;
const s1 = sailTexture(c1).image.__log;
ok(hits(s1, E.emblemForCrew(c0), E.SAIL_EMBLEM) < EMBLEMS[E.emblemForCrew(c0)].length, `[layer] crew ${hex(c1)} sail does not carry crew ${hex(c0)}'s emblem`);

// 6. Wiring.
const dressing = fs.readFileSync(new URL('../src/client/rendering/ship/dressing.ts', import.meta.url), 'utf8');
const flagFn = dressing.slice(dressing.indexOf('export function flagTexture'), dressing.indexOf('/** Drives the flag'));
ok(flagFn.length > 100 && !/Math\.random/.test(flagFn), '[wiring] flagTexture paints from a seed (no Math.random)');
ok(/drawFlagEmblem\(ctx, teamColor\)/.test(flagFn), '[wiring] flagTexture calls drawFlagEmblem');
const textures = fs.readFileSync(new URL('../src/client/rendering/ship/textures.ts', import.meta.url), 'utf8');
ok(/drawSailEmblem\(ctx, teamColor\)/.test(textures), '[wiring] sailTexture calls drawSailEmblem');
const sr = fs.readFileSync(new URL('../src/client/rendering/ShipRenderer.ts', import.meta.url), 'utf8');
ok(/map: flagTexture\(ship\.teamColor\)/.test(sr) && /sailTexture\(teamColor\)/.test(sr), '[wiring] ShipRenderer builds the ensign and sails from the crew dye');

console.log(`${fail ? 'FAIL' : 'PASS'} test-emblems: ${pass} passed, ${fail} failed${PROVE ? ' (--prove: a red run is the expected result)' : ''}`);
process.exit(fail ? 1 : 0);
