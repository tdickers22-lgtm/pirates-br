import * as THREE from 'three';
import { SHIP_STATS } from '../../../shared/constants/index.js';
import type { ShipType } from '../../../shared/types/index.js';
import { getHullProfile, hullSplineUAtZ, sampleHullSurface } from '../../../shared/hull.js';
import type { HullProfile } from '../../../shared/hull.js';
import { getCannonDeckLocalPosition, getHelmWheelLocal } from '../../../shared/interactions.js';
import { getShipDeckY } from '../../../shared/utils/index.js';
import { rudderMount } from './stern.js';

/**
 * Ship kit mounting (b4.3c, ships-07). The Blender kit (ship_kit_a.glb from
 * build_ship_kit.py, ship_kit_b.glb from _ship_kit_rigging.py) models every
 * part with its ORIGIN AT THE MOUNT, local +Z out along the surface normal and
 * +Y up. This module computes where each part goes from the shared spline loft
 * (sampleHullSurface) or the deck slab (getShipDeckY) and never from hand
 * offsets, then mounts the GLB nodes there as one InstancedMesh per kit mesh
 * (twenty gunports are one draw, not twenty).
 *
 * `shipKitSockets` is pure (node gates import it: test-ship-sockets grades every
 * socket against the spline). `mountShipKit` needs the loaded kit scenes.
 */

export type ShipKitFile = 'ship_kit_a' | 'ship_kit_b';
export const SHIP_KIT_FILES: readonly ShipKitFile[] = ['ship_kit_a', 'ship_kit_b'];
/** Per-node LOD1/LOD2 siblings (`<node>_LOD1` / `<node>_LOD2`, geometry only). */
export type ShipKitLodFile = 'ship_kit_a_lods' | 'ship_kit_b_lods';
export const SHIP_KIT_LOD_FILES: readonly ShipKitLodFile[] = ['ship_kit_a_lods', 'ship_kit_b_lods'];
/** Kit level per hull LOD root: LOD0 in the detail root, LOD1/LOD2 in the level roots. */
export type ShipKitLevel = 0 | 1 | 2;

/** Which surface a socket sits on; the gate measures the distance to it. */
export type KitSurface = 'hull' | 'stem' | 'transom' | 'deck' | 'post';

export interface KitSocket {
  part: string;
  file: ShipKitFile;
  /** GLB nodes mounted together; each keeps its own local transform (lid hinge, glass). */
  nodes: readonly string[];
  surface: KitSurface;
  /** Ship-local metres (+x starboard, +y up, +z bow). */
  pos: [number, number, number];
  /** The part's local +Z (out of the surface) and +Y (up) in ship space. */
  out: [number, number, number];
  up: [number, number, number];
  scale: number;
  /** 1 starboard, -1 port, 0 centreline. */
  side: 1 | -1 | 0;
  /** Spline parameters the socket was solved at (hull/stem/transom). */
  u?: number;
  v?: number;
  /** Optional per-node extra rotation about local X (gunport lid opened on its hinge). */
  hinge?: Record<string, number>;
  /** A part that rides another part's GLB seat (the galleon's upper gallery
   *  tier, the taffrail lanterns on the sock_stern_*_lantern_k seats): mounted
   *  at socketMatrix(this) x the seat empties in `path` (read from `file`), so
   *  pos/out/up stay the parent's spline socket and the seat comes from the kit. */
  seat?: { file: ShipKitFile; path: readonly string[] };
}

/** On-deck kit II parts the renderer berths (deck frame: +Y deck normal, +Z bow). */
export type DeckKitPart = 'barrel' | 'bell' | 'bilge_pump' | 'cannonball_rack';
export const DECK_KIT_NODES: Record<DeckKitPart, readonly string[]> = {
  barrel: ['barrel'],
  bell: ['bell_belfry', 'bell'],
  bilge_pump: ['bilge_pump', 'bilge_pump_handle'],
  cannonball_rack: ['cannonball_rack'],
};
/** Small deck parts the LOD2 root leaves out (sub-pixel past the LOD1 band). */
export const DECK_KIT_SMALL: ReadonlySet<string> = new Set<string>(['barrel', 'bell', 'bilge_pump', 'cannonball_rack']);

/** Gunport lids hang open while the guns are run out (b4.3d animates them). */
export const GUNPORT_LID_OPEN = -1.2;
/** Figurehead seat height on the stem (fraction of H, the old procedural seat). */
const FIGUREHEAD_Y = 0.72;
/** Gunport centre height (fraction of H): the old frame's height, over the trunnions. */
const GUNPORT_Y = 0.58;
/** Quarter gallery seat (fraction of L aft of midships, fraction of H). */
const QUARTER_GALLERY_Z = -0.42;
const QUARTER_GALLERY_Y = 0.86;

const FIGUREHEAD: Record<ShipType, string> = { sloop: 'figurehead_sloop', brigantine: 'figurehead_brigantine', galleon: 'figurehead_galleon' };

function norm(x: number, y: number, z: number): [number, number, number] {
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** +Y made perpendicular to `out` (Gram-Schmidt), the part's up axis. */
function upFor(out: [number, number, number]): [number, number, number] {
  const d = out[1];
  return norm(-d * out[0], 1 - d * out[1], -d * out[2]);
}

/** The spline point at local (z, y) on the starboard side: v by bisection on y
 *  (y falls monotonically from the sheer to the keel), u from hullSplineUAtZ. */
export function solveHullAt(profile: HullProfile, z: number, y: number): { u: number; v: number } {
  let lo = 0, hi = 1;
  for (let it = 0; it < 26; it++) {
    const mid = (lo + hi) * 0.5;
    const u = hullSplineUAtZ(profile, z, mid);
    if (sampleHullSurface(profile, u, mid).y > y) lo = mid; else hi = mid;
  }
  const v = (lo + hi) * 0.5;
  return { u: hullSplineUAtZ(profile, z, v), v };
}

/** v on a fixed-u row where the row reaches height y. */
function solveRowAt(profile: HullProfile, u: number, y: number): number {
  let lo = 0, hi = 1;
  for (let it = 0; it < 30; it++) {
    const mid = (lo + hi) * 0.5;
    if (sampleHullSurface(profile, u, mid).y > y) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

function hullSocket(profile: HullProfile, part: string, file: ShipKitFile, nodes: readonly string[], z: number, y: number, side: 1 | -1): KitSocket {
  const { u, v } = solveHullAt(profile, z, y);
  const s = sampleHullSurface(profile, u, v);
  const out = norm(side * s.nx, s.ny, s.nz);
  return { part, file, nodes, surface: 'hull', pos: [side * s.x, s.y, s.z], out, up: upFor(out), scale: 1, side, u, v };
}

/** Centreline seat on a row (stem u = 1, transom u = 0): the point between the
 *  port and starboard surfaces, facing along their bisector. */
function centreSocket(profile: HullProfile, part: string, file: ShipKitFile, nodes: readonly string[], u: number, v: number, surface: KitSurface): KitSocket {
  const s = sampleHullSurface(profile, u, v);
  const out = norm(0, s.ny, s.nz);
  return { part, file, nodes, surface, pos: [0, s.y, s.z], out, up: upFor(out), scale: 1, side: 0, u, v };
}

const SOCKET_CACHE = new Map<ShipType, KitSocket[]>();

/**
 * Every hull-mounted kit socket of a class (deck parts come from
 * `deckKitSockets`, whose berths the renderer picks). Cached per class: the
 * sockets depend on the profile and the gun layout only.
 */
export function shipKitSockets(type: ShipType): KitSocket[] {
  const hit = SOCKET_CACHE.get(type);
  if (hit) return hit;
  const profile = getHullProfile(type);
  const stats = SHIP_STATS[type];
  const { H, L } = profile;
  const out: KitSocket[] = [];

  // Figurehead on the stem head.
  out.push(centreSocket(profile, FIGUREHEAD[type], 'ship_kit_a', [FIGUREHEAD[type]], 1, solveRowAt(profile, 1, H * FIGUREHEAD_Y), 'stem'));

  // Stern: galleries on the transom at the sheer (the upper galleon tier rides
  // on the lower one's own socket, sock_stern_gallery_galleon_upper).
  const sternNodes: Record<ShipType, readonly string[]> = {
    sloop: ['stern_transom_sloop', 'stern_transom_sloop_glass'],
    brigantine: ['stern_gallery_brigantine', 'stern_gallery_brigantine_glass'],
    galleon: ['stern_gallery_galleon', 'stern_gallery_galleon_glass'],
  };
  const stern = centreSocket(profile, sternNodes[type][0], 'ship_kit_a', sternNodes[type], 0, 0, 'transom');
  out.push(stern);
  // The galleon's upper tier rides the lower one's seat; the taffrail
  // lanterns (kit II) stand on the lantern seats of the top stern part.
  const upperSeat = ['sock_stern_gallery_galleon_upper'];
  if (type === 'galleon') {
    out.push({ ...stern, part: 'stern_gallery_galleon_upper', nodes: ['stern_gallery_galleon_upper', 'stern_gallery_galleon_upper_glass'], seat: { file: 'ship_kit_a', path: upperSeat } });
  }
  const lanternSeats: Record<ShipType, readonly (readonly string[])[]> = {
    sloop: [['sock_stern_transom_sloop_lantern_0']],
    brigantine: [0, 1].map((k) => [`sock_stern_gallery_brigantine_lantern_${k}`]),
    galleon: [0, 1, 2].map((k) => [...upperSeat, `sock_stern_gallery_galleon_upper_lantern_${k}`]),
  };
  for (const path of lanternSeats[type]) {
    out.push({ ...stern, part: 'taffrail_lantern', file: 'ship_kit_b', nodes: ['taffrail_lantern', 'taffrail_lantern_glass'], seat: { file: 'ship_kit_a', path } });
  }

  // Quarter galleries, both sides (brig + galleon).
  if (type !== 'sloop') {
    const qg = `quarter_gallery_${type}`;
    for (const side of [1, -1] as const) {
      out.push(hullSocket(profile, qg, 'ship_kit_a', [qg, `${qg}_glass`], L * QUARTER_GALLERY_Z, H * QUARTER_GALLERY_Y, side));
    }
  }

  // A gunport over every gun, lid open.
  const perSide = Math.max(1, stats.cannonCount / 2);
  for (let side = 0; side < 2; side++) {
    for (let c = 0; c < perSide; c++) {
      const cz = getCannonDeckLocalPosition(stats, side === 0 ? c : perSide + c).z;
      const sk = hullSocket(profile, 'gunport', 'ship_kit_a', ['gunport', 'gunport_lid'], cz, H * GUNPORT_Y, side === 0 ? 1 : -1);
      sk.hinge = { gunport_lid: GUNPORT_LID_OPEN };
      out.push(sk);
    }
  }

  // Rudder on the sternpost chord (the stock is ShipMeshGroup.rudderPivot).
  const m = rudderMount(profile);
  const dy = m.top.y - m.foot.y, dz = m.top.z - m.foot.z;
  const upAxis = norm(0, dy, dz);
  const aft = norm(0, dz, -dy);
  out.push({
    part: 'rudder', file: 'ship_kit_a', nodes: ['rudder', 'rudder_gudgeons'], surface: 'post',
    pos: [0, m.top.y, m.top.z], out: aft, up: upAxis, scale: (m.length + 0.25) / 3.62, side: 0,
  });

  SOCKET_CACHE.set(type, out);
  return out;
}

/** Deck sockets for on-deck kit parts at berths the renderer chose (x, z). */
export function deckKitSockets(type: ShipType, spots: ReadonlyArray<{ x: number; z: number; yaw: number; part?: DeckKitPart }>): KitSocket[] {
  const deckY = getShipDeckY(0, SHIP_STATS[type]);
  return spots.map((p) => {
    const part = p.part ?? 'barrel';
    const outAxis = norm(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    // Deck parts: +Y is the deck normal, +Z the bow (handoff frames), so the
    // part's "out" is its +Y = deck up and its forward is the yaw.
    return { part, file: 'ship_kit_b' as const, nodes: DECK_KIT_NODES[part], surface: 'deck' as const, pos: [p.x, deckY, p.z], out: [0, 1, 0], up: outAxis, scale: 1, side: 0 };
  });
}

/** The part frame as a matrix: columns x = up × out... built so local +Z = out, +Y = up. */
export function socketMatrix(s: KitSocket, target = new THREE.Matrix4()): THREE.Matrix4 {
  const z = new THREE.Vector3(...s.out);
  const y = new THREE.Vector3(...s.up);
  if (s.surface === 'deck') {
    // Deck: local +Y = deck normal (out), local +Z = the yaw direction (up field).
    const yy = new THREE.Vector3(...s.out), zz = new THREE.Vector3(...s.up);
    const xx = new THREE.Vector3().crossVectors(yy, zz).normalize();
    target.makeBasis(xx, yy, zz);
  } else {
    const x = new THREE.Vector3().crossVectors(y, z).normalize();
    target.makeBasis(x, y, z);
  }
  target.scale(new THREE.Vector3(s.scale, s.scale, s.scale));
  target.setPosition(s.pos[0], s.pos[1], s.pos[2]);
  return target;
}

/** What the mount needs from the asset library (a stub in node gates). */
export interface ShipKitSource {
  has(name: ShipKitFile | ShipKitLodFile): boolean;
  source(name: ShipKitFile | ShipKitLodFile): { scene: THREE.Group } | null;
}

export const KIT_SHARED = 'hwShared';
/** userData key of a hinged bucket (b4.3d): ship/shipMotion.ts re-poses its instances. */
export const KIT_HINGE = 'kitHinge';
/** Instance i = pre[i] x rotX(angle) x post[i] (pre = socket x node frame, post = mesh in node). */
export interface KitHinge { node: string; mesh: THREE.InstancedMesh; pre: THREE.Matrix4[]; post: THREE.Matrix4[] }

/**
 * Mount the kit at `sockets` under `parent` as one InstancedMesh per kit mesh
 * (node x material). Returns the root group, or null when a file is missing.
 * Sockets whose part rides another (the galleon's upper gallery tier) follow
 * their parent's named socket empty from the GLB.
 */
export function mountShipKit(
  sockets: readonly KitSocket[],
  src: ShipKitSource,
  glassMat: THREE.Material | null,
  level: ShipKitLevel = 0,
): THREE.Group | null {
  if (!SHIP_KIT_FILES.every((f) => !sockets.some((s) => s.file === f) || src.has(f))) return null;
  if (level > 0 && !SHIP_KIT_FILES.every((f) => !sockets.some((s) => s.file === f) || src.has(`${f}_lods`))) return null;
  // LOD nodes carry geometry only: bind the LOD0 material of the same name.
  const matByName = new Map<string, THREE.Material>();
  if (level > 0) {
    for (const f of SHIP_KIT_FILES) {
      src.source(f)?.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if ((o as THREE.Mesh).isMesh && m && !Array.isArray(m) && m.name && !matByName.has(m.name)) matByName.set(m.name, m);
      });
    }
  }
  const buckets = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[]; mats: THREE.Matrix4[]; name: string; pre?: THREE.Matrix4[]; post?: THREE.Matrix4[] }>();
  const sockM = new THREE.Matrix4(), nodeM = new THREE.Matrix4(), meshM = new THREE.Matrix4(), hinge = new THREE.Matrix4();
  const place = (scene: THREE.Object3D, nodeName: string, base: THREE.Matrix4, hingeX: number | undefined, lodScene: THREE.Object3D | null) => {
    const node = scene.getObjectByName(nodeName);
    if (!node) return;
    node.updateMatrix();
    nodeM.copy(node.matrix);
    const pre = hingeX !== undefined ? nodeM.clone().premultiply(base) : null;
    if (hingeX) nodeM.multiply(hinge.makeRotationX(hingeX));
    nodeM.premultiply(base);
    // The LOD sibling supplies the geometry; the LOD0 node supplies the frame
    // (origin at the mount, hinge pivots). Panes without a LOD node (glass)
    // reuse the LOD0 mesh at every level.
    const geoNode = (lodScene && level > 0 ? lodScene.getObjectByName(`${nodeName}_LOD${level}`) : null) ?? node;
    geoNode.updateMatrixWorld(true);
    const nodeInv = new THREE.Matrix4().copy(geoNode.matrixWorld).invert();
    geoNode.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshM.multiplyMatrices(nodeInv, mesh.matrixWorld).premultiply(nodeM);
      const key = `${nodeName}:${mesh.uuid}`;
      let b = buckets.get(key);
      if (!b) {
        const m = mesh.material as THREE.Material;
        const bound = geoNode !== node && m && !Array.isArray(m) ? matByName.get(m.name) ?? m : mesh.material;
        const mat = glassMat && /glass/i.test(m?.name ?? '') ? glassMat : bound;
        b = { geo: mesh.geometry, mat, mats: [], name: nodeName };
        buckets.set(key, b);
      }
      b.mats.push(meshM.clone());
      if (pre) {
        (b.pre ??= []).push(pre);
        (b.post ??= []).push(new THREE.Matrix4().multiplyMatrices(nodeInv, mesh.matrixWorld));
      }
    });
  };
  for (const s of sockets) {
    const scene = src.source(s.file)?.scene;
    if (!scene) continue;
    const lodScene = level > 0 ? src.source(`${s.file}_lods`)?.scene ?? null : null;
    socketMatrix(s, sockM);
    if (s.seat) {
      const seatScene = src.source(s.seat.file)?.scene;
      let seated = !!seatScene;
      for (const n of s.seat.path) {
        const e = seatScene?.getObjectByName(n);
        if (!e) { seated = false; break; }
        e.updateMatrix();
        sockM.multiply(e.matrix);
      }
      if (!seated) continue; // a seat the kit lacks: leave the part off rather than float it
    }
    for (const n of s.nodes) place(scene, n, sockM, s.hinge?.[n], lodScene);
  }
  const root = new THREE.Group();
  root.name = level > 0 ? `ship-kit-lod${level}` : 'ship-kit';
  for (const b of buckets.values()) {
    const im = new THREE.InstancedMesh(b.geo, b.mat, b.mats.length);
    im.name = `kit-${b.name}`;
    b.mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = true;
    im.receiveShadow = true;
    im.userData[KIT_SHARED] = true; // library-owned geometry: clear() must not dispose it
    if (b.pre && b.post && b.pre.length === b.mats.length) im.userData[KIT_HINGE] = { node: b.name, mesh: im, pre: b.pre, post: b.post } satisfies KitHinge;
    root.add(im);
  }
  return root;
}

/** Draws a mount adds (one per instanced bucket); the late mount pays this. */
export function kitDrawCount(root: THREE.Object3D | null): number {
  let n = 0;
  root?.traverse((o) => { if ((o as THREE.Mesh).isMesh) n++; });
  return n;
}

// ── Station grip anchors (b4.3f, critique-11) ───────────────────────────────
// Every hand target a station offers the IK solver (applyStationContacts) is
// derived here from the MOUNTED geometry: helm handle pegs and capstan bar ends
// are the outermost vertex clusters of the hardware GLB as it hangs on the
// hull, cannon grips sit behind the breech the GLB barrel reports. ShipRenderer
// only forwards (stationGrips* below); the pre-hardware fallbacks (procedural
// wheel/capstan/gun, drawn until the GLBs stream in) come from the same place,
// so no hand-typed anchor table survives in the renderer. Points are in the
// holder's local frame (the pivot the update loop spins), so the wheel's
// rotation.z, the capstan's rotation.y and the gun's yaw/pitch/recoil carry
// them for free.

/** Handle / bar tips of a spoked part, clustered by angle, in `root` space. */
export function radialTips(root: THREE.Object3D, plane: 'xy' | 'xz'): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const pts: THREE.Vector3[] = [];
  root.traverse((o) => {
    const pos = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry?.getAttribute?.('position') : undefined;
    if (!pos || !(pos as THREE.BufferAttribute).array?.length) return;
    m.multiplyMatrices(inv, o.matrixWorld);
    for (let i = 0; i < pos.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(m));
  });
  const rad = (p: THREE.Vector3) => (plane === 'xy' ? Math.hypot(p.x, p.y) : Math.hypot(p.x, p.z));
  const ang = (p: THREE.Vector3) => (plane === 'xy' ? Math.atan2(p.y, p.x) : Math.atan2(p.z, p.x));
  let maxR = 0;
  for (const p of pts) maxR = Math.max(maxR, rad(p));
  const tips = pts.filter((p) => rad(p) > maxR * 0.93).sort((a, b) => ang(a) - ang(b));
  if (tips.length === 0) return [];
  const clusters: THREE.Vector3[][] = [[tips[0]]];
  for (let i = 1; i < tips.length; i++) {
    if (ang(tips[i]) - ang(tips[i - 1]) > 0.15) clusters.push([]);
    clusters[clusters.length - 1].push(tips[i]);
  }
  // The cluster straddling ±π is one handle cut in two.
  if (clusters.length > 1 && ang(tips[0]) + 2 * Math.PI - ang(tips[tips.length - 1]) <= 0.15) {
    clusters[0].push(...clusters.pop()!);
  }
  return clusters.map((c) => c.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(c.length));
}

export type StationGripKind = 'helm' | 'capstan' | 'cannon';
export interface StationGrips { kind: StationGripKind; points: THREE.Vector3[] }
/** Helm palms close just inside the peg tip (on the turned handle, not its end). */
export const HELM_GRIP_INSET = 0.97;
/** Breech grips: 0.1 m forward of the cascabel end, 0.08 m up, 0.18 m either side. */
export const CANNON_GRIP = { fwd: 0.1, up: 0.08, half: 0.18 } as const;

const TIP_CACHE = new Map<string, THREE.Vector3[]>();
/** Radial tips of one hardware file, measured once per file (GLB units). */
function cachedTips(key: string, node: THREE.Object3D, plane: 'xy' | 'xz'): THREE.Vector3[] {
  let tips = TIP_CACHE.get(key);
  if (!tips || tips.length === 0) {
    tips = radialTips(node, plane);
    if (tips.length > 0) TIP_CACHE.set(key, tips);
  }
  return tips;
}

/** Helm pegs of the mounted wheel GLB (`wheelBody` at GLB scale, the holder
 *  scales it by `scale`); null when the file has no readable spokes. */
export function stationGripsHelm(wheelBody: THREE.Object3D, scale: number): StationGrips | null {
  const tips = cachedTips('wheel', wheelBody, 'xy');
  return tips.length >= 4 ? { kind: 'helm', points: tips.map((p) => p.clone().multiplyScalar(scale * HELM_GRIP_INSET)) } : null;
}

/** Capstan bar ends of the mounted drum GLB (turns with the holder's rotation.y). */
export function stationGripsCapstan(drum: THREE.Object3D, scale: number): StationGrips | null {
  const tips = cachedTips('capstan', drum, 'xz');
  return tips.length >= 4 ? { kind: 'capstan', points: tips.map((p) => p.clone().multiplyScalar(scale)) } : null;
}

/** Breech handles behind the GLB barrel's cascabel (`breechZ` = barrel box min z
 *  relative to the trunnions, GLB units; +X of the pitch pivot is the muzzle). */
export function stationGripsCannon(breechZ: number, scale: number): StationGrips {
  const x = (breechZ + CANNON_GRIP.fwd) * scale;
  return { kind: 'cannon', points: [new THREE.Vector3(x, CANNON_GRIP.up, CANNON_GRIP.half), new THREE.Vector3(x, CANNON_GRIP.up, -CANNON_GRIP.half)] };
}

/** Pre-hardware fallbacks (the procedural wheel/capstan/gun drawn until the GLBs
 *  stream in): the same anchors read off the procedural parts' dimensions. */
export function stationGripsFallback(kind: 'helm', spokes: number, rimR: number): StationGrips;
export function stationGripsFallback(kind: 'capstan' | 'cannon'): StationGrips;
export function stationGripsFallback(kind: StationGripKind, spokes = 8, rimR = 0.6): StationGrips {
  if (kind === 'helm') {
    return { kind, points: Array.from({ length: spokes }, (_, i) => new THREE.Vector3(Math.cos(i / spokes * Math.PI * 2) * (rimR + 0.02), Math.sin(i / spokes * Math.PI * 2) * (rimR + 0.02), 0.1)) };
  }
  if (kind === 'capstan') {
    return { kind, points: Array.from({ length: 8 }, (_, i) => new THREE.Vector3(Math.cos(i / 8 * Math.PI * 2) * 0.66, 0.88, -Math.sin(i / 8 * Math.PI * 2) * 0.66)) };
  }
  return { kind, points: [new THREE.Vector3(-0.28, 0.1, 0.2), new THREE.Vector3(-0.28, 0.1, -0.2)] };
}

// ── Station holders on the spline hull (b4.3f2) ─────────────────────────────
// Where the renderer hangs the wheel and the guns, derived from the SHARED stand
// spots so a body standing on the spot can close its hands on the grips above.
/** Cannon pivot (trunnions) sits this far outboard of the gunner's stand spot:
 *  the brigantine's proven reach (rig-contacts green), now on every class. */
export const CANNON_STAND_REACH = 1.2;
export interface StationAnchors {
  /** Ship-local z of the wheel hub (and its post): getHelmWheelLocal. */
  helmWheelZ: number;
  /** |x| of gun `index`'s pivot: on the rail (W/2 + 0.06), pulled inboard where
   *  the deck narrows so the breech stays within reach of its stand spot. */
  cannonX(index: number): number;
}
export function stationAnchors(stats: (typeof SHIP_STATS)[keyof typeof SHIP_STATS]): StationAnchors {
  return {
    helmWheelZ: getHelmWheelLocal(stats).z,
    cannonX: (index) => Math.min(stats.width * 0.5 + 0.06, Math.abs(getCannonDeckLocalPosition(stats, index).x) + CANNON_STAND_REACH),
  };
}
