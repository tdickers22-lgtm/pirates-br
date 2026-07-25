/**
 * Walkable caves: the mouth carved into the hillside, the enclosed rock tube,
 * the throat collar, and the interior dressing (stalactites, torches, crystals,
 * the dead-end treasure). The terrain itself hollows out via `getIslandSurfaceY`;
 * everything that makes the hollow READ as a cave is built here.
 */
import * as THREE from 'three';
import type { Island } from '../../../shared/types/index.js';
import type { CaveMouthCarve } from './context.js';

/** Build the island's cave-mouth carve function. The terrain mesh lowers its
 *  vertices through this, and every decor placement checks it so nothing hovers
 *  inside an opening the mesh has been cut away from. */
export function makeCaveMouthCarver(island: Island): (worldX: number, worldZ: number, y: number) => CaveMouthCarve {
  // Carve a real MOUTH into the hillside at each cave entrance so it reads as a
  // gaping hole you walk into — not a shallow dip in a solid hill. The trench
  // stays open-air ONLY while the natural hillside can't yet roof the tube
  // (clearance-keyed, not a fixed z-fraction): the old whole-length cut, sized
  // for 1.9m ramps, left 10m+ grass-colored cliff faces knifing through the
  // passage once entrances started plunging to the waterline — walking in put
  // the camera inside terrain backfaces. Past the throat the tunnel keeps its
  // natural rock roof and the interior arched tube encloses the passage.
  // Cave-local frame matches caveGroup.rotation.
  const carveCaveMouth = (worldX: number, worldZ: number, y: number): { y: number; carved: number } => {
    if (!island.caves) return { y, carved: 0 };
    let out = y;
    let carved = 0;
    for (const cave of island.caves) {
      if (!cave.hasMouth) continue; // only real surface mouths open the hillside
      if (out <= cave.floorY) continue;
      const dx = worldX - cave.position.x;
      const dz = worldZ - cave.position.z;
      const cs = Math.cos(cave.rotation);
      const sn = Math.sin(cave.rotation);
      const lx = dx * cs - dz * sn;      // lateral
      const lz = dx * sn + dz * cs;      // +z outward (entrance), tunnel to -z
      const cLen = (cave as { length?: number }).length ?? 10;
      const cR = (cave as { interiorRadius?: number }).interiorRadius ?? 3;
      const fEnd = (cave as { floorYEnd?: number }).floorYEnd ?? cave.floorY;
      const along = cLen > 0 ? Math.min(1, Math.max(0, -lz / cLen)) : 0;
      const floorAt = cave.floorY + (fEnd - cave.floorY) * along;
      const ceilAt = floorAt + cave.height;
      // Any terrain surface skimming the passage volume gets flagged so the
      // color pass paints it CAVE ROCK and decor skips it — near the mouth
      // the natural hillside legitimately crosses the arch's upper region
      // (the tube pokes out of the hill until the roof builds), and those
      // shelves must not read as floating grass.
      const inStrip = Math.abs(lx) < cR * 1.6 && lz < 1.2 && lz > -cLen - 1;
      if (inStrip && out < ceilAt + 1.2) carved = Math.max(carved, 0.35);
      // Gully walls fade OUTSIDE the tube's wobbliest wall radius (~1.5·cR) so
      // partially-carved vertices land on the open-air cut sides, never inside.
      const latK = THREE.MathUtils.smoothstep(Math.abs(lx), cR * 1.5, cR * 1.5 + 1.9);
      // Approach gully outward of the mouth plane (fades by lz≈4.4).
      const outerK = THREE.MathUtils.smoothstep(lz, 1.6, 4.4);
      // DOORWAY-ONLY cut: open the sky above just the first ~2.6m. The
      // carved→natural transition wall this creates is short (natural ground
      // sits barely above the arch this close to the mouth), lands above head
      // height, and is wrapped by the rock collar — it reads as the doorway's
      // inner lintel. The cut MUST be a smooth function of (lz, lx) only:
      // an earlier per-vertex "already roofed → skip" gate made neighbouring
      // vertices diverge by metres and sliced diagonal faces across the
      // passage (the "green walls inside the cave" screenshot).
      const depthCapK = THREE.MathUtils.smoothstep(-lz, 1.4, 2.6);
      const keep = Math.max(latK, outerK, depthCapK);
      const target = floorAt + (out - floorAt) * keep;
      if (target < out) {
        carved = Math.max(carved, out - target);
        out = target;
      }
    }
    return { y: out, carved };
  };
  return carveCaveMouth;
}
