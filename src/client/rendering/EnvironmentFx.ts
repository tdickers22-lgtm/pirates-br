/**
 * Ambient world FX owned outside the island meshes: the island lantern/campfire
 * light budget, volcanic per-frame closures, drifting wind wisps, the storm rain
 * + lightning overlay, and the harvest promote/topple destruction actors.
 */
import * as THREE from 'three';
import { HARVEST, PLAYER, SHIP_STATS, STORM_PHASES } from '../../shared/constants/index.js';
import type { GameState, Island, IslandProp, IslandPropType, Player, Ship } from '../../shared/types/index.js';
import { isPointInsideIslandFootprint, sampleWind } from '../../shared/utils/index.js';
import { getPropGroundY } from '../../shared/props.js';
import type { AssetName } from '../assets/AssetLibrary.js';
import type { SoundEngine } from '../audio/SoundEngine.js';
import type { LanternEmitter, StoryCutsceneRefs, WindWispRecord } from '../core/Game.js';
import type { InputManager } from '../input/InputManager.js';
import type { CombatFx } from './CombatFx.js';
import type { OceanRenderer } from './OceanRenderer.js';
import type { Renderer } from './Renderer.js';
import { makeLanternFlameTexture, makeLanternGlowTexture, makeWindWispTexture } from './factories/TextureFactory.js';

/** Zero-scale matrix used to collapse a removed prop's InstancedMesh slot. */
export const ZERO_SCALE_MAT4 = new THREE.Matrix4().makeScale(0, 0, 0);

export type EnvironmentFxView = {
  readonly audio: SoundEngine;
  readonly combatFx: CombatFx;
  readonly input: InputManager;
  readonly ocean: OceanRenderer;
  readonly renderer: Renderer;
  readonly islandMeshes: Map<string, THREE.Group>;
  readonly islandPropInstances: Map<string, Map<number, { inst: THREE.InstancedMesh; index: number }>>;
  readonly magmaPulseUniform: { value: number };
  readonly playersById: Map<string, Player>;
  readonly state: GameState | null;
  readonly stormWeatherIntensity: number;
  storyCutscene: StoryCutsceneRefs | null;
  buildPropInstance(type: AssetName, position: THREE.Vector3, yaw: number, scale?: number): THREE.Group | null;
  disposeSceneObject(root: THREE.Object3D): void;
  distance2D(ax: number, az: number, bx: number, bz: number): number;
  getLocalPlayer(): Player | null;
  getTrackedShip(): Ship | null;
};

export class EnvironmentFx {
  constructor(private readonly view: EnvironmentFxView) {}

  // Island lantern / campfire warm-light budget.
  readonly lanternRoot = new THREE.Group();
  readonly lanternLightPool: THREE.PointLight[] = [];
  readonly campfireLightPool: THREE.PointLight[] = [];
  readonly lanternEmitters: LanternEmitter[] = [];
  readonly assignedLanterns: LanternEmitter[] = [];
  readonly assignedCampfires: LanternEmitter[] = [];
  lanternGlowTexture: THREE.Texture | null = null;
  lanternFlameTexture: THREE.Texture | null = null;
  /** Per-frame FX closures for volcanic islands (ash drift, embers, smoke,
   *  caldera lava, erupting geyser plumes). Cleared with the island meshes. */
  volcanicFx: Array<(dt: number, worldTime: number, camera: THREE.Vector3) => void> = [];
  lightningFlash: THREE.PointLight | null = null;
  lightningTimer = 4 + Math.random() * 6;
  stormRainCanvas: HTMLCanvasElement | null = null;
  stormRainCtx: CanvasRenderingContext2D | null = null;
  stormLightningFlashEl: HTMLDivElement | null = null;
  stormLightningFlashOpacity = 0;
  lightningLightPool: THREE.PointLight | null = null;
  lightningBolt: THREE.Line | null = null;
  readonly windWispTexture = makeWindWispTexture();
  /** Locally-promoted harvest target: the instanced palm/boulder is swapped for a
   *  live clone while the axe works it, so strikes shake it and completion plays a
   *  real breakdown. One slot — the axe only ever works one prop at a time. */
  harvestPromoted: {
    islandId: string;
    propId: number;
    type: IslandPropType;
    node: THREE.Object3D;
    /** Original instance matrix, restored on a clean demote (chop abandoned). */
    savedMatrix: THREE.Matrix4;
    basePos: THREE.Vector3;
    /** World-space height of the clone (crown offset for palm FX). */
    height: number;
    shakeTimer: number;
    shakeSeed: number;
  } | null = null;
  /** Felled palms mid-topple → bounce → sink-and-fade (promoted clones, or
   *  just-in-time clones when a REMOTE player felled the tree). */
  readonly harvestFalls: Array<{
    node: THREE.Object3D;
    age: number;
    baseYaw: number;
    fallDirX: number;
    fallDirZ: number;
    trunkHeight: number;
    baseLocalY: number;
    baseWorld: THREE.Vector3;
    impactFired: boolean;
    fadeMats: THREE.Material[] | null;
  }> = [];
  /** Own copy of the 1.4Hz chop-beat edge detector (audioFrameTriggers keeps its own). */
  prevHarvestChopCycle = 1;
  readonly tempHarvestVec = new THREE.Vector3();
  readonly tempHarvestQuatA = new THREE.Quaternion();
  readonly tempHarvestQuatB = new THREE.Quaternion();
  /** True while the axe has a harvestable in range — gates the chop thunk. */
  harvestTargetActive = false;
  readonly windWispMeshes: WindWispRecord[] = [];
  readonly windWisps = new THREE.Group();

  // ── Harvest destruction: promote-on-chop + real breakdown ─────────────────
  // The instanced palm/boulder under the local axe is swapped for a live GLB
  // clone so each strike can shake it and completion can topple/burst it for
  // real instead of the prop silently zero-scaling away.

  /** Nearest choppable palm/boulder within axe range — the SAME nearest-prop
   *  logic the harvest prompt uses, shared so prompt and promotion agree. */
  findHarvestTarget(player: Player): { prop: IslandProp; island: Island } | null {
    if (!this.view.state) return null;
    let bestProp: IslandProp | null = null;
    let bestIsland: Island | null = null;
    let bestD: number = HARVEST.RANGE;
    for (const isl of this.view.state.islands) {
      if (!isl.props?.length) continue;
      if (!isPointInsideIslandFootprint(isl, player.position.x, player.position.z, 8)) continue;
      for (const prop of isl.props) {
        if (!prop.type.startsWith('palm_') && !prop.type.startsWith('boulder_')) continue;
        const d = this.view.distance2D(player.position.x, player.position.z, prop.x, prop.z);
        if (d < bestD) {
          bestD = d;
          bestProp = prop;
          bestIsland = isl;
        }
      }
    }
    return bestProp && bestIsland ? { prop: bestProp, island: bestIsland } : null;
  }

  /** Live clone of an instanced prop at its exact registry transform, parented
   *  into the island group (same space the InstancedMesh slots live in). */
  buildHarvestClone(island: Island, prop: IslandProp): THREE.Object3D | null {
    const slot = prop.id !== undefined ? this.view.islandPropInstances.get(island.id)?.get(prop.id) : undefined;
    const parent = slot?.inst.parent ?? this.view.islandMeshes.get(island.id);
    if (!parent) return null;
    const node = this.view.buildPropInstance(
      prop.type as AssetName,
      new THREE.Vector3(prop.x - island.position.x, getPropGroundY(island, prop), prop.z - island.position.z),
      prop.yaw,
      prop.scale,
    );
    if (!node) return null;
    node.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
    });
    parent.add(node);
    return node;
  }

  /** Swap the instance for a live clone: zero the instance slot (keeping its
   *  matrix for a clean demote) and stand the clone at the same transform. */
  promoteHarvestProp(island: Island, prop: IslandProp) {
    if (prop.id === undefined) return;
    const slot = this.view.islandPropInstances.get(island.id)?.get(prop.id);
    if (!slot) return;
    const node = this.buildHarvestClone(island, prop);
    if (!node) return;
    const savedMatrix = new THREE.Matrix4();
    slot.inst.getMatrixAt(slot.index, savedMatrix);
    slot.inst.setMatrixAt(slot.index, ZERO_SCALE_MAT4);
    slot.inst.instanceMatrix.needsUpdate = true;
    this.harvestPromoted = {
      islandId: island.id,
      propId: prop.id,
      type: prop.type,
      node,
      savedMatrix,
      basePos: node.position.clone(),
      height: new THREE.Box3().setFromObject(node).getSize(this.tempHarvestVec).y,
      shakeTimer: 0,
      shakeSeed: 0,
    };
  }

  /** Chop abandoned before completion: restore the instance matrix, drop the clone. */
  demotePromotedHarvestProp() {
    const promoted = this.harvestPromoted;
    if (!promoted) return;
    this.harvestPromoted = null;
    const slot = this.view.islandPropInstances.get(promoted.islandId)?.get(promoted.propId);
    if (slot) {
      slot.inst.setMatrixAt(slot.index, promoted.savedMatrix);
      slot.inst.instanceMatrix.needsUpdate = true;
    }
    promoted.node.removeFromParent();
    this.view.disposeSceneObject(promoted.node);
  }

  /** Start a felled palm's topple: away from the harvester when known, else a
   *  random lean. The node animates in updateHarvestDestruction. */
  beginPalmTopple(node: THREE.Object3D, byPlayerId: string | undefined) {
    node.getWorldPosition(this.tempHarvestVec);
    const baseWorld = this.tempHarvestVec.clone();
    const harvester = byPlayerId ? this.view.playersById.get(byPlayerId) : undefined;
    let dirX = harvester ? baseWorld.x - harvester.position.x : 0;
    let dirZ = harvester ? baseWorld.z - harvester.position.z : 0;
    const len = Math.hypot(dirX, dirZ);
    if (len < 0.3) {
      const theta = Math.random() * Math.PI * 2;
      dirX = Math.cos(theta);
      dirZ = Math.sin(theta);
    } else {
      dirX /= len;
      dirZ /= len;
    }
    const height = new THREE.Box3().setFromObject(node).getSize(this.tempHarvestVec).y;
    this.harvestFalls.push({
      node,
      age: 0,
      baseYaw: node.rotation.y,
      fallDirX: dirX,
      fallDirZ: dirZ,
      trunkHeight: Math.max(1.5, height),
      baseLocalY: node.position.y,
      baseWorld,
      impactFired: false,
      fadeMats: null,
    });
  }

  /** Fade prep for the sink phase: clone every material (the GLB library ones
   *  are shared) so opacity can animate; clones are disposed with the node. */
  makeHarvestNodeFadable(node: THREE.Object3D): THREE.Material[] {
    const mats: THREE.Material[] = [];
    node.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.material) return;
      const swap = (material: THREE.Material) => {
        const clone = material.clone();
        clone.transparent = true;
        mats.push(clone);
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
    return mats;
  }

  /** Per-frame driver: promote/demote the live chop target, pulse strike FX on
   *  the 1.4Hz swing beat, and play out palm topples. */
  updateHarvestDestruction(dt: number) {
    const player = this.view.getLocalPlayer();
    const chopping = !!player
      && player.equippedTool === 'axe'
      && player.state === 'alive'
      && !player.carryingChestId
      && this.view.input.isFiring();
    const target = chopping && player ? this.findHarvestTarget(player) : null;
    this.harvestTargetActive = !!target;

    if (!target || target.prop.id === undefined) {
      this.demotePromotedHarvestProp();
    } else if (
      !this.harvestPromoted
      || this.harvestPromoted.islandId !== target.island.id
      || this.harvestPromoted.propId !== target.prop.id
    ) {
      this.demotePromotedHarvestProp();
      this.promoteHarvestProp(target.island, target.prop);
    }

    // Strike beat — same clock as the axe viewmodel + playAxeChop (beat at 0.75).
    const chopCycle = (this.view.ocean.getTime() * 1.4) % 1;
    const struck = chopping && chopCycle >= 0.75 && this.prevHarvestChopCycle < 0.75;
    this.prevHarvestChopCycle = chopping ? chopCycle : 1;

    const promoted = this.harvestPromoted;
    if (promoted && player) {
      const isPalm = promoted.type.startsWith('palm_');
      if (struck) {
        promoted.shakeTimer = 0.3;
        promoted.shakeSeed = Math.random() * Math.PI * 2;
        // Strike point: trunk/face height, nudged toward the axe wielder.
        promoted.node.getWorldPosition(this.tempHarvestVec);
        const toX = player.position.x - this.tempHarvestVec.x;
        const toZ = player.position.z - this.tempHarvestVec.z;
        const toLen = Math.hypot(toX, toZ) || 1;
        this.tempHarvestVec.x += (toX / toLen) * 0.4;
        this.tempHarvestVec.z += (toZ / toLen) * 0.4;
        if (isPalm) {
          this.tempHarvestVec.y += 1.1;
          this.view.combatFx.emitWoodChips(this.tempHarvestVec);
          // Frond shiver at the crown.
          this.tempHarvestVec.x -= (toX / toLen) * 0.4;
          this.tempHarvestVec.z -= (toZ / toLen) * 0.4;
          this.tempHarvestVec.y += promoted.height - 1.4;
          this.view.combatFx.emitLeafPuff(this.tempHarvestVec);
        } else {
          this.tempHarvestVec.y += Math.min(0.7, promoted.height * 0.5);
          this.view.combatFx.emitStoneChips(this.tempHarvestVec);
        }
      }
      // Strike impulse: palms whip at the trunk, boulders jitter in place.
      const node = promoted.node;
      if (promoted.shakeTimer > 0) {
        promoted.shakeTimer = Math.max(0, promoted.shakeTimer - dt);
        const k = promoted.shakeTimer / 0.3;
        const wobble = Math.sin((0.3 - promoted.shakeTimer) * 42 + promoted.shakeSeed) * 0.04 * k * k;
        if (isPalm) {
          node.rotation.x = wobble * Math.cos(promoted.shakeSeed);
          node.rotation.z = wobble * Math.sin(promoted.shakeSeed);
        } else {
          node.position.x = promoted.basePos.x + wobble * 0.55;
          node.position.z = promoted.basePos.z + wobble * 0.4;
        }
      } else {
        node.rotation.x = 0;
        node.rotation.z = 0;
        node.position.copy(promoted.basePos);
      }
    }

    // Palm topple playback: ease-in fall (gravity feel) → damped bounce at
    // ~85° → sink 1.5m + fade → gone.
    const TOPPLE = 1.1;
    const BOUNCE = 0.35;
    const SINK = 0.7;
    const FALL_ANGLE = 1.484; // ~85°
    for (let index = this.harvestFalls.length - 1; index >= 0; index--) {
      const fall = this.harvestFalls[index];
      fall.age += dt;
      const node = fall.node;
      let tilt: number;
      if (fall.age < TOPPLE) {
        const t = fall.age / TOPPLE;
        tilt = FALL_ANGLE * t * t * (0.4 + 0.6 * t); // accelerating lean
      } else {
        const s = fall.age - TOPPLE;
        tilt = FALL_ANGLE - Math.abs(Math.sin(s * 16)) * 0.06 * Math.exp(-s * 7);
        if (!fall.impactFired) {
          fall.impactFired = true;
          // Crown slams down trunkHeight out along the fall direction.
          this.tempHarvestVec.set(
            fall.baseWorld.x + fall.fallDirX * fall.trunkHeight * 0.9,
            fall.baseWorld.y + 0.3,
            fall.baseWorld.z + fall.fallDirZ * fall.trunkHeight * 0.9,
          );
          this.view.combatFx.emitLeafPuff(this.tempHarvestVec, 10);
          this.view.combatFx.emitTreeFallImpact(this.tempHarvestVec, fall.baseWorld.y);
          this.view.audio.playTreeFallThud(this.view.renderer.camera.position.distanceTo(this.tempHarvestVec));
        }
      }
      // Tip about the base: tilt axis ⊥ fall direction, composed over the yaw.
      this.tempHarvestVec.set(fall.fallDirZ, 0, -fall.fallDirX);
      this.tempHarvestQuatA.setFromAxisAngle(this.tempHarvestVec, tilt);
      this.tempHarvestVec.set(0, 1, 0);
      this.tempHarvestQuatB.setFromAxisAngle(this.tempHarvestVec, fall.baseYaw);
      node.quaternion.multiplyQuaternions(this.tempHarvestQuatA, this.tempHarvestQuatB);
      if (fall.age >= TOPPLE + BOUNCE) {
        const sinkT = Math.min(1, (fall.age - TOPPLE - BOUNCE) / SINK);
        if (!fall.fadeMats) fall.fadeMats = this.makeHarvestNodeFadable(node);
        node.position.y = fall.baseLocalY - 1.5 * sinkT;
        for (const material of fall.fadeMats) material.opacity = 1 - sinkT;
        if (sinkT >= 1) {
          node.removeFromParent();
          this.view.disposeSceneObject(node);
          this.harvestFalls.splice(index, 1);
        }
      }
    }
  }

  // ── Island lantern / campfire warm-light budget ──────────────────────────
  // Shared point-light pools (added once, reused across matches) plus per-emitter
  // additive glow / flame sprites. The nearest N of each kind are lit for real at
  // night; everything else is a cheap sprite. See updateLanterns().
  initLanternSystem() {
    this.lanternGlowTexture = makeLanternGlowTexture();
    this.lanternFlameTexture = makeLanternFlameTexture();
    for (let i = 0; i < 6; i++) {
      const light = new THREE.PointLight(0xffb257, 0, 24, 1.6);
      light.visible = false;
      this.lanternRoot.add(light);
      this.lanternLightPool.push(light);
    }
    for (let i = 0; i < 4; i++) {
      const light = new THREE.PointLight(0xff7a30, 0, 21, 1.5);
      light.visible = false;
      this.lanternRoot.add(light);
      this.campfireLightPool.push(light);
    }
    this.view.renderer.scene.add(this.lanternRoot);
  }

  /** Register a warm island light. `container` is an island sub-group (dock/camp/
   *  tavern/cave); the anchor tracks its transform so world positions stay correct. */
  registerLanternEmitter(
    container: THREE.Object3D,
    localX: number,
    localY: number,
    localZ: number,
    kind: 'lantern' | 'campfire',
  ) {
    if (!this.lanternGlowTexture) return;
    const anchor = new THREE.Object3D();
    anchor.position.set(localX, localY, localZ);
    container.add(anchor);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.lanternGlowTexture,
      color: kind === 'campfire' ? 0xff8a3c : 0xffbb66,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity: 0,
    }));
    glow.scale.setScalar(kind === 'campfire' ? 3.4 : 2.1);
    glow.visible = false;
    this.lanternRoot.add(glow);

    let flame: THREE.Sprite | null = null;
    if (kind === 'campfire' && this.lanternFlameTexture) {
      flame = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.lanternFlameTexture,
        color: 0xffb257,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.85,
      }));
      flame.center.set(0.5, 0.08); // pivot near the base so it grows upward
      flame.scale.set(0.5, 0.9, 1);
      this.lanternRoot.add(flame);
    }

    this.lanternEmitters.push({
      anchor, kind, glow, flame,
      worldPos: new THREE.Vector3(),
      dist: 0,
      phase: Math.random() * Math.PI * 2,
    });
  }

  updateLanterns(nf: number, cameraPos: THREE.Vector3, t: number) {
    if (this.lanternEmitters.length === 0) return;
    const day = nf <= 0.02;

    for (const e of this.lanternEmitters) {
      e.anchor.getWorldPosition(e.worldPos);
      e.dist = e.worldPos.distanceTo(cameraPos);
    }

    const lanterns = this.lanternEmitters.filter((e) => e.kind === 'lantern');
    const campfires = this.lanternEmitters.filter((e) => e.kind === 'campfire');
    this.assignLanternBudget(lanterns, this.assignedLanterns, this.lanternLightPool.length);
    this.assignLanternBudget(campfires, this.assignedCampfires, this.campfireLightPool.length);

    for (let i = 0; i < this.lanternLightPool.length; i++) {
      const light = this.lanternLightPool[i];
      const e = this.assignedLanterns[i];
      if (day || !e) {
        light.visible = false;
        light.intensity = 0;
      } else {
        const flicker = 1 + Math.sin(t * 7.3 + e.phase) * 0.05 + Math.sin(t * 13.7 + e.phase * 1.7) * 0.03;
        light.position.copy(e.worldPos);
        light.intensity = nf * 2.1 * flicker;
        light.visible = true;
      }
    }
    for (let i = 0; i < this.campfireLightPool.length; i++) {
      const light = this.campfireLightPool[i];
      const e = this.assignedCampfires[i];
      if (day || !e) {
        light.visible = false;
        light.intensity = 0;
      } else {
        const flicker = 1 + Math.sin(t * 11 + e.phase) * 0.24 + Math.sin(t * 23 + e.phase * 2.1) * 0.14 + (Math.random() - 0.5) * 0.08;
        light.position.copy(e.worldPos);
        light.intensity = nf * 2.5 * Math.max(0.25, flicker);
        light.visible = true;
      }
    }

    for (const e of this.lanternEmitters) {
      const hasRealLight = e.kind === 'lantern'
        ? this.assignedLanterns.includes(e)
        : this.assignedCampfires.includes(e);
      const glowFlicker = e.kind === 'campfire'
        ? 1 + Math.sin(t * 12 + e.phase) * 0.18
        : 1 + Math.sin(t * 6 + e.phase) * 0.06;
      const glowBase = hasRealLight ? 0.3 : 0.85;
      const glowOpacity = day ? 0 : nf * glowBase * glowFlicker;
      e.glow.position.copy(e.worldPos);
      e.glow.material.opacity = glowOpacity;
      e.glow.visible = glowOpacity > 0.01;

      if (e.flame) {
        // A lit campfire always shows a small flame; it grows and brightens at night.
        const flick = 0.85 + Math.sin(t * 15 + e.phase) * 0.12 + Math.sin(t * 27 + e.phase * 1.9) * 0.07;
        e.flame.position.copy(e.worldPos);
        e.flame.scale.set(0.4 * (0.92 + (flick - 0.85) * 0.5), (0.5 + nf * 0.5) * flick, 1);
        e.flame.material.opacity = (0.5 + nf * 0.42) * flick;
        e.flame.visible = true;
      }
    }
  }

  /** Fill the light budget from the nearest emitters, with 15%-closer hysteresis so
   *  the active set doesn't pop as the camera drifts between equidistant sources. */
  assignLanternBudget(emitters: LanternEmitter[], assigned: LanternEmitter[], budget: number) {
    for (let i = assigned.length - 1; i >= 0; i--) {
      if (!emitters.includes(assigned[i])) assigned.splice(i, 1);
    }
    while (assigned.length < budget) {
      let best: LanternEmitter | null = null;
      for (const e of emitters) {
        if (assigned.includes(e)) continue;
        if (!best || e.dist < best.dist) best = e;
      }
      if (!best) break;
      assigned.push(best);
    }
    for (let guard = 0; guard <= budget; guard++) {
      let furthest: LanternEmitter | null = null;
      for (const e of assigned) if (!furthest || e.dist > furthest.dist) furthest = e;
      let nearestOut: LanternEmitter | null = null;
      for (const e of emitters) {
        if (assigned.includes(e)) continue;
        if (!nearestOut || e.dist < nearestOut.dist) nearestOut = e;
      }
      if (furthest && nearestOut && nearestOut.dist < furthest.dist * 0.85) {
        assigned[assigned.indexOf(furthest)] = nearestOut;
      } else {
        break;
      }
    }
  }

  clearLanternEmitters() {
    for (const e of this.lanternEmitters) {
      this.lanternRoot.remove(e.glow);
      e.glow.material.dispose();
      if (e.flame) {
        this.lanternRoot.remove(e.flame);
        e.flame.material.dispose();
      }
    }
    this.lanternEmitters.length = 0;
    this.assignedLanterns.length = 0;
    this.assignedCampfires.length = 0;
    for (const light of this.lanternLightPool) { light.visible = false; light.intensity = 0; }
    for (const light of this.campfireLightPool) { light.visible = false; light.intensity = 0; }
  }

  updateVolcanicFx(dt: number, worldTime: number) {
    if (this.volcanicFx.length === 0) return;
    // Warm flicker in ~[0.55, 1.1]: a slow throb plus a faster shimmer.
    const throb = Math.sin(worldTime * 1.6) * 0.5 + 0.5;
    const shimmer = Math.sin(worldTime * 7.3 + 1.7) * 0.5 + 0.5;
    this.view.magmaPulseUniform.value = 0.62 + throb * 0.34 + shimmer * 0.08;
    const cam = this.view.renderer.camera.position;
    for (const fx of this.volcanicFx) fx(dt, worldTime, cam);
  }

  initWindWisps() {
    if (this.windWispMeshes.length > 0) return;

    const geometry = new THREE.PlaneGeometry(3.1, 0.22);
    const count = this.view.renderer.getQuality() === 'low' ? 0 : this.view.renderer.getQuality() === 'balanced' ? 4 : 8;
    if (count === 0) {
      this.windWisps.visible = false;
      return;
    }
    for (let index = 0; index < count; index++) {
      const material = new THREE.MeshBasicMaterial({
        map: this.windWispTexture,
        color: 0xe5f7ff,
        transparent: true,
        opacity: 0.032 + Math.random() * 0.025,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 3;
      this.windWisps.add(mesh);
      this.windWispMeshes.push({
        mesh,
        radius: 1.2 + Math.random() * 4.8,
        height: 0.18 + Math.random() * 1.7,
        phase: Math.random(),
        speed: 0.16 + Math.random() * 0.18,
        sway: (Math.random() - 0.5) * 1.8,
        tilt: (Math.random() - 0.5) * 0.08,
      });
    }
  }

  updateWindWisps() {
    if (this.windWispMeshes.length === 0) {
      this.windWisps.visible = false;
      return;
    }
    const player = this.view.getLocalPlayer();
    if (!player) {
      this.windWisps.visible = false;
      return;
    }

    const trackedShip = this.view.getTrackedShip();
    const time = this.view.ocean.getTime();
    const wind = sampleWind(time);
    const dirX = Math.sin(wind.direction);
    const dirZ = Math.cos(wind.direction);
    const rightX = dirZ;
    const rightZ = -dirX;
    const shipDeckHeight = trackedShip ? SHIP_STATS[trackedShip.type].height : 0;
    const anchorX = trackedShip && player.onShipId === trackedShip.id ? trackedShip.position.x : player.position.x;
    const anchorY = trackedShip && player.onShipId === trackedShip.id
      ? trackedShip.position.y + shipDeckHeight + 1.1
      : player.position.y + PLAYER.HEIGHT * 0.6;
    const anchorZ = trackedShip && player.onShipId === trackedShip.id ? trackedShip.position.z : player.position.z;
    const laneLength = trackedShip ? SHIP_STATS[trackedShip.type].length * 0.95 : 10;
    this.windWisps.visible = true;

    for (const wisp of this.windWispMeshes) {
      const cycle = ((time * wisp.speed + wisp.phase) % 1 + 1) % 1;
      const along = (cycle - 0.5) * laneLength;
      const lateral = Math.sin(time * 0.85 + wisp.phase * Math.PI * 2) * wisp.radius + wisp.sway;
      const bob = Math.sin(time * 1.8 + wisp.phase * Math.PI * 4) * 0.2;
      wisp.mesh.position.set(
        anchorX + dirX * along + rightX * lateral,
        anchorY + wisp.height + bob,
        anchorZ + dirZ * along + rightZ * lateral,
      );
      wisp.mesh.rotation.set(wisp.tilt, wind.direction, 0);
      wisp.mesh.scale.set(0.86 + wind.strength * 0.78, 1 + wind.strength * 0.3, 1);
      const alpha = (0.028 + wind.strength * 0.052) * (1 - Math.abs(cycle - 0.5) * 1.05);
      (wisp.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0.01, alpha);
    }
  }

  setupStormWeatherOverlay() {
    const wrap = document.createElement('div');
    wrap.id = 'storm-weather-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:50;overflow:hidden;';
    const cvs = document.createElement('canvas');
    cvs.id = 'storm-rain-canvas';
    cvs.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
    const flash = document.createElement('div');
    flash.id = 'storm-lightning-flash';
    flash.style.cssText = 'position:absolute;inset:0;background:#9fc4e6;opacity:0;mix-blend-mode:soft-light;';
    wrap.appendChild(cvs);
    wrap.appendChild(flash);
    const hud = document.getElementById('hud');
    if (hud?.parentNode) {
      hud.parentNode.insertBefore(wrap, hud);
    } else {
      document.body.appendChild(wrap);
    }
    this.stormRainCanvas = cvs;
    this.stormRainCtx = cvs.getContext('2d');
    this.stormLightningFlashEl = flash;
  }

  computeStormWeatherIntensity(): number {
    if (!this.view.state) return 0;
    const player = this.view.getLocalPlayer();
    if (!player) return 0;
    const dist = this.view.distance2D(player.position.x, player.position.z, this.view.state.storm.centerX, this.view.state.storm.centerZ);

    const safeRadius = Math.max(1, this.view.state.storm.safeRadius);
    const phase = this.view.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);
    const phaseBoost = Math.min(1, phase / maxPhase) * 0.2;
    const shrinkBoost = this.view.state.storm.shrinking ? 0.08 + this.view.state.storm.shrinkProgress * 0.08 : 0;

    // Crossfade across a ±30m band at the wall — weather used to snap from
    // 0.24 to 0.52+ the frame you crossed the boundary.
    const distOutside = dist - safeRadius;
    const outsideBlend = THREE.MathUtils.smoothstep(distOutside, -30, 30);
    const stormDepth = THREE.MathUtils.clamp(distOutside / 240, 0, 1);
    const edgeFade = THREE.MathUtils.clamp((dist / safeRadius - 0.84) / 0.16, 0, 1);
    const insideIntensity = Math.min(0.24, edgeFade * 0.14 + shrinkBoost * 0.45);
    const outsideIntensity = Math.min(1, 0.52 + phaseBoost + shrinkBoost + stormDepth * 0.32);
    return THREE.MathUtils.lerp(insideIntensity, outsideIntensity, outsideBlend);
  }

  computeStormRainIntensity(): number {
    if (!this.view.state) return 0;
    const player = this.view.getLocalPlayer();
    if (!player) return 0;

    const dist = this.view.distance2D(player.position.x, player.position.z, this.view.state.storm.centerX, this.view.state.storm.centerZ);
    const safeRadius = Math.max(1, this.view.state.storm.safeRadius);
    const phase = this.view.state.storm.phase;
    const maxPhase = Math.max(1, STORM_PHASES.length);

    // Rain builds across the wall band instead of popping on at the boundary.
    const distOutside = dist - safeRadius;
    const outsideBlend = THREE.MathUtils.smoothstep(distOutside, -25, 35);
    if (outsideBlend <= 0.001) return 0;
    const stormDepth = THREE.MathUtils.clamp(distOutside / 220, 0, 1);
    const shrinkBoost = this.view.state.storm.shrinking ? 0.08 : 0;
    return Math.min(1, 0.34 + stormDepth * 0.42 + (phase / maxPhase) * 0.2 + shrinkBoost) * outsideBlend;
  }

  /** World-space rain: wind-blown line-segment drops falling around the
   *  camera (replaces the old screen-space canvas overlay — rain now exists
   *  in the world, slants with the wind, and reads correctly in motion). */
  rain3D: {
    lines: THREE.LineSegments;
    material: THREE.LineBasicMaterial;
    geo: THREE.BufferGeometry;
    pos: Float32Array;
    drops: number;
  } | null = null;

  ensureRain3D() {
    if (this.rain3D) return this.rain3D;
    const drops = 1600;
    const pos = new Float32Array(drops * 2 * 3);
    // Seed deterministically around the origin; first update recenters on camera.
    for (let i = 0; i < drops; i++) {
      const o = i * 6;
      const a = (i * 2.399963) % (Math.PI * 2); // golden-angle spiral: even disc coverage
      const rad = 30 * Math.sqrt(((i * 7919) % 1000) / 1000);
      pos[o] = Math.cos(a) * rad;
      pos[o + 1] = ((i * 37) % 240) / 10 - 4;
      pos[o + 2] = Math.sin(a) * rad;
      pos[o + 3] = pos[o];
      pos[o + 4] = pos[o + 1] - 0.5;
      pos[o + 5] = pos[o + 2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    const material = new THREE.LineBasicMaterial({
      color: 0xcfe0f4,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
    });
    const lines = new THREE.LineSegments(geo, material);
    lines.frustumCulled = false;
    lines.renderOrder = 8;
    lines.visible = false;
    this.view.renderer.scene.add(lines);
    this.rain3D = { lines, material, geo, pos, drops };
    return this.rain3D;
  }

  updateStormRain3D(dt: number, intensity: number) {
    // Clear the legacy canvas overlay once (kept in the DOM for compatibility).
    if (this.stormRainCanvas && this.stormRainCtx && this.stormRainCanvas.width > 0) {
      this.stormRainCtx.clearRect(0, 0, this.stormRainCanvas.width, this.stormRainCanvas.height);
      this.stormRainCanvas.width = 0;
    }
    if (intensity <= 0.001) {
      if (this.rain3D) this.rain3D.lines.visible = false;
      return;
    }
    const rain = this.ensureRain3D();
    rain.lines.visible = true;
    const cam = this.view.renderer.camera.position;
    const t = this.view.ocean.getTime();
    const wind = sampleWind(t);
    const gust = Math.sin(t * 2.7) * 0.5 + Math.sin(t * 6.3 + 1.4) * 0.3;
    const windSpeed = (6 + intensity * 12) * wind.strength + gust * intensity * 3;
    const windX = Math.sin(wind.direction) * windSpeed;
    const windZ = Math.cos(wind.direction) * windSpeed;
    const fallSpeed = 21 + intensity * 11;
    const active = Math.max(24, Math.floor(rain.drops * (0.22 + intensity * 0.78)));
    const streak = 0.55 + intensity * 0.8;
    // Normalized fall direction × streak length for the trailing vertex.
    const vLen = Math.hypot(windX, windZ, fallSpeed);
    const sx = (windX / vLen) * streak;
    const sy = (fallSpeed / vLen) * streak;
    const sz = (windZ / vLen) * streak;
    const pos = rain.pos;
    const spawnRadius = 32;
    for (let i = 0; i < active; i++) {
      const o = i * 6;
      let x = pos[o] + windX * dt * 0.85;
      let y = pos[o + 1] - fallSpeed * dt;
      let z = pos[o + 2] + windZ * dt * 0.85;
      // Recycle drops that fell below the camera or drifted out of the volume.
      const dx = x - cam.x;
      const dz = z - cam.z;
      if (y < cam.y - 8 || dx * dx + dz * dz > spawnRadius * spawnRadius * 1.9) {
        const a = Math.random() * Math.PI * 2;
        const rad = spawnRadius * Math.sqrt(Math.random());
        // Bias the spawn upwind so the slanted fall carries drops across the view.
        x = cam.x + Math.cos(a) * rad - (windX / Math.max(1, windSpeed)) * 8;
        z = cam.z + Math.sin(a) * rad - (windZ / Math.max(1, windSpeed)) * 8;
        y = cam.y + 12 + Math.random() * 14;
      }
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
      pos[o + 3] = x - sx;
      pos[o + 4] = y + sy;
      pos[o + 5] = z - sz;
    }
    rain.geo.setDrawRange(0, active * 2);
    (rain.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    const nightFactor = this.view.renderer.getAtmosphere().nightFactor ?? 0;
    rain.material.opacity = (0.13 + intensity * 0.2) * (1 - nightFactor * 0.35);
  }

  updateStormLightningFlash(dt: number) {
    if (!this.stormLightningFlashEl) return;
    this.stormLightningFlashOpacity = Math.max(0, this.stormLightningFlashOpacity - dt * 4.8);
    this.stormLightningFlashEl.style.opacity = String(this.stormLightningFlashOpacity);
  }

  updateLightning(dt: number) {
    if (!this.view.state) return;

    // Fade out any active flash
    if (this.lightningFlash) {
      this.lightningFlash.intensity -= dt * (18 + this.view.state.storm.phase * 4);
      if (this.lightningFlash.intensity <= 0) {
        this.lightningFlash.intensity = 0; // pooled light stays in the scene
        this.lightningFlash = null;
      }
    }
    if (this.lightningBolt) {
      const boltMat = this.lightningBolt.material as THREE.LineBasicMaterial;
      if (boltMat.opacity > 0) boltMat.opacity = Math.max(0, boltMat.opacity - dt * 6);
    }

    const phase = this.view.state.storm.phase;
    const player = this.view.getLocalPlayer();
    const playerDist = player
      ? this.view.distance2D(player.position.x, player.position.z, this.view.state.storm.centerX, this.view.state.storm.centerZ)
      : 0;
    const outsideStorm = !!player
      && playerDist > this.view.state.storm.safeRadius;
    const nearStormWall = !!player && Math.abs(playerDist - this.view.state.storm.safeRadius) < 85;

    // Keep lightning tied to the storm front, not clear water well inside the safe zone.
    if (!outsideStorm && !(this.view.state.storm.shrinking && nearStormWall) && phase < 2) return;

    this.lightningTimer -= dt;
    if (this.lightningTimer <= 0) {
      const stormR = this.view.state.storm.safeRadius;
      const angle = Math.random() * Math.PI * 2;
      // Strike near the storm wall boundary
      const dist = stormR * (0.88 + Math.random() * 0.38);
      const lx = this.view.state.storm.centerX + Math.cos(angle) * dist;
      const lz = this.view.state.storm.centerZ + Math.sin(angle) * dist;

      // Pooled flash light (allocating one per strike forced shader churn).
      if (!this.lightningLightPool) {
        this.lightningLightPool = new THREE.PointLight(0x9fc4e6, 0, 300);
        this.view.renderer.scene.add(this.lightningLightPool);
      }
      const flash = this.lightningLightPool;
      flash.intensity = 60 + phase * 10;
      flash.distance = Math.max(300, stormR * 0.9);
      flash.position.set(lx, 85 + Math.random() * 50, lz);
      this.lightningFlash = flash;

      // Jagged bolt: cloud base to the sea, brief life synced with the flash.
      if (!this.lightningBolt) {
        const boltGeo = new THREE.BufferGeometry();
        boltGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9 * 3), 3));
        this.lightningBolt = new THREE.Line(
          boltGeo,
          new THREE.LineBasicMaterial({ color: 0xdceeff, transparent: true, opacity: 0, depthWrite: false }),
        );
        this.lightningBolt.frustumCulled = false;
        this.view.renderer.scene.add(this.lightningBolt);
      }
      {
        const positions = this.lightningBolt.geometry.getAttribute('position') as THREE.BufferAttribute;
        const topY = 150 + Math.random() * 40;
        let bx = lx;
        let bz = lz;
        for (let i = 0; i < 9; i++) {
          const f = i / 8;
          positions.setXYZ(i, bx, topY * (1 - f), bz);
          bx += (Math.random() - 0.5) * 14;
          bz += (Math.random() - 0.5) * 14;
        }
        positions.needsUpdate = true;
        (this.lightningBolt.material as THREE.LineBasicMaterial).opacity = 0.9;
      }

      // Thunder boom matched to the actual strike distance.
      const localPlayerForThunder = this.view.getLocalPlayer();
      if (localPlayerForThunder) {
        this.view.audio.playThunder(this.view.distance2D(localPlayerForThunder.position.x, localPlayerForThunder.position.z, lx, lz));
      }

      this.stormLightningFlashOpacity = Math.max(
        this.stormLightningFlashOpacity,
        0.18 + this.view.stormWeatherIntensity * 0.26 + phase * 0.015,
      );

      const baseCooldown = Math.max(
        0.75,
        10.5 - phase * 1.25 - (outsideStorm ? 3.2 : 0) - this.view.stormWeatherIntensity * 2.5,
      );
      this.lightningTimer = baseCooldown * (0.35 + Math.random() * 0.85);
    }
  }
}
