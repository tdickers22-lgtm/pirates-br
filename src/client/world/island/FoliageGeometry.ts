import * as THREE from 'three';
import type { IslandBiome } from '../../../shared/types/index.js';
import { terrainFbm } from '../../../shared/utils/index.js';

/** Opaque leaf geometry: close views retain a silhouette from every bearing,
 * without overlapping alpha cards. One shared geometry and draw per species. */
type Leaves = { positions: number[]; colors: number[]; indices: number[] };
const FERTILITY: Record<IslandBiome, number> = {
  lush: 1, palm_atoll: 0.66, highland: 0.76, volcanic: 0.28, bone: 0.36,
};

function vertex(out: Leaves, x: number, y: number, z: number, shade: number): number {
  const index = out.positions.length / 3;
  out.positions.push(x, y, z);
  out.colors.push(shade * 0.96, shade, shade * 0.86);
  return index;
}

function finish(out: Leaves): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(out.colors, 3));
  geometry.setIndex(out.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Five independently curved blades, 25 triangles total (the old two cards
 * were 12). Real pointed tips and narrow twisting ribbons catch grazing light.
 *
 * `blades` exists so the same tuft has a far sibling: three blades, 15
 * triangles, the same silhouette from any distance where the difference is
 * under a pixel. That is what pays for the coverage the near field needs. */
export function makeGrassTuftGeometry(blades = 5): THREE.BufferGeometry {
  const out: Leaves = { positions: [], colors: [], indices: [] };
  for (let blade = 0; blade < blades; blade++) {
    const angle = blade * 2.399963;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const height = 0.38 + (blade % 3) * 0.085;
    const bend = 0.12 + (blade % 2) * 0.085;
    const width = 0.026 + (blade % 3) * 0.004;
    const start = out.positions.length / 3;
    for (let row = 0; row < 3; row++) {
      const t = row / 3;
      const reach = 0.045 + t * t * bend;
      const twist = angle + t * 0.48;
      const half = width * (1 - t * 0.82);
      for (const side of [-1, 1]) {
        vertex(out,
          dx * reach - Math.sin(twist) * half * side,
          -0.035 + height * t - t * t * 0.055,
          dz * reach + Math.cos(twist) * half * side,
          0.68 + t * 0.28 + blade * 0.015);
      }
      if (row > 0) {
        const a = start + (row - 1) * 2;
        out.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const tip = vertex(out, dx * (0.045 + bend), height - 0.09, dz * (0.045 + bend), 1.03);
    out.indices.push(tip - 2, tip - 1, tip);
  }
  return finish(out);
}

/** Radial fern rosette with bent rachises and paired, folded pinnae. The raised
 * midrib is geometry, so the leaf's two halves shade differently at eye height. */
export function makeFernRosetteGeometry(): THREE.BufferGeometry {
  const out: Leaves = { positions: [], colors: [], indices: [] };
  for (let frond = 0; frond < 5; frond++) {
    const angle = frond * 2.399963;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const length = 0.52 + (frond % 3) * 0.085;
    const height = 0.64 + (frond % 2) * 0.14;
    const center = (t: number) => ({
      x: dx * length * t,
      y: -0.025 + height * Math.sin(t * 1.75),
      z: dz * length * t,
    });
    const stemStart = out.positions.length / 3;
    for (let row = 0; row <= 7; row++) {
      const t = row / 7;
      const p = center(t);
      const half = 0.008 * (1 - t * 0.7);
      vertex(out, p.x - dz * half, p.y, p.z + dx * half, 0.66 + t * 0.25);
      vertex(out, p.x + dz * half, p.y, p.z - dx * half, 0.66 + t * 0.25);
      if (row > 0) {
        const a = stemStart + (row - 1) * 2;
        out.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    for (let pair = 0; pair < 6; pair++) {
      const t = 0.19 + pair * 0.135;
      for (const side of [-1, 1]) {
        const p = center(t + (side === 1 ? 0.025 : 0));
        const reach = (0.21 - t * 0.13) * (0.9 + (frond % 2) * 0.1);
        const lx = -dz * side * reach + dx * reach * 0.38;
        const lz = dx * side * reach + dz * reach * 0.38;
        const half = 0.022 * (1 - t * 0.36);
        const shade = 0.79 + t * 0.22 + frond * 0.018;
        const a = vertex(out, p.x, p.y, p.z, shade * 0.87);
        const b = vertex(out, p.x + lx * 0.46 - dx * half, p.y + 0.014, p.z + lz * 0.46 - dz * half, shade);
        const c = vertex(out, p.x + lx * 0.46, p.y + 0.031, p.z + lz * 0.46, shade * 1.06);
        const d = vertex(out, p.x + lx * 0.46 + dx * half, p.y + 0.014, p.z + lz * 0.46 + dz * half, shade * 0.92);
        const tip = vertex(out, p.x + lx, p.y - 0.034, p.z + lz, shade);
        out.indices.push(a, b, c, a, c, d, b, tip, c, c, tip, d);
      }
    }
  }
  return finish(out);
}

/** Coherent patches leave breathing space between thickets and make dry
 * islands sparse. Pure and seed-stable; evaluated at build time only. */
export function understoryDensity(biome: IslandBiome | undefined, x: number, z: number, seed: number): number {
  const phase = (seed >>> 0) % 4093;
  const patch = terrainFbm(x * 0.047 + phase, z * 0.047 - phase, 2);
  return FERTILITY[biome ?? 'lush'] * THREE.MathUtils.clamp(0.58 + patch * 1.15, 0.14, 1);
}

/** What one island's ground cover is allowed to cost, per tier.
 *
 * The low tier used to be a GATE: `if (!lowDetail)` wrapped the whole cover
 * block, so an integrated-GPU player got islands with no lawn at all — bare
 * shaded terrain with props standing on it, which is the loudest possible
 * coherence break between tiers (islandworld-15). A ceiling is not a reason to
 * draw nothing; it is a reason to draw less. So low gets a BUDGET instead: a
 * quarter of the tuft seeds, and two blades per tuft instead of three, which
 * is 10 triangles a tuft against 15.
 *
 * Cost on the low tier, per island, worst case (r=88): 1600 tufts x 10 tris =
 * 16k triangles in ONE draw, and it still rides the existing cover density
 * ramp (`attachCoverLod`) so it thins with distance like every other batch.
 * The low dock-vista row in `test-perf-budget` measures 515k tris against a
 * 580k ceiling, so one island's lawn is ~3% of that ceiling and ~25% of the
 * headroom. Ferns and shell flecks stay OFF on low: the fern rosette is ~310
 * triangles a piece and reads as inner-jungle detail nobody sees at that tier,
 * and it would spend the rest of the headroom on its own.
 *
 * Pure and tier-only so `scripts/test-flora-density.mjs` can grade it. */
export type CoverBudget = {
  /** Hard cap on placed grass instances for this island. */
  grassCap: number;
  /** Blades per tuft (5 tris each). */
  grassBlades: number;
  /** Hard cap on placed fern instances; 0 means the batch is not built. */
  fernCap: number;
  /** Whether the wet-sand shell/starfish flecks are built. */
  shells: boolean;
};

export function coverBudget(radius: number, lowDetail: boolean): CoverBudget {
  const full = Math.min(9000, Math.round(radius * radius * 1.15));
  if (lowDetail) {
    return {
      grassCap: Math.max(120, Math.min(1600, Math.round(full * 0.25))),
      grassBlades: 2,
      fernCap: 0,
      shells: false,
    };
  }
  return {
    grassCap: full,
    grassBlades: 3,
    fernCap: Math.min(260, Math.round(radius * radius * 0.028)),
    shells: true,
  };
}
