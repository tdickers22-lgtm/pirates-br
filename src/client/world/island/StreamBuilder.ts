/**
 * Water on land (b4.7a, islands-03): streams, ponds and tide pools.
 *
 *  - STREAMS ride the authored valley/gorge beds from the spring to the sea.
 *    The surface is the shared truth in `shared/locomotion.ts`
 *    (`streamSurfaceY` = the monotone bed + 0.6 m in a valley, 1.1 m in a
 *    gorge), so what you see is exactly what slows you down. Foam gathers
 *    where the bed steepens (rapids), at the bends and around the rocks that
 *    break the current; the last 12% of the run thins and fans out into a
 *    beach delta that the sand clips.
 *  - PONDS sit at the basin spill heights (`getLandformPonds`): Old Maw's
 *    crater lake, Rumrunner's freshwater pond, Castaway's northern pond.
 *  - TIDE POOLS are lit still-water insets on the authored rock shelves
 *    (they replace DecorScatter's unlit blue discs on the sand).
 *
 * ZERO new shader programs: everything here is ONE merged mesh per island on
 * the waterfall water material (`customProgramCacheKey`
 * 'pirates-waterfall-water'), kind 0 = flowing, kind 1 = still. One draw call
 * per island that has any inland water.
 */
import * as THREE from 'three';
import { getIslandLandforms, getLandformPonds, type RockShelfLandform } from '../../../shared/landforms.js';
import {
  STREAM_DELTA_U, getInlandStreams, streamHalfWidth, streamSurfaceY, type InlandStream,
} from '../../../shared/locomotion.js';
import type { IslandBuildCtx } from './context.js';

/** Same attribute layout as the waterfall WaterSink: aFlowA = (across or
 *  radial, metres travelled, aeration, kind 0 flowing / 1 still); aFlowB =
 *  (metres from the impact, half width, alpha multiplier). */
class InlandWaterSink {
  readonly pos: number[] = [];
  readonly fa: number[] = [];
  readonly fb: number[] = [];
  readonly idx: number[] = [];
  vert(x: number, y: number, z: number, u: number, vm: number, aer: number, kind: number, rim: number, halfW: number, alpha: number): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.fa.push(u, vm, aer, kind);
    this.fb.push(rim, halfW, alpha);
    return i;
  }
  quad(a: number, b: number, c: number, d: number) { this.idx.push(a, b, c, a, c, d); }
  get empty() { return this.idx.length === 0; }
  build(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('aFlowA', new THREE.Float32BufferAttribute(this.fa, 4));
    geo.setAttribute('aFlowB', new THREE.Float32BufferAttribute(this.fb, 3));
    geo.setIndex(this.idx);
    geo.computeVertexNormals();
    return geo;
  }
}

/** Deterministic 0..1 hash (no rng stream: the client has no business drawing one here). */
function hash01(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function strHash(id: string): number {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 100003;
  return h;
}

/** Centreline point + unit direction at arc fraction u (island-local). */
function along(s: InlandStream, u: number): { x: number; z: number; dx: number; dz: number } {
  const t = Math.max(0, Math.min(1, u)) * s.length;
  let i = 1;
  while (i < s.path.length - 1 && s.cum[i] < t) i++;
  const [ax, az] = s.path[i - 1], [bx, bz] = s.path[i];
  const L = Math.max(1e-6, s.cum[i] - s.cum[i - 1]);
  const f = Math.max(0, Math.min(1, (t - s.cum[i - 1]) / L));
  return { x: ax + (bx - ax) * f, z: az + (bz - az) * f, dx: (bx - ax) / L, dz: (bz - az) / L };
}

export interface InlandWaterEmitter { kind: 'stream' | 'pond'; x: number; y: number; z: number; scale: number }

const ACROSS = [-1, -0.5, 0, 0.5, 1];

function sweepStream(sink: InlandWaterSink, s: InlandStream, seed: number, emitters: InlandWaterEmitter[], ox: number, oz: number) {
  const n = Math.max(8, Math.ceil(s.length / 1.2));
  // Rocks that break the current: one every ~9 m, hashed off the stream id.
  const rocks: Array<{ u: number; a: number }> = [];
  for (let k = 1; k * 9 < s.length * (1 - STREAM_DELTA_U); k++) {
    rocks.push({ u: (k * 9 + (hash01(seed, k) - 0.5) * 4) / s.length, a: (hash01(seed + 3, k) - 0.5) * 1.4 });
  }
  let prevRow: number[] | null = null;
  let loudest = { u: 0.5, grade: -1 };
  for (let k = 0; k <= n; k++) {
    const u = k / n;
    const surf = streamSurfaceY(s, u);
    if (surf < 0.06 && k > 0) {
      // The delta's last row lies on the beach at the waterline.
      emitRow(u, 0.06, true);
      break;
    }
    emitRow(u, surf, false);
  }
  emitters.push((() => {
    const p = along(s, loudest.u);
    return { kind: 'stream' as const, x: p.x + ox, y: streamSurfaceY(s, loudest.u), z: p.z + oz, scale: THREE.MathUtils.clamp(s.rec.floorWidth / 3, 0.6, 1.4) };
  })());

  function emitRow(u: number, y: number, last: boolean) {
    const p = along(s, u);
    const du = 1.5 / s.length;
    const grade = (streamSurfaceY(s, u - du) - streamSurfaceY(s, u + du)) / 3;
    if (grade > loudest.grade && u < 1 - STREAM_DELTA_U) loudest = { u, grade };
    const delta = Math.max(0, (u - (1 - STREAM_DELTA_U)) / STREAM_DELTA_U);
    const hw = streamHalfWidth(s, Math.min(u, 1 - STREAM_DELTA_U)) * 1.12 * (1 + 2.2 * delta);
    // Bends: foam where the polyline turns (the current piles on the outer bank).
    let bend = 0;
    for (let i = 1; i < s.path.length - 1; i++) {
      const d = Math.abs(u * s.length - s.cum[i]);
      if (d < 4) bend = Math.max(bend, 1 - d / 4);
    }
    const row: number[] = [];
    for (const a of ACROSS) {
      let aer = THREE.MathUtils.clamp(grade * 3.2, 0, 0.85) + bend * 0.35 * (0.5 + 0.5 * Math.abs(a)) + 0.08;
      for (const r of rocks) {
        const ds = (u - r.u) * s.length, da = (a - r.a) * hw;
        aer += 0.75 * Math.exp(-(ds * ds + da * da) / 2.2);
      }
      aer = Math.min(1, aer + delta * 0.25);
      const alpha = last ? 0 : 1 - delta * 0.55;
      row.push(sink.vert(p.x - p.dz * a * hw, y + 0.03, p.z + p.dx * a * hw, a, u * s.length, aer, 0, 6, hw, alpha));
    }
    if (prevRow) for (let j = 0; j + 1 < row.length; j++) sink.quad(prevRow[j], prevRow[j + 1], row[j + 1], row[j]);
    prevRow = row;
  }
}

/** A still disc (pond or tide pool): rings out to `radius`, radial u for the edge fade. */
function stillDisc(sink: InlandWaterSink, cx: number, y: number, cz: number, radius: number, aerRim: number, segs: number) {
  const rings = [0, 0.35, 0.65, 0.88, 1];
  const ids: number[][] = [];
  for (const f of rings) {
    const row: number[] = [];
    const count = f === 0 ? 1 : segs;
    for (let i = 0; i < count; i++) {
      const a = (i / segs) * Math.PI * 2;
      const rr = f * radius;
      row.push(sink.vert(cx + Math.cos(a) * rr, y, cz + Math.sin(a) * rr, f, rr, 0.1 + aerRim * f * f, 1, 3 + rr, radius, 1));
    }
    ids.push(row);
  }
  for (let r = 1; r < ids.length; r++) {
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % segs;
      if (r === 1) sink.idx.push(ids[0][0], ids[1][j], ids[1][i]);
      else sink.quad(ids[r - 1][i], ids[r - 1][j], ids[r][j], ids[r][i]);
    }
  }
}

/**
 * Build the island's inland water into ONE mesh on the shared waterfall
 * material. `getWaterMaterial` is only called when there is water to draw, so
 * a dry island creates no material at all.
 */
export function buildInlandWater(ctx: IslandBuildCtx, getWaterMaterial: () => THREE.Material): InlandWaterEmitter[] {
  const { island, group, lowDetail } = ctx;
  const sink = new InlandWaterSink();
  const emitters: InlandWaterEmitter[] = [];
  const ox = island.position.x, oz = island.position.z;
  for (const s of getInlandStreams(island)) sweepStream(sink, s, strHash(s.id), emitters, ox, oz);
  for (const p of getLandformPonds(island)) {
    stillDisc(sink, p.x, p.y + 0.02, p.z, p.radius, 0.3, lowDetail ? 20 : 32);
    emitters.push({ kind: 'pond', x: p.x + ox, y: p.y, z: p.z + oz, scale: THREE.MathUtils.clamp(p.radius / 10, 0.4, 1.2) });
  }
  for (const r of getIslandLandforms(island)) {
    if (r.kind !== 'rock_shelf') continue;
    const shelf = r as RockShelfLandform;
    const h = strHash(shelf.id);
    const count = shelf.radius >= 5 ? 3 : 2;
    for (let i = 0; i < count; i++) {
      const a = hash01(h, i) * Math.PI * 2;
      const d = shelf.radius * (0.2 + 0.35 * hash01(h + 1, i));
      const pr = 0.55 + 0.45 * hash01(h + 2, i);
      stillDisc(sink, shelf.center[0] + Math.cos(a) * d, shelf.y + 0.03, shelf.center[1] + Math.sin(a) * d, pr, 0.55, 14);
    }
  }
  if (sink.empty) return emitters;
  const mesh = new THREE.Mesh(sink.build(), getWaterMaterial());
  mesh.name = 'inland-water';
  mesh.renderOrder = 3;
  mesh.userData.inlandWater = { streams: getInlandStreams(island).length, ponds: getLandformPonds(island).length };
  group.add(mesh);
  return emitters;
}
