/**
 * LOCOMOTION BLEND SPACE + the rig's layer state machine (lane b3.3b,
 * animations-07, animations-10, vm:liveplay:7).
 *
 * Before this module a remote pirate had exactly two legs clips, walk and run,
 * played at their authored rate whatever his speed or direction: a backpedalling
 * enemy stepped FORWARD while sliding backward, a strafing one walked forward
 * sideways, and every one of them skated (walk clip 0.97 m/s used up to 3.6 m/s).
 *
 * Now:
 * - every locomotion clip's ground speed and travel direction is MEASURED from
 *   its own stance-foot track when the rig asset loads (measureClipTravel), so
 *   nothing here is a hand-typed stride number that drifts from the art;
 * - the clips form an 8-way blend space in the BODY frame (walk, strafe_l,
 *   strafe_r, walk_back on the walk tier; run and run_back; sprint). A body-local
 *   travel direction is reached by blending its two neighbouring clips with the
 *   weight that makes the blended foot velocity point exactly that way;
 * - the tier is the one whose stride-matched timeScale (speed / blended ground
 *   speed) lies in 0.6-1.6 and is closest to 1; outside every band the closest
 *   tier is clamped (and the remote body is turned to face its travel, see
 *   locomotionFacing, so that case is rare);
 * - every locomotion action shares ONE normalised phase, so a cross-fade between
 *   walk and run, or run and run_back, never puts a left foot down on a right
 *   step (phase sync);
 * - the clips the GLB carried as dead data are wired to replicated edges:
 *   fire_pistol (ammo decrement), cannon_fire (the gunner's cannonRecoil edge),
 *   land (grounded after vy < -3), hit_back (Game's flinch says the shot came
 *   from behind), spyglass (equippedTool), revive (scrubbed by reviveProgress).
 *
 * The layer state machine (setLayer / lowerStateFor / upperStateFor and the
 * one-shot edges) moved here from PlayerRigFactory (extract-and-call, PLAN
 * rule 4b); PlayerRigFactory keeps the rig build, the mixer step and the solvers.
 */
import * as THREE from 'three';
import { PLAYER, WEAPONS } from '../../../shared/constants/index.js';
import type { Player } from '../../../shared/types/index.js';
import type { PlayerRig } from '../factories/PlayerRigFactory.js';
import { triggerJaw } from './faceRig.js';

/** PLAN §2.5: cross-fade 0.12 s. One number, used by both layers. */
export const CROSSFADE = 0.12;
/** Stride-matched playback band (section 3 animation spec). */
export const TS_MIN = 0.6;
export const TS_MAX = 1.6;

/** Clips that are a whole-body statement — while one of these is the lower
 *  state the upper layer plays its own upper half and no weapon pose overrides
 *  it (a helmsman does not aim a pistol at the wheel). */
export const FULL_BODY = new Set([
  'helm', 'cannon_aim', 'cannon_fire', 'capstan_push', 'bail', 'dig', 'hammer',
  'swim', 'tread', 'climb', 'downed', 'revive',
  'death_shot', 'death_fall', 'death_drown',
]);

export const ONE_SHOT = new Set([
  'jump', 'land', 'cannon_fire', 'fire_pistol', 'reload',
  'cutlass_swing_a', 'cutlass_swing_b', 'hit_front', 'hit_back', 'revive',
  'death_shot', 'death_fall', 'death_drown',
]);

export type ClipPair = { lower: THREE.AnimationClip; upper: THREE.AnimationClip };

/** The masked clip table PlayerRigFactory built; shared by every rig. */
let pairs: Map<string, ClipPair> | null = null;

/** One sample of the blend space. `dir` is the BODY-local travel angle the clip
 *  walks the body along (0 = forward/+Z, +π/2 = the pirate's left/+X, π = back),
 *  `speed` its ground speed at timeScale 1. `reverse` plays `source` backwards
 *  (the legacy asset has no walk_back/run_back: a walk run in reverse puts the
 *  feet down in the right order for a backpedal). */
export type LocoClip = {
  name: string;
  source: string;
  reverse: boolean;
  dir: number;
  speed: number;
  duration: number;
  tier: number;
};

/** Fallbacks for an asset whose foot tracks cannot be measured (the legacy
 *  pirate_base.glb: the audit measured walk 0.97 m/s, run 2.20 m/s). */
const DEFAULTS: Record<string, { tier: number; dir: number; speed: number }> = {
  walk: { tier: 0, dir: 0, speed: 0.97 },
  strafe_l: { tier: 0, dir: Math.PI / 2, speed: 0.9 },
  strafe_r: { tier: 0, dir: -Math.PI / 2, speed: 0.9 },
  walk_back: { tier: 0, dir: Math.PI, speed: 0.97 },
  run: { tier: 1, dir: 0, speed: 2.2 },
  run_back: { tier: 1, dir: Math.PI, speed: 2.2 },
  sprint: { tier: 2, dir: 0, speed: 2.8 },
};
const REVERSE_OF: Record<string, string> = { walk_back: 'walk', run_back: 'run' };

let locoSet: LocoClip[] | null = null;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Body-local travel velocity (m/s at timeScale 1) a clip moves its owner at,
 * from the stance foot (the lower boot): the body travels at minus that
 * boot's velocity. Leaves every bone exactly as it found it (the
 * source scene is the template every pirate is cloned from). Null when the
 * clip has no measurable contact (a treadmill-less legacy clip).
 */
export function measureClipTravel(scene: THREE.Object3D, clip: THREE.AnimationClip): { fwd: number; side: number } | null {
  const fl = scene.getObjectByName('foot_l');
  const fr = scene.getObjectByName('foot_r');
  if (!fl || !fr || clip.duration <= 0) return null;
  const saved: [THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3][] = [];
  scene.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const mixer = new THREE.AnimationMixer(scene);
  mixer.clipAction(clip).play();
  const N = 96;
  const dt = clip.duration / N;
  const L: THREE.Vector3[] = [];
  const R: THREE.Vector3[] = [];
  for (let i = 0; i < N; i++) {
    mixer.setTime(i * dt);
    scene.updateMatrixWorld(true);
    L.push(fl.getWorldPosition(new THREE.Vector3()));
    R.push(fr.getWorldPosition(new THREE.Vector3()));
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(scene);
  for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  scene.updateMatrixWorld(true);
  // Stance = the LOWER boot, counted only while the same boot stays lower on
  // both ends of a sample step (the swap instants are swing, not contact).
  let sx = 0; let sz = 0; let n = 0;
  for (let i = 1; i < N; i++) {
    const leftNow = L[i].y <= R[i].y;
    if (leftNow !== (L[i - 1].y <= R[i - 1].y)) continue;
    const F = leftNow ? L : R;
    sx += (F[i].x - F[i - 1].x) / dt;
    sz += (F[i].z - F[i - 1].z) / dt;
    n++;
  }
  if (n < 4) return null;
  return { side: -sx / n, fwd: -sz / n };
}

/** Measure the locomotion clips of `animations` on `scene` and return the
 *  blend space. Missing back clips become their forward clip in reverse. */
export function buildLocoSet(scene: THREE.Object3D, animations: readonly THREE.AnimationClip[]): LocoClip[] {
  const byName = new Map(animations.map((c) => [c.name, c]));
  const out: LocoClip[] = [];
  for (const [name, def] of Object.entries(DEFAULTS)) {
    let clip = byName.get(name);
    let reverse = false;
    let source = name;
    if (!clip && REVERSE_OF[name] && byName.has(REVERSE_OF[name])) {
      source = REVERSE_OF[name];
      clip = byName.get(source);
      reverse = true;
    }
    if (!clip) continue;
    const m = measureClipTravel(scene, clip);
    let dir = def.dir;
    let speed = def.speed;
    if (m && Math.hypot(m.fwd, m.side) > 0.2) {
      dir = Math.atan2(m.side, m.fwd);
      speed = Math.hypot(m.fwd, m.side);
      if (reverse) dir = wrap(dir + Math.PI);
    }
    out.push({ name, source, reverse, dir, speed, duration: clip.duration, tier: def.tier });
  }
  return out;
}

/** Called once by PlayerRigFactory when its clip table is built. */
export function registerLocoClips(scene: THREE.Object3D, animations: readonly THREE.AnimationClip[], table: Map<string, ClipPair>): void {
  pairs = table;
  locoSet = buildLocoSet(scene, animations);
}

export function activeLocoSet(): readonly LocoClip[] | null { return locoSet; }

export type LocoPick = {
  a: LocoClip;
  b: LocoClip | null;
  /** weight of b (a carries 1 - w) */
  w: number;
  /** stride-matched timeScale, clamped to [TS_MIN, TS_MAX] */
  ts: number;
  /** true when the unclamped timeScale was inside the band */
  ok: boolean;
  /** normalised phase advance per second */
  phaseRate: number;
};

function tierPick(clips: readonly LocoClip[], phi: number, speed: number): LocoPick | null {
  const d = { side: Math.sin(phi), fwd: Math.cos(phi) };
  const vec = (c: LocoClip) => ({ side: Math.sin(c.dir) * c.speed, fwd: Math.cos(c.dir) * c.speed });
  const cross = (v: { side: number; fwd: number }) => v.side * d.fwd - v.fwd * d.side;
  let a: LocoClip | null = null;
  let b: LocoClip | null = null;
  let w = 0;
  let ground = 0;
  for (const c of clips) {
    if (Math.abs(wrap(phi - c.dir)) < 0.06 && (!a || c.speed > ground)) { a = c; b = null; w = 0; ground = c.speed; }
  }
  if (!a) {
    let span = Infinity;
    for (const ca of clips) {
      for (const cb of clips) {
        const da = wrap(phi - ca.dir);
        const db = wrap(cb.dir - phi);
        if (da <= 0 || db <= 0 || da + db >= Math.PI - 0.05 || da + db >= span) continue;
        const xa = cross(vec(ca));
        const xb = cross(vec(cb));
        if (Math.abs(xa - xb) < 1e-6) continue;
        const ww = THREE.MathUtils.clamp(xa / (xa - xb), 0, 1);
        const va = vec(ca); const vb = vec(cb);
        const g = Math.hypot((1 - ww) * va.side + ww * vb.side, (1 - ww) * va.fwd + ww * vb.fwd);
        if (g < 1e-3) continue;
        span = da + db; a = ca; b = cb; w = ww; ground = g;
      }
    }
  }
  if (!a || ground < 1e-3) return null;
  const raw = speed / ground;
  const ts = THREE.MathUtils.clamp(raw, TS_MIN, TS_MAX);
  const phaseRate = ts * ((1 - w) / a.duration + (b ? w / b.duration : 0));
  return { a, b, w, ts, ok: raw >= TS_MIN && raw <= TS_MAX, phaseRate };
}

/** The blend for a body-local travel velocity (fwd along +Z, side along the
 *  pirate's left, +X). Null only for an empty set or a standing body. */
export function pickLocomotion(set: readonly LocoClip[], fwd: number, side: number): LocoPick | null {
  const speed = Math.hypot(fwd, side);
  if (speed < 1e-3 || set.length === 0) return null;
  const phi = Math.atan2(side, fwd);
  let best: LocoPick | null = null;
  let bestErr = Infinity;
  for (const tier of [0, 1, 2]) {
    const p = tierPick(set.filter((c) => c.tier === tier), phi, speed);
    if (!p) continue;
    // error = how far the timeScale sits from 1 (in the band) or how much foot
    // slip the clamp leaves (outside it); an in-band pick always wins.
    const raw = speed / Math.max(1e-6, blendedGround(p));
    const err = p.ok ? Math.abs(Math.log(p.ts)) : 10 + Math.abs(Math.log(p.ts / raw));
    if (err < bestErr) { bestErr = err; best = p; }
  }
  return best;
}

function blendedGround(p: LocoPick): number {
  const va = { s: Math.sin(p.a.dir) * p.a.speed, f: Math.cos(p.a.dir) * p.a.speed };
  if (!p.b) return p.a.speed;
  const vb = { s: Math.sin(p.b.dir) * p.b.speed, f: Math.cos(p.b.dir) * p.b.speed };
  return Math.hypot((1 - p.w) * va.s + p.w * vb.s, (1 - p.w) * va.f + p.w * vb.f);
}

/** Body-local (fwd, side) of a world velocity for a body yawed `yaw` (a body
 *  at yaw 0 faces +Z; its left is +X). */
export function bodyLocal(vx: number, vz: number, yaw: number): { fwd: number; side: number } {
  return { fwd: vx * Math.sin(yaw) + vz * Math.cos(yaw), side: vx * Math.cos(yaw) - vz * Math.sin(yaw) };
}

/**
 * Which way a MOVING remote body faces. It keeps facing where its owner looks
 * while the blend space can carry that body-local direction at this speed with
 * a stride-matched timeScale (slow strafes, backpedals up to run_back x 1.6);
 * past that it faces the way it is going and runs forward, so the feet never
 * skate. `rigged` false (the procedural body: forward gait only) always faces
 * the travel.
 */
export function locomotionFacing(lookYaw: number, vx: number, vz: number, rigged: boolean): number {
  const speed = Math.hypot(vx, vz);
  if (speed < 0.4) return lookYaw;
  const travel = Math.atan2(vx, vz);
  if (!rigged) return travel;
  const set = locoSet ?? defaultSet();
  const { fwd, side } = bodyLocal(vx, vz, lookYaw);
  const p = pickLocomotion(set, fwd, side);
  return p && p.ok ? lookYaw : travel;
}

let defaults: LocoClip[] | null = null;
function defaultSet(): LocoClip[] {
  if (!defaults) {
    defaults = Object.entries(DEFAULTS).map(([name, d]) => ({
      name, source: REVERSE_OF[name] ?? name, reverse: !!REVERSE_OF[name], dir: d.dir, speed: d.speed,
      duration: 1, tier: d.tier,
    }));
  }
  return defaults;
}

/** Per-rig locomotion state: the shared phase and each sample's weight. */
export type LocoState = {
  phase: number;
  weights: Map<LocoClip, number>;
  active: boolean;
  /** dominant sample after the last step */
  dominant: LocoClip | null;
};

export function newLocoState(): LocoState {
  return { phase: 0, weights: new Map(), active: false, dominant: null };
}

/**
 * One locomotion frame: pick the blend, move every sample's weight toward its
 * target over CROSSFADE, advance the ONE shared phase at the stride-matched
 * rate and pin every playing action to it. `actionOf(source)` returns the
 * action for a source clip (the rig's lower-half action; a test's full clip).
 */
export function stepLocomotion(
  st: LocoState,
  set: readonly LocoClip[],
  fwd: number,
  side: number,
  dt: number,
  actionOf: (source: string) => THREE.AnimationAction | null,
): LocoPick | null {
  const pick = pickLocomotion(set, fwd, side);
  const target = new Map<LocoClip, number>();
  if (pick) {
    target.set(pick.a, 1 - pick.w);
    if (pick.b) target.set(pick.b, (target.get(pick.b) ?? 0) + pick.w);
  }
  const rate = dt / CROSSFADE;
  let sum = 0;
  for (const c of set) {
    const cur = st.weights.get(c) ?? 0;
    const want = target.get(c) ?? 0;
    const next = cur + THREE.MathUtils.clamp(want - cur, -rate, rate);
    st.weights.set(c, next);
    sum += next;
  }
  if (pick) st.phase = (st.phase + dt * pick.phaseRate) % 1;
  // One action per SOURCE clip (walk and a reversed walk share one): its weight
  // is the sum, its time comes from the heavier sample.
  const bySource = new Map<string, { w: number; top: LocoClip; topW: number }>();
  let dominant: LocoClip | null = null;
  let domW = -1;
  for (const c of set) {
    const w = sum > 1 ? (st.weights.get(c) ?? 0) / sum : (st.weights.get(c) ?? 0);
    const e = bySource.get(c.source);
    if (!e) bySource.set(c.source, { w, top: c, topW: w });
    else { e.w += w; if (w > e.topW) { e.top = c; e.topW = w; } }
    if (w > domW) { domW = w; dominant = c; }
  }
  for (const [source, e] of bySource) {
    const action = actionOf(source);
    if (!action) continue;
    if (e.w <= 1e-4) { if (action.isRunning() && action.getEffectiveWeight() <= 1e-4) action.stop(); else action.setEffectiveWeight(0); continue; }
    if (!action.isRunning()) { action.reset(); action.setLoop(THREE.LoopRepeat, Infinity); action.play(); }
    action.enabled = true;
    action.timeScale = 0; // the phase drives time; the mixer only evaluates
    const p = e.top.reverse ? 1 - st.phase : st.phase;
    action.time = (p % 1) * action.getClip().duration;
    action.setEffectiveWeight(e.w);
  }
  st.dominant = dominant;
  return pick;
}

// ── the rig's layer state machine (moved from PlayerRigFactory) ──────────────

export function setLayer(rig: PlayerRig, which: 'lower' | 'upper', clipName: string): void {
  const layer = rig[which];
  if (layer.name === clipName) return;
  const pair = pairs?.get(clipName);
  if (!pair) return;
  const clip = which === 'lower' ? pair.lower : pair.upper;
  if (clip.tracks.length === 0) return;
  const next = rig.mixer.clipAction(clip);
  const once = ONE_SHOT.has(clipName);
  next.reset();
  next.timeScale = 1; // a clip the locomotion phase drove sits at 0
  next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
  next.clampWhenFinished = once;
  next.enabled = true;
  next.setEffectiveWeight(1);
  next.play();
  if (layer.action && layer.action !== next) layer.action.crossFadeTo(next, CROSSFADE, false);
  else if (!layer.action && which === 'lower' && layer.name !== '') next.fadeIn(CROSSFADE);
  layer.action = next;
  layer.name = clipName;
}

/** Which whole-body clip a player's replicated state asks for. 'walk'/'run'
 *  mean "locomotion": the blend space picks the actual samples. */
export function lowerStateFor(player: Player, moveSpeed: number): string {
  if (player.state === 'downed') return (player.reviveProgress ?? 0) > 0.02 ? 'revive' : 'downed';
  if (player.state === 'swimming') return moveSpeed > 0.6 ? 'swim' : 'tread';
  if (player.mastClimb !== null) return 'climb';
  if (player.atHelm) return 'helm';
  if (player.atCannon) return 'cannon_aim';
  if ((player as { atCapstan?: boolean }).atCapstan) return 'capstan_push';
  if (player.bailing) return 'bail';
  if ((player.hullRepairProgress ?? 0) > 0) return 'hammer';
  if (player.equippedTool === 'shovel') return 'dig';
  const vy = player.velocity.y ?? 0;
  if (Math.abs(vy) > 1.6) return vy > 0 ? 'jump' : 'fall';
  if (moveSpeed > PLAYER.MOVE_SPEED * 0.72) return 'run';
  if (moveSpeed > 0.4) return 'walk';
  return 'idle';
}

/** What the arms are doing, when the legs are free to do something else. */
export function upperStateFor(player: Player, lower: string, rig: PlayerRig, swing: number): string | null {
  if (FULL_BODY.has(lower)) return null;
  if (player.equippedTool === 'spyglass') return 'spyglass';
  const weapon = player.weapons[player.activeSlot];
  if (!weapon) return null;
  if (weapon.weaponId === 'cutlass') {
    if (swing > 0.001) return rig.swingFlip === 0 ? 'cutlass_swing_a' : 'cutlass_swing_b';
    return 'cutlass_idle';
  }
  if (WEAPONS[weapon.weaponId]?.melee) return 'block';
  if (weapon.reloading) return 'reload';
  return 'aim_pistol';
}

type Edges = {
  loco: LocoState;
  prevVy: number;
  prevRecoil: number;
  ammoKey: string;
  prevAmmo: number;
  lowerShot: number;
  lowerShotName: string;
};
const edgesOf = new WeakMap<PlayerRig, Edges>();

/** For tests and probes: the rig's locomotion state (null before its first frame). */
export function rigLocoState(rig: PlayerRig): LocoState | null { return edgesOf.get(rig)?.loco ?? null; }

const clipSeconds = (name: string, cap: number) => Math.min(cap, pairs?.get(name)?.lower.duration ?? cap);

/**
 * Both layers for one frame: the lower state (locomotion blend or a named
 * clip, with the land / cannon_fire / revive edges), then the upper one-shots
 * (swing, hit_front/hit_back, fire_pistol) and the steady upper pose.
 */
export function driveRigLayers(rig: PlayerRig, mesh: THREE.Object3D, player: Player, dt: number, cutlassSwing: number): void {
  let e = edgesOf.get(rig);
  if (!e) {
    e = { loco: newLocoState(), prevVy: 0, prevRecoil: 0, ammoKey: '', prevAmmo: -1, lowerShot: 0, lowerShotName: '' };
    edgesOf.set(rig, e);
  }
  const vx = player.velocity.x;
  const vz = player.velocity.z;
  const vy = player.velocity.y ?? 0;
  let lower = lowerStateFor(player, Math.hypot(vx, vz));

  // Lower-body one-shot edges.
  // A standing landing plays land; a moving one runs straight on (the legs
  // already have somewhere to be).
  if (e.prevVy < -3 && Math.abs(vy) <= 1.6 && lower === 'idle') {
    e.lowerShot = clipSeconds('land', 0.4); e.lowerShotName = 'land';
  }
  e.prevVy = vy;
  const recoil = (mesh.userData.cannonRecoil as number | undefined) ?? 0;
  if (player.atCannon && recoil > e.prevRecoil + 0.2) { e.lowerShot = clipSeconds('cannon_fire', 0.9); e.lowerShotName = 'cannon_fire'; }
  e.prevRecoil = recoil;
  if (e.lowerShot > 0) {
    const holds = e.lowerShotName === 'cannon_fire' ? player.atCannon : lower === 'idle';
    if (holds && pairs?.has(e.lowerShotName)) lower = e.lowerShotName;
    else e.lowerShot = 0;
    e.lowerShot = Math.max(0, e.lowerShot - dt);
  }

  const set = locoSet;
  if ((lower === 'walk' || lower === 'run') && set && set.length > 0) {
    if (!e.loco.active) {
      // Hand the previous named clip's weight over to the blend.
      if (rig.lower.action) rig.lower.action.fadeOut(CROSSFADE);
      for (const c of set) e.loco.weights.set(c, 0);
      e.loco.active = true;
    }
    const { fwd, side } = bodyLocal(vx, vz, mesh.rotation.y);
    stepLocomotion(e.loco, set, fwd, side, dt, (source) => {
      const pair = pairs?.get(source);
      return pair && pair.lower.tracks.length > 0 ? rig.mixer.clipAction(pair.lower) : null;
    });
    const dom = e.loco.dominant;
    rig.lower.action = dom ? rig.mixer.clipAction(pairs!.get(dom.source)!.lower) : null;
    rig.lower.name = dom?.name ?? 'walk';
  } else {
    if (e.loco.active) {
      e.loco.active = false;
      for (const c of set ?? []) {
        const pair = pairs?.get(c.source);
        if (pair) { const a = rig.mixer.clipAction(pair.lower); if (a.isRunning()) a.fadeOut(CROSSFADE); }
        e.loco.weights.set(c, 0);
      }
      rig.lower.action = null; // setLayer fades the next clip in
    }
    setLayer(rig, 'lower', lower);
    if (lower === 'revive' && rig.lower.action) {
      // The downed pirate rises as far as his crewmate's hold has got.
      rig.lower.action.timeScale = 0;
      rig.lower.action.time = THREE.MathUtils.clamp(player.reviveProgress ?? 0, 0, 1) * rig.lower.action.getClip().duration * 0.999;
    }
  }

  // Upper one-shots: a swing, a hit or a shot OWNS the arms for its duration.
  if (cutlassSwing > 0.001 && rig.prevSwing <= 0.001) {
    rig.swingFlip ^= 1;
    rig.oneShot = 0.62;
    if (rig.face) triggerJaw(rig.face);
  }
  rig.prevSwing = cutlassSwing;
  if (player.health < rig.prevHealth - 0.5 && player.state !== 'downed' && rig.oneShot <= 0) {
    const fl = mesh.userData.flinch as { fromBehind?: boolean } | undefined;
    const hit = fl?.fromBehind ? 'hit_back' : 'hit_front';
    setLayer(rig, 'upper', hit);
    rig.oneShot = clipSeconds(hit, 0.45);
    if (rig.face) triggerJaw(rig.face);
  }
  rig.prevHealth = player.health;
  const weapon = player.weapons[player.activeSlot];
  const key = weapon ? `${player.activeSlot}:${weapon.weaponId}` : '';
  const ammo = (weapon as { ammo?: number } | undefined)?.ammo ?? -1;
  if (weapon && key === e.ammoKey && ammo >= 0 && ammo < e.prevAmmo && !weapon.reloading
      && !WEAPONS[weapon.weaponId]?.melee && !FULL_BODY.has(lower)) {
    setLayer(rig, 'upper', 'fire_pistol');
    rig.oneShot = clipSeconds('fire_pistol', 0.5);
  }
  e.ammoKey = key;
  e.prevAmmo = ammo;
  rig.oneShot = Math.max(0, rig.oneShot - dt);

  if (rig.oneShot <= 0 || FULL_BODY.has(lower)) {
    const upper = upperStateFor(player, lower, rig, cutlassSwing);
    // No weapon: the arms follow the legs' clip (its source, phase-pinned).
    const dom = e.loco.active ? e.loco.dominant : null;
    setLayer(rig, 'upper', upper ?? (dom ? dom.source : lower));
    if (!upper && dom && rig.upper.action) {
      rig.upper.action.timeScale = 0;
      const p = dom.reverse ? 1 - e.loco.phase : e.loco.phase;
      rig.upper.action.time = (p % 1) * rig.upper.action.getClip().duration;
    }
  }
}
