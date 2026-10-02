/**
 * Cliff kit placement (b4.6d; islands-02, islands-08, islands-12, islands-14).
 *
 * Puts the Blender cliff kit (build_cliff_kit.py; colliders in src/shared/generated/kitColliders.json)
 * on the static world as `island.kitPieces` in WORLD coordinates. Every consumer (walker, swimmer,
 * prediction, hitscan, cannon rays, ship hull stations) reads them through src/shared/hullCollide.ts;
 * the client draws them in src/client/world/island/CliffKitBuilder.ts.
 *
 * Determinism (PLAN rule 6): each island draws from its OWN stream, mulberry32(profile.seed ^ KIT_STREAM),
 * placed after every existing island stream; no draw is added to islandRng, the story/camp streams or the
 * match stream. Runs once per world from MapGenerator.generateIslands, after the per-island content, so
 * every placement can keep clear of docks, taverns, cave mouths, stamps, loot and NPCs.
 *
 * Rules:
 *  - cliff faces / overhangs on coast arcs where coast.cliff > 0.6 and along authored landform scarps,
 *    back plane set into the hill (front faces the sea / the low side), scaled to the wall height;
 *    the first slot on every cliff island is an overhang (>= 1 overhang per cliff island);
 *  - rock shelves on the waterline of rocky / bone islands (>= 1 each);
 *  - sea arches: every authored arch_site gets one (deep water -> sail-through sea_arch_a, else the
 *    land bridge sea_arch_b); if the world still has < 2 sail-through arches, sea_arch_a goes offshore of
 *    the longest cliff arcs. sea_arch_a stays at y = 0 (its clearance is graded from the waterline);
 *  - strata slabs, spires and reefs replace the old TerrainFeatures primitives (same island rules);
 *  - kit sea stacks (searock_d..g), one silhouette never repeated within STACK_REPEAT_M.
 */
import type { Island } from '../../../shared/types/index.js';
import { getIslandCoastWeights, getIslandMaxRadius, getIslandSurfaceY, mulberry32 } from '../../../shared/utils/index.js';
import { getIslandLandforms, getLandformArchSites, getLandformLadders, type ScarpLandform } from '../../../shared/landforms.js';
import { getKitColliders, type KitPieceInstance, type KitPlacedIsland } from '../../../shared/hullCollide.js';

export const KIT_STREAM = 0xc11ff417;
/** No kit sea-stack silhouette repeats inside this distance (islands-14). */
export const STACK_REPEAT_M = 250;
const STACK_KEYS = ['searock_d', 'searock_e', 'searock_f', 'searock_g'] as const;
const FACE_KEYS = ['cliff_face_a', 'cliff_face_b', 'cliff_face_c'] as const;
const OVERHANG_KEYS = ['cliff_overhang_a', 'cliff_overhang_b'] as const;
const CLIFF_ARC_MIN = 0.6;
const ANGLE_STEPS = 96;
/** Galleon draft plus margin: every sample under a sail-through arch must be at least this deep. */
const ARCH_DEPTH = -4.5;

type Rng = () => number;
type Pick = { key: string; x: number; z: number; r: number };

const radiusOf = (key: string, scale = 1): number => (getKitColliders(key)?.radiusXZ ?? 4) * scale;
/** yaw whose local +Z points along the world direction (dx, dz) (hullCollide convention). */
const yawTo = (dx: number, dz: number): number => Math.atan2(dx, dz);
const round = (v: number): number => Math.round(v * 1000) / 1000;

class IslandPlacer {
  readonly pieces: KitPieceInstance[] = [];
  private readonly blocked: Array<{ x: number; z: number; r: number }> = [];
  readonly R: number;
  readonly cx: number;
  readonly cz: number;

  constructor(readonly island: Island, readonly rng: Rng, private readonly world: Pick[]) {
    this.R = getIslandMaxRadius(island);
    this.cx = island.position.x;
    this.cz = island.position.z;
    const b = (p: { x: number; z: number } | null | undefined, r: number) => { if (p) this.blocked.push({ x: p.x, z: p.z, r }); };
    b(island.dock?.position, 42);
    b(island.dock?.berthPosition, 48);
    b(island.dock?.respawnPoint, 10);
    b(island.tavern?.position, 26);
    for (const c of island.caves) if (c.hasMouth !== false) b(c.position, 16);
    for (const s of island.stamps ?? []) this.blocked.push({ x: s.x, z: s.z, r: s.radius + 4 });
    for (const e of [...island.chests, ...island.barrels, ...island.upgradeStations]) b(e.position, 4);
    for (const n of island.npcs) b(n.position, 5);
    for (const g of island.geysers ?? []) b(g, g.radius + 6);
    for (const br of island.bridges ?? []) { b({ x: br.ax, z: br.az }, 8); b({ x: br.bx, z: br.bz }, 8); }
    for (const l of getLandformLadders(island)) b({ x: l.x + this.cx, z: l.z + this.cz }, 8);
  }

  y(x: number, z: number): number {
    return getIslandSurfaceY(this.island, x, z);
  }

  clear(x: number, z: number, r: number): boolean {
    for (const o of this.blocked) if (Math.hypot(x - o.x, z - o.z) < o.r + r * 0.8) return false;
    for (const p of this.world) if (Math.hypot(x - p.x, z - p.z) < (p.r + r) * 0.8) return false;
    return true;
  }

  /** Ground samples of a piece footprint (local bounds rotated by yaw). */
  footprint(key: string, x: number, z: number, yaw: number, scale: number): number[] {
    const c = getKitColliders(key);
    const mn = c?.min ?? [-2, 0, -2];
    const mx = c?.max ?? [2, 0, 2];
    const s = Math.sin(yaw);
    const co = Math.cos(yaw);
    const out: number[] = [];
    for (const u of [0, 0.5, 1]) {
      for (const v of [0, 0.5, 1]) {
        const lx = (mn[0] + (mx[0] - mn[0]) * u) * scale;
        const lz = (mn[2] + (mx[2] - mn[2]) * v) * scale;
        out.push(this.y(x + lx * co + lz * s, z - lx * s + lz * co));
      }
    }
    return out;
  }

  add(key: string, x: number, z: number, y: number, yaw: number, scale = 1): void {
    const piece: KitPieceInstance = { key, x: round(x), y: round(y), z: round(z), yaw: round(yaw) };
    if (scale !== 1) piece.scale = round(scale);
    this.pieces.push(piece);
    this.world.push({ key, x, z, r: radiusOf(key, scale) });
  }

  /** Distance from the centre along heading a where the surface first drops below `level`. */
  shoreAt(a: number, level: number): number | null {
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let last: number | null = null;
    for (let d = this.R * 0.3; d <= this.R * 1.35; d += 0.5) {
      if (this.y(this.cx + ca * d, this.cz + sa * d) >= level) last = d;
      else if (last !== null) return last;
    }
    return last;
  }

  pickFace(first: boolean, volcanic: boolean, i: number): string {
    if (first) return OVERHANG_KEYS[Math.floor(this.rng() * OVERHANG_KEYS.length)];
    if (volcanic && i % 3 === 1) return 'basalt_columns_a';
    return FACE_KEYS[Math.floor(this.rng() * FACE_KEYS.length)];
  }

  /** A face on the coast at heading a, back plane at the mid-wall, front to the sea. */
  coastFace(a: number, first: boolean, volcanic: boolean, i: number): boolean {
    const rim = this.shoreAt(a, 0.5);
    if (rim === null) return false;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const plateau = this.y(this.cx + ca * (rim - 4), this.cz + sa * (rim - 4));
    if (plateau < (first ? 2 : 4)) return false; // a low isle still gets its overhang (a 3.5 m lip)
    const key = this.pickFace(first, volcanic, i);
    const top = getKitColliders(key)?.max[1] ?? 8;
    const scale = Math.min(1.35, Math.max(0.7, (plateau + 0.6) / top));
    // Mid-wall: where the ground is half the plateau height.
    let d = rim;
    while (d > rim - 8 && this.y(this.cx + ca * d, this.cz + sa * d) < plateau * 0.5) d -= 0.25;
    const x = this.cx + ca * d;
    const z = this.cz + sa * d;
    if (!this.clear(x, z, radiusOf(key, scale))) return false;
    this.add(key, x, z, 0, yawTo(ca, sa), scale);
    return true;
  }

  /** Faces along an authored scarp (island-local path), front to the low side. */
  scarp(rec: ScarpLandform, firstRef: { first: boolean }, volcanic: boolean): void {
    const taper = rec.taper ?? 8;
    for (let k = 0; k + 1 < rec.path.length; k++) {
      const [ax, az] = rec.path[k];
      const [bx, bz] = rec.path[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1) continue;
      const dx = (bx - ax) / len;
      const dz = (bz - az) / len;
      const nx = dz; // low side normal (the high side is cross(d, p - a) > 0)
      const nz = -dx;
      const scale = Math.min(1.3, Math.max(0.7, (rec.height + 0.6) / 8));
      const step = 11.5 * scale;
      let i = 0;
      for (let s = taper + step * 0.5; s <= len - taper - step * 0.5 + 1e-6; s += step, i++) {
        const key = this.pickFace(firstRef.first, volcanic, i);
        const half = (rec.face ?? 2) * 0.5;
        const x = this.cx + ax + dx * s - nx * half;
        const z = this.cz + az + dz * s - nz * half;
        const foot = Math.min(...[1, 3, 5].map((o) => this.y(x + nx * (half + o), z + nz * (half + o))));
        if (foot < 0.6 || !this.clear(x, z, radiusOf(key, scale))) continue;
        this.add(key, x, z, foot - 0.2, yawTo(nx, nz), scale);
        firstRef.first = false;
      }
    }
  }

  /** A seated piece at (x, z): y = lowest ground under its footprint. */
  seat(key: string, x: number, z: number, yaw: number, scale: number, minY: number, maxY: number): boolean {
    if (!this.clear(x, z, radiusOf(key, scale))) return false;
    const g = this.footprint(key, x, z, yaw, scale);
    const lo = Math.min(...g);
    if (lo < minY || lo > maxY || Math.max(...g) - lo > 2.2 * scale) return false;
    this.add(key, x, z, lo, yaw, scale);
    return true;
  }

  /** Deep enough under every footprint sample for a galleon to sail the channel. */
  archWater(x: number, z: number, yaw: number): boolean {
    if (!this.clear(x, z, radiusOf('sea_arch_a'))) return false;
    return this.footprint('sea_arch_a', x, z, yaw, 1).every((g) => g < ARCH_DEPTH)
      && [-14, 0, 14].every((t) => this.y(x + Math.sin(yaw) * t, z + Math.cos(yaw) * t) < ARCH_DEPTH);
  }
}

/** The cliff arcs (runs of headings with coast.cliff > 0.6), longest first. */
function cliffArcs(island: Island): Array<{ start: number; len: number }> {
  const on = Array.from({ length: ANGLE_STEPS }, (_, i) => getIslandCoastWeights(island, (i / ANGLE_STEPS) * Math.PI * 2).cliff > CLIFF_ARC_MIN);
  if (on.every(Boolean)) return [{ start: 0, len: ANGLE_STEPS }];
  const arcs: Array<{ start: number; len: number }> = [];
  const first = on.findIndex((v) => !v);
  for (let k = 1; k <= ANGLE_STEPS; k++) {
    const i = (first + k) % ANGLE_STEPS;
    if (!on[i]) continue;
    if (on[(i - 1 + ANGLE_STEPS) % ANGLE_STEPS] && arcs.length) arcs[arcs.length - 1].len++;
    else arcs.push({ start: i, len: 1 });
  }
  return arcs.sort((p, q) => q.len - p.len || p.start - q.start);
}

/** Place the whole kit for the world; writes island.kitPieces and returns the count per key. */
export function placeCliffKitWorld(islands: Island[]): Record<string, number> {
  const world: Pick[] = [];
  const stacks: Array<{ key: string; x: number; z: number }> = [];
  const placers = islands.map((island) => new IslandPlacer(
    island, mulberry32((((island.profile.seed ?? 0x5eed) >>> 0) ^ KIT_STREAM) >>> 0), world,
  ));
  let sailThrough = 0;
  const arcsBy = new Map<IslandPlacer, Array<{ start: number; len: number }>>();

  for (const p of placers) {
    const { island, rng } = p;
    const volcanic = island.profile.biome === 'volcanic';
    const firstRef = { first: true };
    // 1. authored arch sites.
    for (const site of getLandformArchSites(island)) {
      const x = p.cx + site.center[0];
      const z = p.cz + site.center[1];
      const out = Math.atan2(site.center[1], site.center[0]);
      const yawA = yawTo(-Math.sin(out), Math.cos(out)); // channel along the coast
      // Shallow / land sites keep their authored rock_arch landmark (stamped); only deep water takes the kit arch.
      if (p.archWater(x, z, yawA)) { p.add('sea_arch_a', x, z, 0, yawA); sailThrough++; }
    }
    // 2. coast cliff arcs: faces every ~12 m of arc, first slot an overhang.
    const arcs = cliffArcs(island);
    arcsBy.set(p, arcs);
    let placed = 0;
    for (const arc of arcs) {
      const stepA = Math.max(1, Math.round((12 / Math.max(p.R, 1)) / ((Math.PI * 2) / ANGLE_STEPS)));
      for (let k = Math.floor(stepA / 2); k < arc.len && placed < 8; k += stepA) {
        const a = ((arc.start + k) / ANGLE_STEPS) * Math.PI * 2;
        if (p.coastFace(a, firstRef.first, volcanic, placed)) { firstRef.first = false; placed++; }
      }
    }
    // 3. authored scarps.
    for (const rec of getIslandLandforms(island)) if (rec.kind === 'scarp') p.scarp(rec, firstRef, volcanic);
    // 4. rock shelves on rocky / bone waterlines.
    const rocky = island.profile.terrainStyle === 'rocky' || island.profile.biome === 'bone';
    if (rocky) {
      const order = Array.from({ length: 48 }, (_, i) => (i / 48) * Math.PI * 2)
        .sort((a, b) => getIslandCoastWeights(island, b).rocky - getIslandCoastWeights(island, a).rocky);
      let shelves = 0;
      for (const a of order) {
        if (shelves >= 2) break;
        const d = p.shoreAt(a, 0);
        if (d === null) continue;
        const key = shelves === 0 ? 'rock_shelf_a' : 'rock_shelf_b';
        // A wave-cut bench sits ON the waterline (top ~0.8 m above it) whatever the bed does below.
        const x = p.cx + Math.cos(a) * (d + 2);
        const z = p.cz + Math.sin(a) * (d + 2);
        const yaw = yawTo(Math.cos(a), Math.sin(a));
        if (!p.clear(x, z, radiusOf(key))) continue;
        const g = p.footprint(key, x, z, yaw, 1);
        if (Math.min(...g) < -4 || Math.max(...g) > 1.4) continue;
        p.add(key, x, z, -0.1, yaw);
        shelves++;
      }
    }
    // 5. strata (was buildCliffStrata's box slabs).
    if (island.profile.heightProfile > 0.35 && island.profile.terrainStyle !== 'mountain') {
      let n = 0;
      for (let t = 0; t < 24 && n < 3; t++) {
        const a = rng() * Math.PI * 2;
        const d = p.R * (0.35 + rng() * 0.35);
        const key = `strata_slab_${'abc'[n % 3]}`;
        if (p.seat(key, p.cx + Math.cos(a) * d, p.cz + Math.sin(a) * d, rng() * Math.PI * 2, 0.9 + rng() * 0.4, 1, 80)) n++;
      }
    }
    // 6. spires (was buildRockSpires' cones) on mountain / rocky isles.
    if (island.profile.terrainStyle === 'mountain' || island.profile.terrainStyle === 'rocky') {
      let n = 0;
      for (let t = 0; t < 24 && n < 3; t++) {
        const a = rng() * Math.PI * 2;
        const d = p.R * (0.3 + rng() * 0.4);
        const key = `spire_${'abc'[n % 3]}`;
        if (p.seat(key, p.cx + Math.cos(a) * d, p.cz + Math.sin(a) * d, rng() * Math.PI * 2, 0.85 + rng() * 0.3, 1, 80)) n++;
      }
    }
    // 7. reefs (was buildReefRing's cones/dodecahedra): awash, just off the shore.
    const reefs = Math.min(5, Math.max(2, Math.round(p.R / 40)));
    for (let t = 0, n = 0; t < 30 && n < reefs; t++) {
      const a = rng() * Math.PI * 2;
      const d = p.shoreAt(a, 0);
      if (d === null) continue;
      const key = `reef_${'abc'[n % 3]}`;
      for (let o = 2; o <= 14; o += 2) {
        const x = p.cx + Math.cos(a) * (d + o);
        const z = p.cz + Math.sin(a) * (d + o);
        if (p.seat(key, x, z, rng() * Math.PI * 2, 0.9 + rng() * 0.5, -1.3, -0.35)) { n++; break; }
      }
    }
  }

  // 8. sail-through quota: offshore of the longest cliff arcs.
  const byArc = [...placers].sort((a, b) => (arcsBy.get(b)?.[0]?.len ?? 0) - (arcsBy.get(a)?.[0]?.len ?? 0));
  for (const p of byArc) {
    if (sailThrough >= 2) break;
    const arc = arcsBy.get(p)?.[0];
    if (!arc || p.pieces.some((q) => q.key === 'sea_arch_a')) continue;
    for (let k = 0; k < arc.len && sailThrough < 2; k++) {
      const a = ((arc.start + ((Math.floor(arc.len / 2) + k) % arc.len)) / ANGLE_STEPS) * Math.PI * 2;
      const d0 = p.shoreAt(a, 0);
      if (d0 === null) continue;
      const yaw = yawTo(-Math.sin(a), Math.cos(a));
      let done = false;
      for (let o = 10; o <= 40 && !done; o += 3) {
        const x = p.cx + Math.cos(a) * (d0 + o);
        const z = p.cz + Math.sin(a) * (d0 + o);
        if (p.archWater(x, z, yaw)) { p.add('sea_arch_a', x, z, 0, yaw); sailThrough++; done = true; }
      }
      if (done) break;
    }
  }

  // 8b. land bridges (sea_arch_b): standing in the shallows off a cliff / rocky shore, channel
  // running shoreward so a swimmer passes under the 9 m deck. Two per world, never beside a sea_arch_a.
  let bridges = 0;
  for (const p of byArc) {
    if (bridges >= 2) break;
    if (p.pieces.some((q) => q.key.startsWith('sea_arch'))) continue;
    for (let t = 0; t < 32 && bridges < 2; t++) {
      const a = (t / 32) * Math.PI * 2 + (p.island.profile.seed ?? 0) % 7;
      if (getIslandCoastWeights(p.island, a).beach > 0.4) continue;
      const d0 = p.shoreAt(a, 0);
      if (d0 === null) continue;
      const yaw = yawTo(Math.cos(a), Math.sin(a));
      let done = false;
      for (let o = 4; o <= 22 && !done; o += 2) {
        const x = p.cx + Math.cos(a) * (d0 + o);
        const z = p.cz + Math.sin(a) * (d0 + o);
        if (!p.clear(x, z, radiusOf('sea_arch_b'))) continue;
        const g = p.footprint('sea_arch_b', x, z, yaw, 1);
        const lo = Math.min(...g);
        const hi = Math.max(...g);
        if (lo >= -3.5 && hi <= 1 && hi - lo < 4.5) { p.add('sea_arch_b', x, z, Math.max(lo, -1.5), yaw); bridges++; done = true; }
      }
      if (done) break;
    }
  }

  // 9. kit sea stacks: one or two per island on the cliff/rocky side, no silhouette repeat within 250 m.
  for (const p of placers) {
    const { island, rng } = p;
    const want = p.R > 70 ? 2 : 1;
    for (let t = 0, n = 0; t < 24 && n < want; t++) {
      const a = rng() * Math.PI * 2;
      if (getIslandCoastWeights(island, a).beach > 0.5) continue;
      const d = p.shoreAt(a, 0);
      if (d === null) continue;
      const x = p.cx + Math.cos(a) * (d + 14 + rng() * 14);
      const z = p.cz + Math.sin(a) * (d + 14 + rng() * 14);
      const near = new Set(stacks.filter((s) => Math.hypot(s.x - x, s.z - z) < STACK_REPEAT_M).map((s) => s.key));
      const free = STACK_KEYS.filter((k) => !near.has(k));
      if (!free.length) continue;
      const key = free[Math.floor(rng() * free.length)];
      if (p.seat(key, x, z, rng() * Math.PI * 2, 0.9 + rng() * 0.3, -12, -2)) { stacks.push({ key, x, z }); n++; }
    }
  }

  const counts: Record<string, number> = {};
  for (const p of placers) {
    (p.island as Island & KitPlacedIsland).kitPieces = p.pieces;
    for (const q of p.pieces) counts[q.key] = (counts[q.key] ?? 0) + 1;
  }
  return counts;
}
