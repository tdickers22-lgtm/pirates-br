/**
 * Walkable caves: the mouth carved into the hillside, the enclosed rock tube,
 * the throat collar, and the interior dressing (stalactites, torches, crystals,
 * the dead-end treasure). The terrain itself hollows out via `getIslandSurfaceY`;
 * everything that makes the hollow READ as a cave is built here.
 */
import * as THREE from 'three';
import type { Island, IslandCave } from '../../../shared/types/index.js';
import { CAVE_MOUTH_TRENCH_K, getCaveMouthCarve, getIslandSurfaceY, isNearCaveMouthCut } from '../../../shared/utils/index.js';
import { assets, type AssetName } from '../../assets/AssetLibrary.js';
import { applyCaveTubeColors, capCaveTubeRims, CAVE_SHELL_MARGIN, caveTubeParams, cullCaveTubeAgainstNeighbors, insideCaveShellVolume, makeCaveTubeGeometry } from '../../rendering/factories/CaveGeometry.js';
import { registerBudgetLight } from '../../rendering/LightBudget.js';
import type { CaveMouthCarve, IslandBuildCtx } from './context.js';
import { ensureMeshGround, type MeshGround } from './GroundTruth.js';

/** The authored boulder GLBs the portal frame and the cave rubble are built
 *  from. `a` is a rounded dome, `b` an angular leaning slab, `c` a split stack —
 *  three silhouettes is enough that a five-rock portal never reads as a row of
 *  clones, and all three share the library's baked-AO vertex colours. */
const PORTAL_ROCK_ASSETS = ['boulder_a', 'boulder_b', 'boulder_c'] as const satisfies readonly AssetName[];

/** Value noise + strata banding for cave stone.
 *
 * The interior used to be one flat emissive brown: a single colour on a
 * large-facet loft, self-lit so even the flat shading gave nothing away, which
 * photographed as a featureless blur from every angle. This paints the same
 * loft with rock — banded strata on a ~3m pitch, two octaves of mottle, damp
 * darkening toward the floor and warm mineral seams in the high band — in the
 * fragment shader, so it costs no geometry and no extra draw call. */
const CAVE_ROCK_GLSL = `
float cvHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float cvNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = cvHash(i), b = cvHash(i + vec2(1.0, 0.0));
  float c = cvHash(i + vec2(0.0, 1.0)), d = cvHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/** Paint a cave-stone material with strata, mottle and damp shading.
 *
 * Injected AFTER `<color_fragment>` so the tube's vertex colours (the
 * mouth-throat lightening from applyCaveTubeColors) still drive the base tone,
 * and the emissive is scaled by the same field at `<emissivemap_fragment>` so
 * the self-glow varies with the rock instead of washing it flat. */
function paintCaveRock(mat: THREE.MeshStandardMaterial, cacheKey: string, exposed = false) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCaveW;\n${exposed ? 'attribute float aCaveExposed;\nvarying float vCaveExp;\n' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvCaveW = (modelMatrix * vec4(position, 1.0)).xyz;\n${exposed ? 'vCaveExp = aCaveExposed;\n' : ''}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCaveW;\nfloat cvShade;\n${exposed ? 'varying float vCaveExp;\nvec3 cvRaw;\n' : ''}${CAVE_ROCK_GLSL}`)
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n'
        + (exposed ? 'cvRaw = diffuseColor.rgb;\n' : '')
        // Strata: a band pitch close to the terrain shader's, warped by noise so
        // the rings don't read as machined contours on a round tube.
        + 'float cvWarp = cvNoise(vCaveW.xz * 0.28);\n'
        + 'float cvBand = 0.5 + 0.5 * sin(vCaveW.y * 1.85 + cvWarp * 4.0);\n'
        + 'float cvM1 = cvNoise(vCaveW.xz * 0.55 + vCaveW.y * 0.30);\n'
        + 'float cvM2 = cvNoise(vCaveW.xz * 2.10 - vCaveW.y * 0.75);\n'
        + 'cvShade = 0.62 + 0.34 * cvBand * (0.55 + 0.45 * cvM1) + 0.22 * cvM2;\n'
        + 'diffuseColor.rgb *= cvShade;\n'
        // Damp, near-black stone at the very base of the walls (where the floor
        // meets rock) and warm mineral seams in the dry upper band.
        + 'diffuseColor.rgb += vec3(0.052, 0.030, 0.009) * smoothstep(0.70, 0.97, cvM2);\n'
        + 'diffuseColor.rgb *= 0.78 + 0.22 * smoothstep(0.0, 1.1, fract(vCaveW.y * 0.5 + 0.5) + cvM1 * 0.4);\n'
        // Wherever this shell breaks OUT of the hill (see tintShellToHillside)
        // it is no longer cave stone — it is a scrap of hillside — so it takes
        // its vertex colour raw. Only a tenth of the cavern mottle is kept, and
        // only so the scrap is not a dead-flat patch beside a mottled slope.
        + (exposed ? 'diffuseColor.rgb = mix(diffuseColor.rgb, cvRaw * (0.74 + 0.34 * cvShade), vCaveExp);\n' : ''),
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance *= (0.42 + 0.82 * cvShade)${exposed ? ' * (1.0 - 0.94 * vCaveExp)' : ''};\n`,
      );
  };
  mat.customProgramCacheKey = () => cacheKey;
}

/**
 * Make the part of a shell that DOES break the hillside draw as hillside.
 *
 * `buryShellCrown` sinks whatever it can, but where the hill over a mouth is
 * genuinely thinner than the throat collar is tall there is nowhere left to
 * sink to: the collar may never go below the walkable ceiling, so a strip of
 * its crown stays above ground and photographs as a small brown plate lying on
 * the slope over the opening. Nothing can be done about the geometry — so paint
 * it out. Every vertex that ends up at or above the DRAWN terrain takes that
 * terrain's own vertex colour, and (through `aCaveExposed`) drops the cavern
 * shading and the throat's warm self-glow with it. What is left reads as the
 * hillside it is embedded in, from the one angle it was ever visible from.
 */
function tintShellToHillside(
  geo: THREE.BufferGeometry, island: Island, cave: IslandCave,
  ground: MeshGround | null, base: THREE.Color,
): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  // The tube already carries the mouth-throat lightening (applyCaveTubeColors);
  // keep it as the buried tone and only lerp the crown away from it.
  const existing = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
  const colors = new Float32Array(pos.count * 3);
  const exposure = new Float32Array(pos.count);
  const cos = Math.cos(cave.rotation);
  const sin = Math.sin(cave.rotation);
  const caveLocalX = cave.position.x - island.position.x;
  const caveLocalZ = cave.position.z - island.position.z;
  const hill = new THREE.Color();
  const out = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i);
    const lz = pos.getZ(i);
    const ix = caveLocalX + lx * cos + lz * sin;
    const iz = caveLocalZ - lx * sin + lz * cos;
    if (existing) out.setRGB(existing.getX(i), existing.getY(i), existing.getZ(i));
    else out.copy(base);
    let t = 0;
    const drawn = ground?.heightAt(ix, iz);
    if (drawn !== null && drawn !== undefined && ground?.colorAt(ix, iz, hill)) {
      // How far this vertex stands out of the hill. Buried by more than a
      // third of a metre and nobody can see it, so nothing changes.
      t = THREE.MathUtils.smoothstep(cave.position.y + pos.getY(i) - drawn, -0.35, 0.45);
      if (t > 0) out.lerp(hill, t);
    }
    colors[i * 3] = out.r;
    colors[i * 3 + 1] = out.g;
    colors[i * 3 + 2] = out.b;
    exposure[i] = t;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aCaveExposed', new THREE.BufferAttribute(exposure, 1));
}

/**
 * Sink the part of a lofted shell that stands PROUD OF THE HILLSIDE back under
 * it.
 *
 * The tube — and much more so the throat collar, whose radius is inflated to
 * 1.5×cR to wrap past the carved gully — is lofted from the passage's
 * dimensions alone. Where the hill over the mouth is thinner than the shell is
 * tall, its crown breaks the surface and draws as a wide flat plate hanging out
 * of the mountain: the "brown awning over the cave mouth". The old portal hid
 * it behind an 18m-wide stretched dodecahedron; nothing should have to.
 *
 * Only vertices ABOVE the walkable ceiling + CAVE_SHELL_MARGIN move, and none
 * is ever pulled below that line — so the shell keeps exactly the slab of rock
 * outside the walkable box that test-cave-walk pins, and nothing the sliver
 * seals depend on is touched (they all live at or below the arch).
 *
 * @returns how many vertices were sunk.
 */
function buryShellCrown(
  geo: THREE.BufferGeometry, island: Island, cave: IslandCave,
  ceilingAt: (localZ: number) => number, lateralKeep: number,
): number {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const cos = Math.cos(cave.rotation);
  const sin = Math.sin(cave.rotation);
  let moved = 0;
  for (let i = 0; i < pos.count; i++) {
    const ly = pos.getY(i);
    const lz = pos.getZ(i);
    const lx0 = pos.getX(i);
    // Outboard of `lateralKeep` the loft is doing no work at all: it is neither
    // enclosing the walkable box (which is only cR wide) nor covering the
    // carved gully (only CAVE_MOUTH_TRENCH_K·cR wide) — it is purely the shell
    // widenings, and those WINGS are most of the plate that hangs out of the
    // hill. Out there anything above the hillside may sink.
    const floorLine = Math.abs(lx0) > lateralKeep ? -Infinity : ceilingAt(lz);
    if (ly <= floorLine) continue;
    const lx = lx0;
    const wx = cave.position.x + lx * cos + lz * sin;
    const wz = cave.position.z - lx * sin + lz * cos;
    const surface = getIslandSurfaceY(island, wx, wz, { skipMouthCarve: true }) - cave.position.y;
    const target = Math.max(floorLine, surface - 0.3);
    if (target >= ly - 1e-3) continue;
    pos.setY(i, target);
    moved++;
  }
  if (moved > 0) {
    pos.needsUpdate = true;
    // GOTCHA: computeVertexNormals reuses a stale (shorter) normal attribute
    // after a geometry rebuild — GL_INVALID_OPERATION ×256/frame, and whole
    // systems silently stop drawing. Drop it first, always.
    geo.deleteAttribute('normal');
    geo.computeVertexNormals();
  }
  return moved;
}

/** Metres of natural hillside that must stand over a piece of INTERIOR cave
 *  dressing. A segment's box is generated to fit the walkable warren, not the
 *  rock available to hide it: wherever the hill is thin the box (and the tube
 *  lofted around it) breaks the surface, and props placed from segment-LOCAL
 *  coordinates alone came out with it — glowing crystals, a lit torch and the
 *  treasure crate hanging in open air on a walkable summit (Skull Cove, ~x728
 *  z-71, reproduced on two seeds). */
const CAVE_DECOR_MIN_BURIAL = 1.5;

/** The gate every interior prop passes before it is added.
 *
 * A prop may only exist where the cave REALLY is, which is two conditions, not
 * one:
 *  (a) inside the rock shell some segment DRAWS — `insideCaveShellVolume` is
 *      the truth here (it is the volume bounded by the lofted tube, so "true"
 *      means an eye at that point is looking at cave rock, not at the island);
 *  (b) at least CAVE_DECOR_MIN_BURIAL below the NATURAL hillside, sampled at
 *      the prop's own xz. The mouth trench is skipped deliberately: the trench
 *      is open by design and the throat collar draws rock around it, so the
 *      carved ground there is not evidence the prop is exposed.
 */
function makeCaveDecorGate(island: Island, cave: IslandCave) {
  const cosCave = Math.cos(cave.rotation);
  const sinCave = Math.sin(cave.rotation);
  const caves = island.caves ?? [cave];
  return (lx: number, ly: number, lz: number): boolean => {
    const wx = cave.position.x + lx * cosCave + lz * sinCave;
    const wy = cave.position.y + ly;
    const wz = cave.position.z - lx * sinCave + lz * cosCave;
    if (!caves.some((other) => insideCaveShellVolume(other, wx, wy, wz))) return false;
    return wy <= getIslandSurfaceY(island, wx, wz, { skipMouthCarve: true }) - CAVE_DECOR_MIN_BURIAL;
  };
}

/** Build the island's cave-mouth carve lookup. The mouth trench is carved by
 *  the SHARED heightfield (getIslandSurfaceY already returns the cut ground, so
 *  the pirate walks on exactly what the mesh draws); this wrapper reports the
 *  cut DEPTH, which the terrain color pass uses to repaint cut faces as rock
 *  and every decor placement checks so nothing hovers inside the opening. */
export function makeCaveMouthCarver(island: Island): (worldX: number, worldZ: number, y: number) => CaveMouthCarve {
  return (worldX: number, worldZ: number, y: number): CaveMouthCarve => {
    // Terrain meshes run this per VERTEX, so the trig-only reject comes first:
    // resolving the cut depth needs a second heightfield sample (the uncut
    // hillside the cut is measured from) and almost no vertex is near a mouth.
    if (!isNearCaveMouthCut(island, worldX, worldZ)) return { y, carved: 0 };
    const carve = getCaveMouthCarve(island, worldX, worldZ);
    // `min` keeps this idempotent: terrain vertices arrive already carved (they
    // come from getIslandSurfaceY), decor probes may not have been.
    return { y: Math.min(y, carve.y), carved: carve.carved };
  };
}

/** Walkable caves — terrain hollows out via getIslandSurfaceY, this adds the
 *  ceiling, side walls, back wall, entrance frame, and a torch so the cavern
 *  reads as a real explorable cave you can step into. */
export function buildCaves(ctx: IslandBuildCtx) {
  const { island, group, rng, lowDetail, isVolcanic, paletteRock, cliffColor } = ctx;
  const meshGround = ensureMeshGround(ctx);
  if (island.caves && island.caves.length > 0) {
    // Cave stone is the MOUNTAIN'S OWN rock (its palette, darkened for depth) so
    // the mouth reads as an opening carved into the rock face — not a foreign
    // pile of dark boulders bolted onto a smooth hillside.
    const caveRockCol = paletteRock.clone().multiplyScalar(0.44);
    // Slightly deeper tone for the continuous cave tube (both sides so you never
    // see a hole through a wall from any angle).
    // A faint warm self-glow on the cave stone so the deep interior reads as a
    // dim lantern-lit cavern instead of a pitch-black void where the torch
    // PointLights don't reach (they're range-culled for the light budget).
    // vertexColors carries the mouth-throat lightening (applyCaveTubeColors);
    // emissive raised so the interior reads dim-lit, not a blocked black void.
    const caveRockMat = new THREE.MeshStandardMaterial({
      color: caveRockCol.clone().multiplyScalar(0.9).getHex(), roughness: 1, flatShading: true, side: THREE.DoubleSide,
      emissive: new THREE.Color(0x30200f), emissiveIntensity: 0.7, vertexColors: true,
    });
    paintCaveRock(caveRockMat, 'pirates-cave-tube', true);
    const torchMat = new THREE.MeshStandardMaterial({ color: 0x4a2f17, roughness: 1 });
    const flameMat = new THREE.MeshStandardMaterial({ color: 0xff8a20, emissive: 0xff5500, emissiveIntensity: 1.4, roughness: 0.4 });

    // ── The portal stone ─────────────────────────────────────────────────────
    // The mouth used to be framed by DodecahedronGeometry scaled to cR×1.7 by
    // cR×0.5 — a twelve-face ball stretched into a plate, which photographed as
    // giant near-black paper shards fanned out of the hillside. The frame is now
    // the authored boulder GLBs (2-4k tris each, real broken-rock silhouettes,
    // baked-AO vertex colours), instanced across the island's mouths so a
    // five-rock portal costs three draw calls instead of nine meshes.
    // Albedo is the island's OWN cliff tone (what the hillside beside them
    // draws), only mildly charred on volcanoes: the old ×0.3-toward-charcoal
    // tint is where "near-black" came from.
    const portalRockCol = isVolcanic
      ? cliffColor.clone().lerp(new THREE.Color(0x2f2823), 0.5).multiplyScalar(0.9)
      : cliffColor.clone().multiplyScalar(0.62);
    /** Per-asset instance transforms for this island's portal frames + rubble. */
    const portalXf = new Map<AssetName, THREE.Matrix4[]>();
    const rockAsset = (k: number): AssetName => PORTAL_ROCK_ASSETS[Math.min(
      PORTAL_ROCK_ASSETS.length - 1,
      Math.floor(rng(k * 137 + 11) * PORTAL_ROCK_ASSETS.length),
    )];
    const xfPos = new THREE.Vector3();
    const xfQuat = new THREE.Quaternion();
    const xfEuler = new THREE.Euler();
    const xfScale = new THREE.Vector3();

    // Light budget for the (now much larger, multi-vein) cave network: every
    // segment still gets a glowing torch/crystal MESH (emissive, free), but only
    // the first several segments get a real dynamic PointLight so a deep warren
    // can't blow the renderer's light count. Torches go to the most-travelled
    // segments (mouth + junction + main veins come first in island.caves).
    let caveTorchBudget = lowDetail ? 6 : 12;
    let caveGlowBudget = lowDetail ? 2 : 6;
    /** Props the placement gate refused to build anywhere in this island's
     *  warren (see makeCaveDecorGate). Reported on group.userData so a tour
     *  probe can sweep every island, not just the one that was caught. */
    let rejectedDecor = 0;

    for (const cave of island.caves) {
      const caveGroup = new THREE.Group();
      caveGroup.position.set(cave.position.x - island.position.x, cave.position.y, cave.position.z - island.position.z);
      caveGroup.rotation.y = cave.rotation;

      const cw = cave.width;
      const ch = cave.height;
      const cLen = (cave as { length?: number }).length ?? 10;
      const cR = (cave as { interiorRadius?: number }).interiorRadius ?? 3.0;
      // Floor sits at the SAME depth physics stands you on (cave.floorY), so
      // your feet meet the visible slab instead of floating ~0.6-1.3m above it.
      const floorLocalY = cave.floorY - cave.position.y;
      // Cave tunnel runs from local z=0 (entrance) to z=-cLen (back)

      // ── The mouth is an OPENING IN THE MOUNTAIN'S OWN ROCK — not a foreign
      //    boulder pile. A heavy overhanging BROW, two tall side JAMBS, shoulder
      //    blocks, and a few fallen slabs frame it, all in the cliff's own stone
      //    tone (charred on volcanoes) and slab-flattened (not round balls), so
      //    the DARK cavity behind them reads as a cave bored into the cliff. ──
      const isMouth = cave.hasMouth ?? true;
      // The exterior rock PORTAL (frame + the mouth's tube) is a landmark that
      // must read from across the island — it stays visible with the terrain.
      // Only the interior decor + lights hide behind the proximity gate below
      // (light budget). Non-mouth segments have no portal; all on caveGroup.
      let portalGroup: THREE.Group | null = null;
      if (isMouth) {
        portalGroup = new THREE.Group();
        portalGroup.position.copy(caveGroup.position);
        portalGroup.rotation.copy(caveGroup.rotation);
        group.add(portalGroup);
      }
      const exterior = portalGroup ?? caveGroup;
      if (isMouth) {
        // Segment-local (lx, lz) → island-local xz. Same basis makeCaveDecorGate
        // uses, so a rock and the gate that judges it agree on where it stands.
        const cosCave = Math.cos(cave.rotation);
        const sinCave = Math.sin(cave.rotation);
        const caveLocalX = cave.position.x - island.position.x;
        const caveLocalZ = cave.position.z - island.position.z;
        const toIsland = (lx: number, lz: number) => ({
          x: caveLocalX + lx * cosCave + lz * sinCave,
          z: caveLocalZ - lx * sinCave + lz * cosCave,
        });
        /** Stand one portal boulder on the hillside beside the opening.
         *
         *  `natural` seats it on the UNCUT hillside (the gully rim the frame
         *  stands on); the threshold rubble seats on the carved trench floor it
         *  actually lies in. Every rock is sunk a fifth of its height so none of
         *  them ever floats on a slope, and none is a collider — so the mouth
         *  keeps the walkable width test-cave-walk pins. */
        const placeRock = (
          k: number, lx: number, lz: number, height: number, lean: number,
          natural: boolean, minLocalY = -Infinity,
        ) => {
          const asset = rockAsset(k);
          const bounds = assets.bounds(asset);
          if (!bounds) return;
          const top = Math.max(0.3, bounds.max.y);
          const sc = height / top;
          const p = toIsland(lx, lz);
          const wx = p.x + island.position.x;
          const wz = p.z + island.position.z;
          const analytic = natural
            ? getIslandSurfaceY(island, wx, wz, { skipMouthCarve: true })
            : getIslandSurfaceY(island, wx, wz);
          // …and the rock face it stands on is the DRAWN one. Seating the frame
          // on the analytic field left brow and jamb stones up to 2.6m proud of
          // the hillside they are supposed to be growing out of. Take whichever
          // is lower, bounded so one carved sample can't drop a jamb into the
          // gully it is meant to flank.
          const drawn = meshGround?.heightAt(p.x, p.z);
          const ground = drawn === null || drawn === undefined
            ? analytic
            : Math.max(analytic - 2.8, Math.min(analytic, drawn));
          // The throat COLLAR is a 1.5·cR-radius tube standing proud of the
          // carved gully; where the hillside over the mouth is thinner than the
          // collar is tall, its crown is a bare brown plate hanging over the
          // opening. `minLocalY` lets the brow stones sit on the collar rather
          // than on the (lower) hillside, which is what caps it.
          const base = Math.max(ground, cave.position.y + minLocalY);
          xfPos.set(p.x, base - height * 0.22, p.z);
          xfEuler.set(
            lean * (0.7 + rng(k * 29) * 0.6),
            cave.rotation + (rng(k * 31) - 0.5) * 2.4,
            (rng(k * 37) - 0.5) * 0.34,
          );
          xfQuat.setFromEuler(xfEuler);
          xfScale.set(sc * (0.86 + rng(k * 41) * 0.3), sc, sc * (0.86 + rng(k * 43) * 0.3));
          const list = portalXf.get(asset) ?? [];
          list.push(new THREE.Matrix4().compose(xfPos, xfQuat, xfScale));
          portalXf.set(asset, list);
        };
        // Frame the opening OUTSIDE the carved gully (CAVE_MOUTH_TRENCH_K·cR):
        // the old jambs stood at cR — inside the walkway — which is why they
        // read as a boulder pile blocking the hole instead of its rock jaws.
        const jambLat = CAVE_MOUTH_TRENCH_K * cR + 0.5;
        const rockH = THREE.MathUtils.clamp(ch * 0.9, 2.6, 6.0);
        const crownY = floorLocalY + ch * 1.0;
        // BROW: three crags along the crown, capping the collar and leaning out
        // over the opening — this is the mass that makes the cavity read as a
        // hole bored under a rock overhang rather than a slot in a grass bank.
        for (let i = 0; i < 5; i++) {
          placeRock(
            cw * 3 + 1 + i,
            (i - 2) * cR * 0.66 + (rng(cw + i * 17) - 0.5) * cR * 0.24,
            -0.5 - rng(cw + i * 19) * 1.6,
            rockH * (0.86 + rng(cw + i * 23) * 0.4),
            -0.22, true, crownY - rockH * 0.3,
          );
        }
        // JAMBS: the two shoulders of the gully mouth, standing to the crown.
        placeRock(cw * 3 + 5, -jambLat, 0.8, rockH * 1.25, 0.14, true, floorLocalY + ch * 0.2);
        placeRock(cw * 3 + 6, jambLat, 0.4, rockH * 1.1, 0.14, true, floorLocalY + ch * 0.15);
        // …and the corner blocks that tie the jambs into the brow.
        for (const side of [-1, 1] as const) {
          placeRock(
            cw * 3 + 7 + (side + 1) / 2,
            side * cR * 1.12, -1.9,
            rockH * (0.6 + rng(cw * 7 + side * 13) * 0.3), 0, true, crownY - rockH * 0.55,
          );
        }
        // …and rubble spilled out of the throat onto the trench floor, well
        // clear of the threshold so it never crowds the camera on the way in.
        if (!lowDetail) {
          for (let i = 0; i < 3; i++) {
            const side = i % 2 === 0 ? 1 : -1;
            placeRock(
              cw * 3 + 10 + i,
              side * (cR * 0.78 + rng(i * 73) * cR * 0.5),
              3.0 + rng(i * 77) * 3.4,
              rockH * (0.16 + rng(i * 79) * 0.13),
              0.5, false,
            );
          }
        }
        // Warm glow spilling from the throat of the mouth — the entrance beckons
        // as you approach (rides the always-visible portal group, but the LIGHT
        // itself is distance-gated in updateEnvironmentLod like every other
        // decor light: an unbudgeted always-on PointLight per mouth multiplies
        // every island's forward-pass lighting cost across the whole map).
        const mouthGlow = new THREE.PointLight(0xffb066, 5.6, cR * 7.0, 1.0);
        mouthGlow.position.set(0, floorLocalY + ch * 0.40, -2.2);
        mouthGlow.visible = false;
        registerBudgetLight(mouthGlow);
        exterior.add(mouthGlow);
        (group.userData.caveMouthGlows ??= []).push({ light: mouthGlow, x: cave.position.x, z: cave.position.z });
      }

      // ── The cave itself: one CONTINUOUS enclosed rock tube (floor + walls +
      //    arched ceiling), organically displaced — replaces the old flat
      //    floor/wall/ceiling slabs that left black gaps. Dead-ends get a
      //    fan-capped back; mouths/junctions stay open so segments connect. ──
      const floorEndLocalY = ((cave as { floorYEnd?: number }).floorYEnd ?? cave.floorY) - cave.position.y;
      // The tube overshoots BOTH planes so its open rims bury inside the
      // segments they join (see caveTubeParams).
      const tp = caveTubeParams(cave);
      const tubeGeo = makeCaveTubeGeometry(tp.cR, tp.tubeLen, tp.floorLocalY, tp.ceilingLocalY, tp.seed, tp.capBack, tp.tubeFloorEnd, tp.frontOvershoot);
      // Junction fix: drop wall triangles standing inside a NEIGHBOUR's open
      // interior (physics walks the union — those walls were fake).
      cullCaveTubeAgainstNeighbors(tubeGeo, cave, island);
      // …then seal what's left over at a joint where the neighbour is SMALLER:
      // the big rim's uncovered annulus was a window onto the island exterior.
      capCaveTubeRims(tubeGeo, cave, island);
      applyCaveTubeColors(tubeGeo, isMouth);
      // The walkable ceiling at a local z, following the same ramp the loft and
      // the physics floor use, plus the shell's guaranteed rock margin — the
      // line above which a shell vertex is decoration, not enclosure.
      const shellCeilingAt = (lz: number) => floorLocalY
        + (floorEndLocalY - floorLocalY) * THREE.MathUtils.clamp(-lz / Math.max(1e-3, cLen), 0, 1)
        + ch + CAVE_SHELL_MARGIN;
      buryShellCrown(tubeGeo, island, cave, shellCeilingAt, cR + CAVE_SHELL_MARGIN + 0.6);
      // The mouth tube is lofted from the passage too, and over a thin roof its
      // crown surfaces beside the collar's — same brown plate, same remedy.
      // Deeper segments come out all-zeros (they are metres under the hill), so
      // the attribute the shared material reads is simply always there.
      tintShellToHillside(tubeGeo, island, cave, meshGround, caveRockCol);
      const tube = new THREE.Mesh(tubeGeo, caveRockMat);
      tube.name = 'cave-tube';
      tube.receiveShadow = true;
      // Mouth tube rides with the always-visible portal so the entrance has real
      // dark depth (and no see-through) from a distance; deeper interior segments
      // stay gated (only seen once you're inside).
      exterior.add(tube);

      // ── Throat COLLAR (mouths only): a short, wider rock tube wrapping the
      //    first ~7m of the passage. The terrain's carved→natural transition
      //    face lands inside it (unavoidable at terrain-mesh resolution — it
      //    used to slice visibly across the tunnel), and it seals the sliver
      //    gaps between the arch and the trench walls. DoubleSide: its outer
      //    face is the portal's rocky throat seen from the approach. ──
      if (isMouth) {
        const collarLen = Math.min(7.0, cLen * 0.95);
        const collarFloorEnd = floorLocalY + (floorEndLocalY - floorLocalY) * (collarLen / Math.max(1, cLen));
        // Wider than the TRENCH the shared carve cuts (CAVE_MOUTH_TRENCH_K·cR),
        // not merely wider than the tube: the sliver between the collar's rim
        // and the gully wall was a sky hole in the throat ceiling of every
        // mouth. Wrapping past the cut edge closes it by construction.
        const collarR = cR * CAVE_MOUTH_TRENCH_K + 0.5;
        // Lighter than the deep-tube stone: the collar IS the visible throat
        // from outside — at ×0.36 it read as a boulder blocking the mouth.
        // White base + vertex colours: the collar's own stone tone is baked in
        // per vertex so tintShellToHillside can hand the emerging crown the
        // hillside's colour instead (see there).
        const collarMat = new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 1, flatShading: true, side: THREE.DoubleSide,
          emissive: new THREE.Color(0x30200f), emissiveIntensity: 0.5, vertexColors: true,
        });
        paintCaveRock(collarMat, 'pirates-cave-collar', true);
        const collarGeo = makeCaveTubeGeometry(collarR, collarLen, floorLocalY - 0.02, floorLocalY + ch * 1.02, cw * 3.1 + 17, false, collarFloorEnd - 0.02);
        // The collar is the worst offender for a crown standing proud of the
        // hill — it is lofted at 1.5×cR and then inflated again by the shell
        // margin and the loft's own widenings, up to a ~16m half-width. Sink
        // whatever of it breaks the surface (see buryShellCrown).
        buryShellCrown(collarGeo, island, cave, shellCeilingAt, collarR + 0.6);
        // …and whatever the burial could NOT reach — the hill over this mouth
        // being thinner than the collar is tall — stops being a brown plate and
        // becomes hillside.
        tintShellToHillside(collarGeo, island, cave, meshGround, paletteRock.clone().multiplyScalar(0.7));
        const collar = new THREE.Mesh(collarGeo, collarMat);
        collar.name = 'cave-collar';
        collar.receiveShadow = true;
        exterior.add(collar);
      }

      // ── Where interior dressing is ALLOWED to stand ───────────────────────
      // Everything below is placed in segment-local coordinates, and a segment
      // is generated to fit the walkable warren rather than the rock available
      // to bury it. `siteDecor` slides a prop DEEPER along its own tunnel until
      // the gate accepts it (deeper is always more overburden — the floor ramps
      // into the hill) and reports failure when the whole segment is too thin.
      const decorOk = makeCaveDecorGate(island, cave);
      /** Floor height at a local z, following the segment's own ramp — the same
       *  ramp the tube loft and the physics floor use. Props pinned to the NEAR
       *  floor alone sank through (or hovered over) the floor deeper in. */
      const floorAtZ = (lz: number) => floorLocalY
        + (floorEndLocalY - floorLocalY) * THREE.MathUtils.clamp(-lz / Math.max(1e-3, cLen), 0, 1);
      /** Resolve a prop's seat: keep its offset from the floor (or from the
       *  ceiling), walk it deeper until the gate passes, and hand back the
       *  accepted local y/z — or null, which means "do not build this one". */
      const siteDecor = (lx: number, lz: number, offset: number, fromCeiling = false): { y: number; z: number } | null => {
        const step = cLen / 10;
        for (let k = 0; k < 10; k++) {
          const z = lz - k * step;
          if (z < -cLen + 0.3) break;
          const y = floorAtZ(z) + (fromCeiling ? ch : 0) + offset;
          if (decorOk(lx, y, z)) return { y, z };
        }
        rejectedDecor++;
        return null;
      };

      // ── Stalactite + stalagmite accents ──
      // Scale matters more than count here: the old accents were 0.16-0.28m
      // wide and 0.4-1.1m long inside a 4m-radius, 4m-high passage, which is
      // sub-pixel dressing — the reason a lit interior still photographed as a
      // featureless brown blur. These are cave-sized (up to 2.4m), fluted with
      // a second collar cone, and there are twice as many of them.
      const stoneAccentMat = new THREE.MeshStandardMaterial({ color: caveRockCol.clone().multiplyScalar(1.5).getHex(), roughness: 1, flatShading: true });
      paintCaveRock(stoneAccentMat, 'pirates-cave-accent');
      const accentCount = lowDetail ? 4 : 11;
      for (let s = 0; s < accentCount; s++) {
        const lz = -1 - rng(s * 401) * (cLen - 2);
        // Formations grow off the WALLS, not down the middle of the walkway.
        const side = rng(s * 419) > 0.5 ? 1 : -1;
        const lx = side * cR * (0.42 + rng(s * 403) * 0.5);
        const stalH = (0.9 + rng(s * 407) * 1.5) * THREE.MathUtils.clamp(ch / 4, 0.6, 1.5);
        const fromCeiling = rng(s * 409) > 0.45;
        const seat = siteDecor(lx, lz, fromCeiling ? -stalH * 0.5 : stalH * 0.5, fromCeiling);
        if (!seat) continue;
        const rTop = 0.22 + rng(s * 411) * 0.26;
        const stal = new THREE.Mesh(new THREE.ConeGeometry(rTop, stalH, 6), stoneAccentMat);
        stal.position.set(lx, seat.y, seat.z);
        stal.rotation.y = rng(s * 413) * Math.PI;
        if (fromCeiling) stal.rotation.x = Math.PI;
        caveGroup.add(stal);
        // Flared collar where it meets the rock — a bare cone reads as a traffic
        // cone stuck to the ceiling; the collar makes it grow out of the stone.
        const collar = new THREE.Mesh(new THREE.ConeGeometry(rTop * 1.85, stalH * 0.34, 6), stoneAccentMat);
        collar.position.set(lx, seat.y + (fromCeiling ? 1 : -1) * stalH * 0.33, seat.z);
        collar.rotation.y = rng(s * 417) * Math.PI;
        if (fromCeiling) collar.rotation.x = Math.PI;
        caveGroup.add(collar);
      }

      // ── Floor scatter: broken rock along the wall feet ────────────────────
      // The floor was a bare ramp of tube triangles from wall to wall. Real
      // boulder GLBs (one InstancedMesh per segment, so the LOD gate still hides
      // them with the rest of the interior) give the eye something to read depth
      // against and hide the wall/floor seam.
      {
        const rubbleAsset = assets.mergedGeometry('boulder_a');
        if (rubbleAsset) {
          const rubbleXf: THREE.Matrix4[] = [];
          const rubbleCount = lowDetail ? 3 : 9;
          for (let s = 0; s < rubbleCount; s++) {
            const side = rng(s * 431) > 0.5 ? 1 : -1;
            const lx = side * cR * (0.55 + rng(s * 433) * 0.38);
            const lz = -0.8 - rng(s * 437) * (cLen - 1.4);
            const size = 0.32 + rng(s * 439) * 0.72;
            const seat = siteDecor(lx, lz, size * 0.22);
            if (!seat) continue;
            xfPos.set(lx, seat.y - size * 0.34, seat.z);
            xfEuler.set(
              (rng(s * 443) - 0.5) * 1.1, rng(s * 449) * Math.PI * 2, (rng(s * 457) - 0.5) * 1.1,
            );
            xfQuat.setFromEuler(xfEuler);
            const sc = size / 2.226;   // boulder_a stands 2.226m at scale 1
            xfScale.set(sc * (0.8 + rng(s * 461) * 0.5), sc, sc * (0.8 + rng(s * 463) * 0.5));
            rubbleXf.push(new THREE.Matrix4().compose(xfPos, xfQuat, xfScale));
          }
          if (rubbleXf.length > 0) {
            const rubbleMat = new THREE.MeshStandardMaterial({
              color: caveRockCol.clone().multiplyScalar(1.25).getHex(), roughness: 1, flatShading: true,
              vertexColors: true, emissive: new THREE.Color(0x2a1c0d), emissiveIntensity: 0.5,
            });
            paintCaveRock(rubbleMat, 'pirates-cave-rubble');
            const rubble = new THREE.InstancedMesh(rubbleAsset.geometry, rubbleMat, rubbleXf.length);
            rubble.name = 'cave-rubble';
            rubbleXf.forEach((m, k) => rubble.setMatrixAt(k, m));
            rubble.instanceMatrix.needsUpdate = true;
            rubble.castShadow = false;
            rubble.receiveShadow = true;
            caveGroup.add(rubble);
          }
        }
      }

      // ── Torch sconce on the side wall + warm point light so the inside isn't pitch-black ──
      const torchSide = rng(cw * 7) > 0.5 ? 1 : -1;
      const torchSeat = siteDecor(torchSide * (cR - 0.1), -cLen * 0.55, ch * 0.65);
      if (torchSeat) {
        const torchZ = torchSeat.z;
        const torchBaseY = torchSeat.y - ch * 0.65;
        const torchMount = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), torchMat);
        torchMount.position.set(torchSide * (cR - 0.1), torchSeat.y, torchZ);
        caveGroup.add(torchMount);
        const torchStaff = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.55, 5), torchMat);
        torchStaff.rotation.z = -torchSide * 0.45;
        torchStaff.position.set(torchSide * (cR - 0.18), torchBaseY + ch * 0.78, torchZ);
        caveGroup.add(torchStaff);
        const flame = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), flameMat);
        flame.position.set(torchSide * (cR - 0.34), torchBaseY + ch * 0.95, torchZ);
        caveGroup.add(flame);
        // Underground is dark regardless of day/night, so caves get their OWN
        // always-on warm torch light (parented to the group → only lit when the
        // cave is in view range, so no global light-budget blowout).
        if (caveTorchBudget > 0) {
          caveTorchBudget--;
          const torchLight = new THREE.PointLight(0xffb060, 4.4, cLen + cR * 3.0, 1.4);
          torchLight.position.copy(flame.position);
          registerBudgetLight(torchLight);
          caveGroup.add(torchLight);
        }
      }
      // Sparse glowing crystals deeper in — cool blue emissive clusters with a
      // faint light each, so the tunnel reads as lit but moody, not a flat box.
      if (!lowDetail) {
        const crystalMat = new THREE.MeshStandardMaterial({ color: 0x6fd3ff, emissive: 0x2f8fe0, emissiveIntensity: 2.2, roughness: 0.3 });
        // The bed of dull rock each cluster erupts from, so the shards don't
        // look glued flat to a smooth wall.
        const crystalBedMat = new THREE.MeshStandardMaterial({
          color: caveRockCol.clone().lerp(new THREE.Color(0x3f6f8a), 0.35).getHex(),
          roughness: 0.85, flatShading: true, emissive: new THREE.Color(0x102838), emissiveIntensity: 0.7,
        });
        const clusters = 3 + Math.floor(rng(cw * 5) * 3);
        for (let c = 0; c < clusters; c++) {
          const cz = -cLen * (0.28 + c * 0.2) - rng(c * 91) * 1.4;
          const side = rng(c * 89) > 0.5 ? 1 : -1;
          const cx = side * cR * (0.4 + rng(c * 93) * 0.55);
          const onCeil = rng(c * 95) > 0.62;
          const seat = siteDecor(cx, cz, onCeil ? -0.35 : 0.12, onCeil);
          if (!seat) continue;
          const cy = seat.y;
          const bed = new THREE.Mesh(new THREE.DodecahedronGeometry(0.42 + rng(c * 101) * 0.3, 0), crystalBedMat);
          bed.position.set(cx, cy + (onCeil ? 0.14 : -0.14), seat.z);
          bed.scale.set(1, 0.55, 1);
          bed.rotation.set(rng(c * 103) * 0.5, rng(c * 107) * Math.PI, rng(c * 109) * 0.5);
          caveGroup.add(bed);
          // Six shards, up to 1.35m — the old 0.3-0.7m splinters were invisible
          // past three metres, which is why the "lit but moody" read never landed.
          for (let s = 0; s < 6; s++) {
            const shardH = 0.45 + rng(c * 99 + s) * 0.9;
            const shard = new THREE.Mesh(
              new THREE.ConeGeometry(0.09 + rng(c * 97 + s) * 0.1, shardH, 5), crystalMat,
            );
            shard.position.set(
              cx + (rng(s * 13 + c) - 0.5) * 0.75,
              cy + (onCeil ? -1 : 1) * (0.1 + shardH * 0.35),
              seat.z + (rng(s * 17 + c) - 0.5) * 0.75,
            );
            shard.rotation.set(rng(s * 19 + c) * 0.8 - 0.4 + (onCeil ? Math.PI : 0), rng(s * 21 + c) * Math.PI, rng(s * 23 + c) * 0.8 - 0.4);
            caveGroup.add(shard);
          }
          if (caveGlowBudget > 0) {
            caveGlowBudget--;
            const glow = new THREE.PointLight(0x5fbfff, 1.6, 8.5, 1.8);
            glow.position.set(cx, cy, seat.z);
            registerBudgetLight(glow);
            caveGroup.add(glow);
          }
        }
      }

      // ── Treasure chest tucked at the back of the cave (visual only — gameplay
      //     chests still spawn from server). Only in the dead-end treasure room. ──
      if ((cave.hasBackWall ?? true) && rng(cw * 11) > 0.35 && !lowDetail) {
        const chestSeat = siteDecor(0, -cLen + 1.0, 0.35);
        if (chestSeat) {
          const goldChestMat = new THREE.MeshStandardMaterial({ color: 0x5d3a18, roughness: 0.95 });
          const goldLidMat = new THREE.MeshStandardMaterial({ color: 0xc9a84c, roughness: 0.5, metalness: 0.6 });
          const treasure = new THREE.Group();
          treasure.position.set(0, chestSeat.y, chestSeat.z);
          treasure.rotation.y = (rng(cw * 13) - 0.5) * 0.6;
          const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.55, 0.7), goldChestMat);
          body.position.y = 0;
          treasure.add(body);
          const lid = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.18, 0.74), goldLidMat);
          lid.position.y = 0.32;
          treasure.add(lid);
          caveGroup.add(treasure);
        }
      }

      // Cave interiors are boxy meshes carved into a steep hillside — their
      // dark ceiling/wall slabs poke out through the terrain shell and read
      // as black slabs floating on the mountain from a distance. Gate their
      // visibility to camera proximity (world entrance pos cached on the
      // group): you only see the hollow when you're near enough to be about
      // to enter it. Also a perf win (dozens of hidden slabs at range).
      caveGroup.userData.caveEntranceWorld = {
        x: cave.position.x,
        y: cave.position.y,
        z: cave.position.z,
      };
      (group.userData.caveGroups ??= []).push(caveGroup);
      group.add(caveGroup);
    }

    // ── Emit the portal frames ───────────────────────────────────────────────
    // One InstancedMesh per boulder type for the WHOLE island (every mouth's
    // frame and rubble in the same buckets), added straight to the island group
    // so the portal keeps reading from across the island — it is a landmark, and
    // only the interior hides behind the 45m LOD gate.
    let portalRockCount = 0;
    for (const [asset, list] of portalXf) {
      const merged = assets.mergedGeometry(asset);
      if (!merged || list.length === 0) continue;
      const src = Array.isArray(merged.material) ? merged.material[0] : merged.material;
      const mat = (src as THREE.MeshStandardMaterial).clone();
      mat.color.copy(portalRockCol);
      mat.roughness = 1;
      mat.metalness = 0;
      mat.flatShading = true;
      mat.needsUpdate = true;
      const inst = new THREE.InstancedMesh(merged.geometry, mat, list.length);
      inst.name = 'cave-portal-rock';
      list.forEach((m, k) => inst.setMatrixAt(k, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = !lowDetail;
      inst.receiveShadow = true;
      group.add(inst);
      portalRockCount += list.length;
    }
    group.userData.cavePortalRocks = portalRockCount;
    group.userData.caveDecorRejects = rejectedDecor;
  }
}
