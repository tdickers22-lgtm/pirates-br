/**
 * THE GILDED WRECK + THE UNCHARTED SEA.
 *
 * Two things live in here, because they are the same idea at two scales: the
 * open sea should have somewhere to go.
 *
 *  1. THE GILDED WRECK — the mid-match convergence event. A half-sunk ghost
 *     galleon rises at the announced next ring centre for one storm phase. She
 *     has to be READ FROM 300 M, over swell, from a moving deck, by a player who
 *     was not looking: so she is a heeled hull with a mast canted hard across
 *     her, a gold beacon standing out of her, and — once the sun is down — a
 *     ghost-green rim on every spar. Nothing subtle survives 300 m.
 *
 *  2. SEA MICRO-POIs — four fixed, uncharted things in the biggest dead-water
 *     voids (a wreck cluster, gull-circled flotsam, a lone mast on a shoal).
 *     The gulls are the signpost: white specks turning over one point of the
 *     horizon is the oldest "something is there" in seafaring, and it reads long
 *     before the flotsam under them does.
 *
 * BUDGET DISCIPLINE (test-perf-budget: 2900 dock / 2250 open sea):
 *  · every site merges to ONE hull mesh + ONE gull mesh, from shared materials;
 *  · the wreck is 4 draws (hull, rig, beacon shaft, beacon halo);
 *  · no PointLights at all — the glow is emissive plus additive sprites, so this
 *    never competes with the night lantern budget;
 *  · everything static is frozen out of the per-frame world-matrix walk.
 *
 * Her LOOT is not drawn here. Her chests and barrels are ordinary island
 * entities (see Match's world-event section), so the existing chest/barrel
 * meshes, prompts and sync own them — this module only makes sure the meshes
 * get built for entities that appeared mid-match, long after their island did.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Island, SeaPoi, WreckEvent } from '../../shared/types/index.js';
import { WRECK_EVENT, SEA_POI } from '../../shared/constants/index.js';

/** Weathered, salt-bleached planking shared by every hulk in the world. */
const TIMBER = { color: 0x4a3a29, roughness: 0.95, metalness: 0.02 };
/** The wreck's namesake: her gilding, still bright under two hundred years. */
const GILT = 0xf0c257;
/** What the dead leave on the rigging after dark. */
const GHOST = 0x8ff0c0;

interface PoiEntry {
  root: THREE.Group;
  gulls: THREE.InstancedMesh | null;
  gullPhase: number;
  bob: number;
}

interface WreckEntry {
  id: string;
  root: THREE.Group;
  /** Upright, scene-parented: a beacon must never inherit the hull's heel. */
  beacon: THREE.Group;
  /** Everything that takes the ghost rim after dark. */
  ghostMaterials: THREE.MeshStandardMaterial[];
  giltMaterial: THREE.MeshStandardMaterial;
  beaconShaft: THREE.Mesh;
  beaconHalo: THREE.Sprite;
  gulls: THREE.InstancedMesh | null;
  claimAt: number;
}

export interface SeaEventHooks {
  /** Build the meshes for a chest/barrel that arrived after its island did.
   *  Returns true when something was actually built. */
  ensureLootMeshes(islandId: string, chestIds: string[], barrelIds: string[]): void;
}

export class SeaEventRenderer {
  private scene: THREE.Scene | null = null;
  private hooks: SeaEventHooks | null = null;

  private readonly pois = new Map<string, PoiEntry>();
  private wreck: WreckEntry | null = null;
  private wreckLootBuiltFor = '';

  private timberMaterial: THREE.MeshStandardMaterial | null = null;
  private canvasMaterial: THREE.MeshStandardMaterial | null = null;
  private gullMaterial: THREE.MeshStandardMaterial | null = null;
  private gullGeometry: THREE.BufferGeometry | null = null;
  private beaconMaterial: THREE.MeshBasicMaterial | null = null;
  private haloMaterial: THREE.SpriteMaterial | null = null;

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);

  init(scene: THREE.Scene, hooks: SeaEventHooks): void {
    this.scene = scene;
    this.hooks = hooks;
  }

  // ── Reconcile against the snapshot ─────────────────────────────────────────

  /** The POIs are fixed for the life of the world: built once, never moved. */
  syncPois(pois: readonly SeaPoi[] | undefined): void {
    const scene = this.scene;
    if (!scene || !pois || pois.length === 0) return;
    for (const poi of pois) {
      if (this.pois.has(poi.id)) continue;
      const entry = this.buildPoi(poi);
      scene.add(entry.root);
      // The hulks never move; only their gulls do, and those live on their own
      // node inside so the freeze still holds for the timber.
      this.pois.set(poi.id, entry);
    }
  }

  /** Raise or strike the Gilded Wreck to match the snapshot. */
  syncWreck(wreck: WreckEvent | null | undefined, islands: readonly Island[]): void {
    const scene = this.scene;
    if (!scene) return;

    if (!wreck) {
      if (this.wreck) {
        scene.remove(this.wreck.root);
        scene.remove(this.wreck.beacon);
        this.wreck = null;
      }
      this.wreckLootBuiltFor = '';
      return;
    }

    if (!this.wreck || this.wreck.id !== wreck.id) {
      if (this.wreck) {
        scene.remove(this.wreck.root);
        scene.remove(this.wreck.beacon);
      }
      this.wreck = this.buildWreck(wreck);
      scene.add(this.wreck.root);
      scene.add(this.wreck.beacon);
    }

    // Her chests and barrels are island entities that appeared long after the
    // island was built, so nothing else in the client would ever give them a
    // mesh. Ask once, when the host island's copy has actually caught up.
    if (this.wreckLootBuiltFor !== wreck.id && this.hooks) {
      const host = islands.find((island) => island.id === wreck.hostIslandId);
      const arrived = !!host
        && wreck.chestIds.every((id) => host.chests.some((chest) => chest.id === id));
      if (arrived) {
        this.hooks.ensureLootMeshes(wreck.hostIslandId, wreck.chestIds, wreck.barrelIds);
        this.wreckLootBuiltFor = wreck.id;
      }
    }
  }

  // ── Per-frame ──────────────────────────────────────────────────────────────

  /**
   * @param worldTime shared match clock (seconds) — same value the swell uses.
   * @param nightFactor 0 at noon … 1 at deep night (Renderer atmosphere).
   */
  update(worldTime: number, cameraPos: THREE.Vector3, nightFactor: number): void {
    for (const entry of this.pois.values()) {
      // A raft rides the swell; a shoal does not. The bob amplitude was baked
      // into the entry when it was built.
      entry.root.position.y = Math.sin(worldTime * 0.55 + entry.bob) * 0.22;
      entry.root.rotation.z = Math.sin(worldTime * 0.42 + entry.bob) * 0.035;
      this.spinGulls(entry.gulls, worldTime, entry.gullPhase, SEA_POI.GULL_RADIUS);
    }

    const wreck = this.wreck;
    if (!wreck) return;

    // She is a hull awash, not a ship under way: a long, heavy roll with a
    // little lift on it, so she never reads as parked scenery.
    wreck.root.position.y = Math.sin(worldTime * 0.38) * 0.26 - 0.15;
    wreck.root.rotation.z = wreck.root.userData.heel + Math.sin(worldTime * 0.31) * 0.028;

    // Gold shimmer: her gilding catches a slow travelling light, which is what
    // makes a static silhouette read as TREASURE at range.
    const shimmer = 0.55 + 0.45 * Math.sin(worldTime * 1.15);
    wreck.giltMaterial.emissiveIntensity = 0.35 + shimmer * 0.75;

    // After dark the rim comes up on every spar — you find her by the green
    // before you can make out the hull at all.
    const ghost = Math.pow(Math.max(0, Math.min(1, nightFactor)), 0.7);
    // A RIM, not a wash. Early builds lit the sail canvas at full ghost and she
    // read as a floating mint bedsheet: the green belongs on the thin things
    // (spars, yards), where it draws her rigging as a line drawing in the dark.
    const breathe = 1 + 0.16 * Math.sin(worldTime * 0.9);
    for (const material of wreck.ghostMaterials) {
      const strength = material.userData.ghostRim ?? 0.1;
      material.emissiveIntensity = ghost * strength * breathe;
    }

    // The beacon breathes, and it gets brighter the further away you are —
    // near it you want to see the wreck, far from it you want to see the mark.
    const distance = cameraPos.distanceTo(wreck.root.position);
    const reach = Math.min(1, distance / WRECK_EVENT.BEACON_RANGE);
    const pulse = 0.72 + 0.28 * Math.sin(worldTime * 1.7);
    const beaconMat = wreck.beaconShaft.material as THREE.MeshBasicMaterial;
    beaconMat.opacity = (0.16 + reach * 0.3) * pulse;
    wreck.beaconHalo.material.opacity = (0.3 + reach * 0.45) * pulse;
    wreck.beaconHalo.scale.setScalar(34 + reach * 26 + pulse * 4);

    this.spinGulls(wreck.gulls, worldTime, 0.7, 17);
  }

  reset(): void {
    if (this.scene) {
      for (const entry of this.pois.values()) this.scene.remove(entry.root);
      if (this.wreck) {
        this.scene.remove(this.wreck.root);
        this.scene.remove(this.wreck.beacon);
      }
    }
    this.pois.clear();
    this.wreck = null;
    this.wreckLootBuiltFor = '';
  }

  dispose(): void {
    this.reset();
    this.timberMaterial?.dispose();
    this.canvasMaterial?.dispose();
    this.gullMaterial?.dispose();
    this.gullGeometry?.dispose();
    this.beaconMaterial?.dispose();
    this.haloMaterial?.map?.dispose();
    this.haloMaterial?.dispose();
    this.timberMaterial = null;
    this.canvasMaterial = null;
    this.gullMaterial = null;
    this.gullGeometry = null;
    this.beaconMaterial = null;
    this.haloMaterial = null;
  }

  // ── Shared assets ──────────────────────────────────────────────────────────

  private getTimber(): THREE.MeshStandardMaterial {
    if (!this.timberMaterial) this.timberMaterial = new THREE.MeshStandardMaterial(TIMBER);
    return this.timberMaterial;
  }

  private getCanvas(): THREE.MeshStandardMaterial {
    if (!this.canvasMaterial) {
      this.canvasMaterial = new THREE.MeshStandardMaterial({
        color: 0xbdb193, roughness: 1, metalness: 0, side: THREE.DoubleSide,
      });
    }
    return this.canvasMaterial;
  }

  private getGullGeometry(): THREE.BufferGeometry {
    if (this.gullGeometry) return this.gullGeometry;
    // A gull at 200 m is two strokes of white and nothing else. Two thin swept
    // wings and a body — cheap enough to instance five per site.
    // Sized for the JOB, not for anatomy. A real gull at 300 m is invisible, and
    // an invisible signpost is not a signpost — these are wingspan ~1.8 m so the
    // turning specks are still legible from the far side of a dead-water void.
    const parts: THREE.BufferGeometry[] = [];
    const body = new THREE.ConeGeometry(0.16, 0.95, 4);
    body.rotateX(Math.PI * 0.5);
    parts.push(body);
    for (const side of [-1, 1]) {
      const wing = new THREE.BoxGeometry(1.15, 0.04, 0.3);
      wing.translate(side * 0.62, 0.05, -0.04);
      wing.rotateZ(side * -0.22);
      parts.push(wing);
    }
    this.gullGeometry = mergeGeometries(parts, false) ?? body;
    return this.gullGeometry;
  }

  private getGullMaterial(): THREE.MeshStandardMaterial {
    if (!this.gullMaterial) {
      this.gullMaterial = new THREE.MeshStandardMaterial({
        color: 0xf4f1e6, roughness: 0.85, metalness: 0,
        // Birds against a bright sky are always read as light, never as shape.
        emissive: 0xffffff, emissiveIntensity: 0.16,
      });
    }
    return this.gullMaterial;
  }

  private getBeaconMaterial(): THREE.MeshBasicMaterial {
    if (!this.beaconMaterial) {
      this.beaconMaterial = new THREE.MeshBasicMaterial({
        color: GILT,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      });
    }
    return this.beaconMaterial;
  }

  private getHaloMaterial(): THREE.SpriteMaterial {
    if (this.haloMaterial) return this.haloMaterial;
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255, 226, 150, 0.95)');
    grad.addColorStop(0.35, 'rgba(240, 194, 87, 0.45)');
    grad.addColorStop(1, 'rgba(240, 194, 87, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    this.haloMaterial = new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    return this.haloMaterial;
  }

  // ── Sea micro-POIs ─────────────────────────────────────────────────────────

  private buildPoi(poi: SeaPoi): PoiEntry {
    const root = new THREE.Group();
    root.name = `sea_poi_${poi.id}`;
    root.position.set(poi.position.x, 0, poi.position.z);
    root.rotation.y = poi.rotation;

    const timber: THREE.BufferGeometry[] = [];
    const rig: THREE.BufferGeometry[] = [];

    if (poi.kind === 'wreck_cluster') {
      // Three hulks that drifted together and stayed: two on their beam ends,
      // one still nearly upright with her stub mast up.
      const layout = [
        { x: -3.4, z: -2.1, yaw: 0.5, heel: 1.05, len: 9.5 },
        { x: 3.2, z: 1.4, yaw: -0.9, heel: -0.75, len: 8.0 },
        { x: 0.4, z: 4.6, yaw: 2.3, heel: 0.22, len: 7.0 },
      ];
      for (const hulk of layout) {
        for (const part of this.hulkGeometry(hulk.len, 2.5)) {
          part.rotateZ(hulk.heel);
          part.rotateY(hulk.yaw);
          part.translate(hulk.x, 0, hulk.z);
          timber.push(part);
        }
      }
      const stub = new THREE.CylinderGeometry(0.2, 0.28, 7.5, 6);
      stub.translate(0, 3.6, 0);
      stub.rotateZ(0.28);
      stub.rotateY(2.3);
      stub.translate(0.4, 0, 4.6);
      rig.push(stub);
      for (const spar of this.driftSpars(4, poi.radius)) timber.push(spar);
    } else if (poi.kind === 'flotsam') {
      // A raft of lashed spars with a crate still aboard — the kind of thing a
      // hold coughs up. Small, low, and only findable because of the birds.
      const deck = new THREE.BoxGeometry(5.4, 0.28, 3.6);
      deck.translate(0, 0.14, 0);
      timber.push(deck);
      for (let i = 0; i < 5; i++) {
        const plank = new THREE.BoxGeometry(6.2, 0.2, 0.5);
        plank.translate(0, 0.34, -1.4 + i * 0.7);
        plank.rotateY((i - 2) * 0.05);
        timber.push(plank);
      }
      const crate = new THREE.BoxGeometry(1.2, 1.0, 1.1);
      crate.translate(1.1, 0.94, 0.3);
      crate.rotateY(0.4);
      timber.push(crate);
      for (const spar of this.driftSpars(5, poi.radius)) timber.push(spar);
    } else {
      // A single mast standing out of a shoal, no ship left under it — the
      // shoal itself is a real sea rock (server-side), this is what marks it.
      const mast = new THREE.CylinderGeometry(0.26, 0.42, 15, 7);
      mast.translate(0, 7.1, 0);
      mast.rotateZ(0.14);
      rig.push(mast);
      const yard = new THREE.CylinderGeometry(0.16, 0.16, 7.2, 5);
      yard.rotateZ(Math.PI * 0.5);
      yard.translate(0.4, 10.4, 0);
      rig.push(yard);
      // A rag of sail still hanging off the yard.
      const rag = new THREE.PlaneGeometry(4.6, 3.4, 1, 1);
      rag.translate(0.4, 8.6, 0.05);
      const ragMesh = new THREE.Mesh(rag, this.getCanvas());
      ragMesh.name = 'poi_rag';
      root.add(ragMesh);
      for (const spar of this.driftSpars(3, poi.radius * 0.8)) timber.push(spar);
    }

    const timberGeo = mergeGeometries(timber, false);
    if (timberGeo) {
      const mesh = new THREE.Mesh(timberGeo, this.getTimber());
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      root.add(mesh);
    }
    const rigGeo = rig.length > 0 ? mergeGeometries(rig, false) : null;
    if (rigGeo) root.add(new THREE.Mesh(rigGeo, this.getTimber()));

    // THE SIGNPOST. Gulls turning over one point of empty water is what makes a
    // micro-POI findable at all — the flotsam under them is 5 m across.
    const gulls = new THREE.InstancedMesh(this.getGullGeometry(), this.getGullMaterial(), SEA_POI.GULLS);
    gulls.frustumCulled = false;
    gulls.name = 'poi_gulls';
    root.add(gulls);

    const bob = (poi.position.x * 0.013 + poi.position.z * 0.007) % (Math.PI * 2);
    // A raft rides the swell; a mast standing on a reef does not.
    return { root, gulls, gullPhase: bob, bob: poi.kind === 'shoal_mast' ? 0 : bob };
  }

  /** One broken hull: keel, ribs and a run of hull planking, as raw geometry. */
  private hulkGeometry(length: number, beam: number): THREE.BufferGeometry[] {
    const parts: THREE.BufferGeometry[] = [];
    const keel = new THREE.BoxGeometry(length, 0.5, 0.55);
    keel.translate(0, 0.1, 0);
    parts.push(keel);
    const ribCount = 6;
    for (let i = 0; i < ribCount; i++) {
      const t = (i / (ribCount - 1) - 0.5) * length * 0.86;
      // The ribs shorten toward the ends, which is what makes a broken hull
      // read as a hull instead of a ladder.
      const taper = 1 - Math.pow(Math.abs(t) / (length * 0.5), 1.7) * 0.6;
      const rib = new THREE.TorusGeometry(beam * 0.5 * taper, 0.11, 4, 8, Math.PI);
      rib.rotateY(Math.PI * 0.5);
      rib.translate(t, 0.15, 0);
      parts.push(rib);
    }
    // A strake of surviving planking down one side.
    for (const side of [-1, 1]) {
      const strake = new THREE.BoxGeometry(length * 0.78, 0.62, 0.14);
      strake.translate(0, 0.42, side * beam * 0.44);
      parts.push(strake);
    }
    return parts;
  }

  /** Loose spars and planking drifting round a site. */
  private driftSpars(count: number, reach: number): THREE.BufferGeometry[] {
    const parts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + 0.6;
      const d = reach * (0.55 + (i % 3) * 0.14);
      const spar = new THREE.CylinderGeometry(0.13, 0.16, 2.2 + (i % 4) * 0.9, 5);
      spar.rotateZ(Math.PI * 0.5);
      spar.rotateY(angle * 1.7);
      spar.translate(Math.cos(angle) * d, 0.1, Math.sin(angle) * d);
      parts.push(spar);
    }
    return parts;
  }

  // ── The Gilded Wreck ───────────────────────────────────────────────────────

  private buildWreck(wreck: WreckEvent): WreckEntry {
    const root = new THREE.Group();
    root.name = 'gilded_wreck';
    root.position.set(wreck.position.x, 0, wreck.position.z);
    root.rotation.y = wreck.rotation;
    // Heeled hard to starboard and down by the head: the silhouette IS the
    // read. A level hull at 300 m is just another ship.
    const heel = 0.42;
    root.rotation.z = heel;
    root.rotation.x = -0.13;
    root.userData.heel = heel;

    const L = WRECK_EVENT.HULL_HALF_LENGTH;
    const B = WRECK_EVENT.HULL_HALF_BEAM;

    // Everything that takes the ghost rim after dark, collected as it is built.
    const ghostMaterials: THREE.MeshStandardMaterial[] = [];

    // ── Hull: a heavy galleon carcass, awash to her gunports ──
    const hullParts: THREE.BufferGeometry[] = [];
    const hull = new THREE.CylinderGeometry(B, B * 0.55, L * 2, 9, 1, false);
    hull.rotateZ(Math.PI * 0.5);
    hull.scale(1, 1, 0.62);
    // Awash, not sunk: her gunports are at the waterline and her deck line
    // stands clear of it, or from 300 m she is a smudge on the swell.
    hull.translate(0, 2.0, 0);
    hullParts.push(hull);
    // Stern castle — the tall block that says GALLEON from a mile off.
    const castle = new THREE.BoxGeometry(L * 0.42, 5.4, B * 1.5);
    castle.translate(-L * 0.68, 4.6, 0);
    hullParts.push(castle);
    // Bow, stove in and pointing down into the water.
    const bow = new THREE.ConeGeometry(B * 0.8, 7.5, 7);
    bow.rotateZ(-Math.PI * 0.5);
    bow.translate(L * 0.92, 0.6, 0);
    hullParts.push(bow);
    // Ribs where the planking has gone.
    for (let i = 0; i < 7; i++) {
      const t = -L * 0.5 + i * (L / 6);
      const rib = new THREE.TorusGeometry(B * 0.95, 0.16, 4, 10, Math.PI);
      rib.rotateY(Math.PI * 0.5);
      rib.rotateZ(Math.PI);
      rib.translate(t, 3.0, 0);
      hullParts.push(rib);
    }
    const hullGeo = mergeGeometries(hullParts, false)!;
    // Her own timber, not the shared hulk material: she takes a faint ghost rim
    // after dark, and a little more light than a dead hulk so she is still a
    // SHIP at night rather than a hole in the sea.
    const hullMaterial = new THREE.MeshStandardMaterial({
      ...TIMBER, color: 0x5a4733, emissive: GHOST, emissiveIntensity: 0,
    });
    hullMaterial.userData.ghostRim = 0.09;
    ghostMaterials.push(hullMaterial);
    const hullMesh = new THREE.Mesh(hullGeo, hullMaterial);
    root.add(hullMesh);

    // ── Gilding: the reason anyone crosses open water for her ──
    const giltMaterial = new THREE.MeshStandardMaterial({
      color: GILT, roughness: 0.28, metalness: 0.85,
      emissive: GILT, emissiveIntensity: 0.6,
    });
    const giltParts: THREE.BufferGeometry[] = [];
    // Sheer stripe down both sides — one long horizontal glint is the single
    // most legible mark you can put on a hull at range.
    for (const side of [-1, 1]) {
      const stripe = new THREE.BoxGeometry(L * 1.75, 0.55, 0.14);
      stripe.translate(0, 3.4, side * B * 0.63);
      giltParts.push(stripe);
    }
    // Stern galleries and the transom lantern housing.
    const transom = new THREE.BoxGeometry(0.5, 3.4, B * 1.45);
    transom.translate(-L * 0.9, 4.8, 0);
    giltParts.push(transom);
    for (let i = 0; i < 5; i++) {
      const boss = new THREE.SphereGeometry(0.42, 6, 5);
      boss.translate(-L * 0.86, 6.9, -B * 0.6 + i * (B * 0.3));
      giltParts.push(boss);
    }
    const giltMesh = new THREE.Mesh(mergeGeometries(giltParts, false)!, giltMaterial);
    root.add(giltMesh);

    // ── Rigging: the canted mast that reads before anything else ──
    const rigMaterial = new THREE.MeshStandardMaterial({
      color: 0x3d3025, roughness: 0.96, metalness: 0,
      emissive: GHOST, emissiveIntensity: 0,
    });
    rigMaterial.userData.ghostRim = 0.42;
    ghostMaterials.push(rigMaterial);
    const rigParts: THREE.BufferGeometry[] = [];
    const main = new THREE.CylinderGeometry(0.34, 0.6, 26, 7);
    main.translate(0, 13, 0);
    main.rotateZ(-0.55);   // canted the OTHER way from the heel: a broken ship
    main.translate(-L * 0.1, 4.2, 0);
    rigParts.push(main);
    const fore = new THREE.CylinderGeometry(0.26, 0.44, 16, 6);
    fore.translate(0, 8, 0);
    fore.rotateZ(-0.78);
    fore.translate(L * 0.44, 3.6, 0);
    rigParts.push(fore);
    for (const [y, span] of [[15.5, 15], [21, 10]] as const) {
      const yard = new THREE.CylinderGeometry(0.2, 0.2, span, 5);
      yard.rotateX(Math.PI * 0.5);
      yard.rotateZ(-0.55);
      yard.translate(-L * 0.1 - y * 0.52, y * 0.85 + 4.2, 0);
      rigParts.push(yard);
    }
    const rigMesh = new THREE.Mesh(mergeGeometries(rigParts, false)!, rigMaterial);
    root.add(rigMesh);

    // Torn mainsail still bent to the lower yard — the ghost part of the ghost
    // ship, and the biggest single surface for the green to land on.
    const sailMaterial = new THREE.MeshStandardMaterial({
      color: 0xa8a292, roughness: 1, metalness: 0, side: THREE.DoubleSide,
      transparent: true, opacity: 0.5, depthWrite: false,
      emissive: GHOST, emissiveIntensity: 0,
    });
    sailMaterial.userData.ghostRim = 0.1;
    ghostMaterials.push(sailMaterial);
    // Three ragged panels hanging off the lower yard rather than one slab —
    // canvas that has been in the weather for two hundred years has gaps in it,
    // and the gaps are what stop it reading as a billboard.
    const sailGroup = new THREE.Group();
    for (const [i, drop] of [5.6, 7.2, 4.4].entries()) {
      const panel = new THREE.PlaneGeometry(3.4, drop, 1, 1);
      panel.rotateY(Math.PI * 0.5);
      const mesh = new THREE.Mesh(panel, sailMaterial);
      mesh.position.set(0, -drop * 0.5 - 0.3, (i - 1) * 3.7);
      sailGroup.add(mesh);
    }
    sailGroup.position.set(-L * 0.1 - 15.5 * 0.52, 15.5 * 0.85 + 4.2, 0);
    sailGroup.rotation.z = -0.55;
    root.add(sailGroup);

    // ── The beacon: a shaft of gold standing out of her, seen map-wide ──
    // Cone rather than cylinder so it tapers into the sky instead of ending in
    // a hard disc, and additive so it never occludes the ship behind it.
    const shaftGeo = new THREE.ConeGeometry(4.6, 130, 10, 1, true);
    shaftGeo.translate(0, 65, 0);
    const beaconShaft = new THREE.Mesh(shaftGeo, this.getBeaconMaterial().clone());
    beaconShaft.renderOrder = 4;
    // A beacon is a PLUMB LINE. Parenting it to a hull heeled 24 degrees put a
    // gold shaft up the sky at a jaunty angle, which reads as a lens flare bug
    // rather than as a mark on the chart — so it hangs off the scene, not off
    // her, and only borrows her position.
    const beacon = new THREE.Group();
    beacon.position.set(wreck.position.x, 0, wreck.position.z);
    beacon.add(beaconShaft);
    const beaconHalo = new THREE.Sprite(this.getHaloMaterial().clone());
    beaconHalo.position.y = 16;
    beaconHalo.renderOrder = 5;
    beacon.add(beaconHalo);

    // Gulls over a fresh wreck, because of course there are.
    const gulls = new THREE.InstancedMesh(this.getGullGeometry(), this.getGullMaterial(), SEA_POI.GULLS + 3);
    gulls.frustumCulled = false;
    root.add(gulls);

    return {
      id: wreck.id,
      root,
      beacon,
      ghostMaterials,
      giltMaterial,
      beaconShaft,
      beaconHalo,
      gulls,
      claimAt: wreck.claimAt,
    };
  }

  // ── Shared animation ───────────────────────────────────────────────────────

  /** Wheel a ring of gulls round a site — different radii, different heights,
   *  different speeds, so it reads as birds and not as a carousel. */
  private spinGulls(gulls: THREE.InstancedMesh | null, worldTime: number, phase: number, radius: number): void {
    if (!gulls) return;
    const count = gulls.count;
    for (let i = 0; i < count; i++) {
      const lane = 0.72 + (i % 3) * 0.22;
      const speed = 0.34 + (i % 4) * 0.055;
      const angle = worldTime * speed + phase + (i / count) * Math.PI * 2;
      const r = radius * lane;
      // Held well up: birds against the sky read, birds against the sea do not.
      const y = 13 + (i % 4) * 3.4 + Math.sin(worldTime * 0.9 + i) * 1.2;
      this.tmpPos.set(Math.cos(angle) * r, y, Math.sin(angle) * r);
      // Nose along the tangent, banked into the turn.
      this.tmpQuat.setFromEuler(new THREE.Euler(0, -angle + Math.PI * 0.5, 0.35, 'YXZ'));
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      gulls.setMatrixAt(i, this.tmpMatrix);
    }
    gulls.instanceMatrix.needsUpdate = true;
  }
}
