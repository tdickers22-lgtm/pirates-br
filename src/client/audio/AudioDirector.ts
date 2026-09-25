/**
 * AudioDirector (b2.4e; audio-06, vm:audio:3): the beds driven by physics and the ship
 * handling foley, placed at their stations.
 *
 * The pure laws (exported, graded by test-audio-models without an AudioContext):
 *   apparentWind      true wind (sampleLocalWind, the SAME wind the physics sails on) minus the
 *                     hull's velocity. Beating into it doubles what you hear; running at wind
 *                     speed hears almost nothing. A listener ashore or swimming hears true wind.
 *   windBedLevels     breeze (> 0 in clear weather), rigging whistle above 8 m/s apparent with
 *                     pitch rising with speed (aboard only: it is the rigging singing), gale
 *                     (the storm, or apparent wind past 16 m/s).
 *   oceanLayers       three layered loops by sea state: swell (low), lap (mid), chop (whitecaps).
 *   surfLevel         breakers by distance to the nearest shore (1 at 4 m, 0 past 90 m).
 *   luffFlutterHz     canvas flutter rate from apparent wind.
 *   creakLoad01       the frame's load: heel plus wind pressure on the set canvas.
 *   SailFillDetector  a thump when the trim moves >= 10% (height, or angle over 1.2 rad) or a
 *                     luffing sail fills again.
 *   BowSlapDetector   a slap at each bow-dip peak of the live pitch, sized by the plunge rate.
 *
 * The AudioDirector class runs them once a frame and drives a sink (SoundEngine): setAmbience
 * (every world bed), setSailingState (rush, creak, flutter), and the station one-shots, each
 * with a world position from the shared station geometry (anchor/capstan at the bow, wheel at
 * the helm, sail rope at the sail station, load/ram at the cannon that just came ready).
 */
import { PLAYER, SHIP_STATS } from '../../shared/constants/index.js';
import {
  getAnchorControlLocal, getCannonDeckLocalPosition, getHelmControlLocal, getSailControlLocal, isStandingInShipHold, toShipWorldPoint,
} from '../../shared/interactions.js';
import type { Ship } from '../../shared/types/index.js';
import { angleWrap, sampleLocalWind } from '../../shared/utils/index.js';

export interface SoundPoint { x: number; y: number; z: number }

const fin = (v: unknown, fb = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, fin(v)));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((fin(x) - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** sampleLocalWind strength (0.78..0.98 calm, boosted outside the storm ring) -> m/s. 0.9 is
 *  a 6.3 m/s Beaufort-4 breeze; the storm tailwind boost lands in gale territory. */
export const WIND_MS_PER_STRENGTH = 7;
/** Rigging starts to sing above this apparent wind (m/s). */
export const RIGGING_WHISTLE_MS = 8;
/** Apparent wind that is a gale on its own, storm or not. */
export const GALE_APPARENT_MS = 16;

/** Wind the listener FEELS: true wind (blowing TOWARD `direction`, PhysicsSystem's yaw
 *  convention: +x = sin, +z = cos) minus the hull's velocity. */
export function apparentWind(direction: number, strength: number, vx = 0, vz = 0): { x: number; z: number; speed: number } {
  const ms = Math.max(0, fin(strength)) * WIND_MS_PER_STRENGTH;
  const d = fin(direction);
  const x = Math.sin(d) * ms - fin(vx);
  const z = Math.cos(d) * ms - fin(vz);
  return { x, z, speed: Math.hypot(x, z) };
}

export interface WindBedLevels { breeze: number; rigging: number; riggingHz: number; gale: number; total: number }
export function windBedLevels(s: { apparentMs: number; storm01: number; aboard: boolean }): WindBedLevels {
  const a = Math.max(0, fin(s.apparentMs));
  const storm = clamp01(s.storm01);
  // Breeze: audible from ~0.4 m/s, full by 14 m/s; never exactly zero in a real wind.
  const breeze = 0.85 * smooth(0.4, 14, a) + (a > 0.4 ? 0.04 : 0);
  const rigging = s.aboard ? smooth(RIGGING_WHISTLE_MS, RIGGING_WHISTLE_MS + 9, a) : 0;
  const riggingHz = 620 + Math.min(24, Math.max(0, a - RIGGING_WHISTLE_MS)) * 55;
  const gale = Math.max(storm, smooth(GALE_APPARENT_MS, GALE_APPARENT_MS + 10, a));
  return { breeze, rigging, riggingHz, gale, total: Math.hypot(breeze, rigging, gale) };
}

export interface OceanLayers { swell: number; lap: number; chop: number }
/** Three layered sea loops. sea01 = local sea state (storm), underway01 = own hull's speed. */
export function oceanLayers(s: { sea01: number; night01: number; swimming: boolean; underway01: number }): OceanLayers {
  const sea = clamp01(s.sea01);
  const night = clamp01(s.night01);
  const under = clamp01(s.underway01);
  const swell = Math.min(1, 0.28 + sea * 0.72);
  const lap = Math.min(1, 0.6 + (0.32 - 0.6) * night + (s.swimming ? 0.26 : 0) + under * 0.32);
  const chop = Math.min(1, 0.9 * smooth(0.18, 1, sea) + under * (0.12 + sea * 0.3));
  return { swell, lap, chop };
}

/** Breakers by metres to the nearest shoreline: 1 within 4 m, 0 past 90 m, strictly falling. */
export function surfLevel(shoreDistM: number): number {
  const d = fin(shoreDistM, Infinity);
  if (!Number.isFinite(d)) return 0;
  if (d <= 4) return 1;
  if (d >= 90) return 0;
  return Math.pow(1 - (d - 4) / 86, 1.5);
}

/** Luffing canvas flutter rate (Hz) from apparent wind: a slow slat in a zephyr, a rattle in a blow. */
export function luffFlutterHz(apparentMs: number): number {
  return Math.min(11, Math.max(2, 2.2 + Math.max(0, fin(apparentMs)) * 0.42));
}

/** Frame load 0..1: heel plus wind pressure (apparent^2) on however much canvas is set. */
export function creakLoad01(s: { heel01: number; apparentMs: number; sailHeight: number }): number {
  const p = Math.min(1, Math.pow(Math.max(0, fin(s.apparentMs)) / 14, 2));
  return clamp01(clamp01(s.heel01) * 0.5 + clamp01(s.sailHeight) * p * 0.5);
}

/** Sail fill thump: accumulated trim change >= 10% (sailHeight 0..1, sailAngle over 1.2 rad)
 *  with canvas set and wind to catch, or a luffing sail filling again. */
export class SailFillDetector {
  private h: number | null = null;
  private a = 0;
  private luff = false;
  private acc = 0;
  update(sailHeight: number, sailAngle: number, luffing: boolean, apparentMs: number): number {
    const h = clamp01(sailHeight);
    const ang = fin(sailAngle);
    let out = 0;
    if (this.h !== null) {
      this.acc += Math.abs(h - this.h) + Math.abs(angleWrap(ang - this.a)) / 1.2;
      const wind = smooth(1.5, 10, apparentMs);
      if (h > 0.15 && wind > 0) {
        if (this.luff && !luffing) out = Math.min(1.2, 0.5 + wind * 0.6);
        else if (this.acc >= 0.1) out = Math.min(1.2, (0.35 + this.acc * 2) * (0.4 + wind * 0.6));
      }
      if (out > 0 || this.acc >= 0.1) this.acc = 0;
    }
    this.h = h;
    this.a = ang;
    this.luff = !!luffing;
    return out;
  }
  reset(): void { this.h = null; this.acc = 0; this.luff = false; }
}

/** Bow slap at each bow-dip peak (positive pitch dips the bow), sized by the plunge rate.
 *  Flat water, a moored hull or a tiny wobble never slaps. */
export class BowSlapDetector {
  private prev: number | null = null;
  private rate = 0;
  private peakRate = 0;
  private since = 99;
  update(pitch: number, dt: number, speed01: number): number {
    const p = fin(pitch);
    const step = Math.max(1e-3, fin(dt, 1 / 60));
    this.since += step;
    let out = 0;
    if (this.prev !== null) {
      const r = (p - this.prev) / step;
      if (r > 0) this.peakRate = Math.max(this.peakRate, r);
      if (this.rate > 0 && r <= 0 && p > 0.012 && this.since > 0.7) {
        const amt = this.peakRate * 7 + clamp01(speed01) * 0.35;
        if (amt > 0.2) { out = Math.min(1.25, amt); this.since = 0; }
      }
      if (r <= 0) this.peakRate = 0;
      this.rate = r;
    }
    this.prev = p;
    return out;
  }
  reset(): void { this.prev = null; this.rate = 0; this.peakRate = 0; }
}

/** Where a station is in the world (deck height ~1.4 m over the hull origin). */
export function stationWorld(ship: Pick<Ship, 'position' | 'rotation'>, local: { x: number; z: number }, up = 1.4): SoundPoint {
  const w = toShipWorldPoint(local, ship);
  return { x: w.x, y: fin(ship.position.y) + up, z: w.z };
}

// ── the per-frame director ───────────────────────────────────────────────────

export interface AmbienceBeds { wind: WindBedLevels; ocean: OceanLayers; surf01: number }

/** What the director drives. SoundEngine implements it; the gate fakes it. */
/** Feet below the ear for the hold test: the CROUCHED eye height, so a crouch on the weather deck
 *  never reads as below deck, while the hold (a full storey down) still does (b2.4g). */
export const LISTENER_FEET_BELOW_EAR = PLAYER.EYE_Y - PLAYER.CROUCH_DROP;
/** Is the listener (camera = first-person ear) standing in this hull's hold? The shared
 *  isStandingInShipHold predicate, the same one the hold interactions use. */
export function listenerInHold(listener: SoundPoint, ship: Pick<Ship, 'position' | 'rotation' | 'type' | 'pitch' | 'roll'> | null): boolean {
  if (!ship || !listener || !Number.isFinite(listener.x) || !Number.isFinite(listener.y) || !Number.isFinite(listener.z)) return false;
  return isStandingInShipHold({ x: listener.x, y: listener.y - LISTENER_FEET_BELOW_EAR, z: listener.z }, ship);
}

export interface AudioDirectorSink {
  /** Below-deck occlusion / hold reverb (b2.4g). Optional so older sinks keep working. */
  setListenerSpace?(s: { inHold: boolean; aboard: boolean }): void;
  setAmbience(a: { nightFactor: number; storminess: number; nearShore01: number; rain01?: number; swimming?: boolean; beds?: AmbienceBeds }): void;
  setSailingState(s: { speed01: number; roughness01: number; heel01: number; luffing: boolean; aboard?: boolean; nearHullM?: number; load01?: number; luffHz?: number }): void;
  playAnchorChange(dropped: boolean, pos?: SoundPoint, distance?: number): void;
  playAnchorMovement(amount?: number, pos?: SoundPoint, distance?: number): void;
  playHelmTurn(amount?: number, pos?: SoundPoint, distance?: number): void;
  playSailTrim(amount?: number, pos?: SoundPoint, distance?: number): void;
  playSailFill(amount?: number, pos?: SoundPoint, distance?: number): void;
  playBowSlap(amount?: number, pos?: SoundPoint, distance?: number): void;
  playCannonLoad(pos?: SoundPoint, distance?: number): void;
}

export interface AudioDirectorFrame {
  dt: number;
  /** Clock for sampleLocalWind (the ocean time the physics samples). */
  time: number;
  listener: SoundPoint;
  nightFactor: number;
  storminess: number;
  rain01: number;
  swimming: boolean;
  /** Metres from the listener to the nearest shoreline (Infinity at sea). */
  shoreDistM: number;
  storm: { centerX: number; centerZ: number; safeRadius: number } | null | undefined;
  /** The hull the listener stands on (null ashore / swimming). */
  aboardShip: Ship | null;
  /** The listener's crew hull (station foley source), aboard or not. */
  crewShip: Ship | null;
  ships: Iterable<Ship>;
  atHelm: boolean;
  /** 0..1 helm input magnitude this frame. */
  helmIntent: number;
}

const dist3 = (a: SoundPoint, b: SoundPoint): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export class AudioDirector {
  private readonly fill = new SailFillDetector();
  private readonly slap = new BowSlapDetector();
  private crewId: string | null = null;
  private prevAnchored: boolean | null = null;
  private prevRaise: number | null = null;
  private prevCooldowns: number[] = [];
  private prevTrimH: number | null = null;
  private prevTrimA = 0;
  private clock = 0;
  private lastAnchorMoveAt = -99;
  private lastHelmAt = -99;
  private lastTrimAt = -99;
  /** Last computed values, for probes and ?debug. */
  last: { apparentMs: number; wind: WindBedLevels | null; ocean: OceanLayers | null; surf01: number } = {
    apparentMs: 0, wind: null, ocean: null, surf01: 0,
  };

  constructor(private readonly sink: AudioDirectorSink) {}

  update(f: AudioDirectorFrame): void {
    const dt = Math.max(0, fin(f.dt, 1 / 60));
    this.clock += dt;
    const storm = clamp01(f.storminess);
    const aboard = f.aboardShip;
    this.sink.setListenerSpace?.({ inHold: listenerInHold(f.listener, aboard), aboard: !!aboard });
    const at = aboard ? aboard.position : f.listener;
    const w = sampleLocalWind(fin(f.time), fin(at.x), fin(at.z), f.storm ?? null);
    const app = apparentWind(w.direction, w.strength, aboard ? aboard.velocity.x : 0, aboard ? aboard.velocity.z : 0);
    const stats = aboard ? SHIP_STATS[aboard.type] : null;
    const speed01 = aboard && stats ? clamp01(Math.hypot(aboard.velocity.x, aboard.velocity.z) / Math.max(0.001, stats.maxSpeed)) : 0;

    const wind = windBedLevels({ apparentMs: app.speed, storm01: storm, aboard: !!aboard });
    const ocean = oceanLayers({ sea01: storm, night01: f.nightFactor, swimming: !!f.swimming, underway01: speed01 });
    const surf01 = surfLevel(f.shoreDistM);
    this.last = { apparentMs: app.speed, wind, ocean, surf01 };
    this.sink.setAmbience({
      nightFactor: f.nightFactor,
      storminess: storm,
      nearShore01: surf01,
      rain01: clamp01(f.rain01),
      swimming: !!f.swimming,
      beds: { wind, ocean, surf01 },
    });

    if (aboard && stats) {
      const heel01 = clamp01(Math.abs(fin(aboard.roll)) / 0.3);
      this.sink.setSailingState({
        speed01,
        roughness01: clamp01(storm * 0.8 + heel01 * 0.4),
        heel01,
        luffing: !!aboard.luffing,
        aboard: true,
        load01: creakLoad01({ heel01, apparentMs: app.speed, sailHeight: aboard.sailHeight }),
        luffHz: luffFlutterHz(app.speed),
      });
      const slap = this.slap.update(fin(aboard.pitch), dt, speed01);
      if (slap > 0) {
        const pos = stationWorld(aboard, { x: 0, z: stats.length * 0.5 }, 0.2);
        this.sink.playBowSlap(slap, pos, dist3(pos, f.listener));
      }
    } else {
      this.slap.reset();
      // Not aboard: the creak is silent unless a hull is within 15 m (hullCreakStrain).
      let nearHullM = Infinity;
      for (const s of f.ships) {
        nearHullM = Math.min(nearHullM, Math.hypot(f.listener.x - s.position.x, f.listener.z - s.position.z) - SHIP_STATS[s.type].length * 0.5);
      }
      this.sink.setSailingState({ speed01: 0, roughness01: storm * 0.8, heel01: 0, luffing: false, aboard: false, nearHullM });
    }

    this.stationFoley(f, app.speed);
  }

  private stationFoley(f: AudioDirectorFrame, apparentMs: number): void {
    const ship = f.crewShip;
    if (!ship || ship.id !== this.crewId) {
      this.crewId = ship?.id ?? null;
      this.prevAnchored = null;
      this.prevRaise = null;
      this.prevCooldowns = [];
      this.prevTrimH = null;
      this.fill.reset();
      if (!ship) return;
    }
    const stats = SHIP_STATS[ship.type];
    const now = this.clock;
    const at = (local: { x: number; z: number }): [SoundPoint, number] => {
      const p = stationWorld(ship, local);
      return [p, dist3(p, f.listener)];
    };
    // Anchor chain run-out / haul, and the capstan pawl while it is being turned.
    if (this.prevAnchored !== null && this.prevAnchored !== ship.anchored) {
      this.sink.playAnchorChange(ship.anchored, ...at(getAnchorControlLocal(stats)));
    }
    this.prevAnchored = ship.anchored;
    const raise = clamp01(ship.anchorRaiseProgress ?? 0);
    if (this.prevRaise !== null) {
      const d = Math.abs(raise - this.prevRaise);
      if (ship.anchored && raise > 0 && raise < 1 && d > 0.0012 && now - this.lastAnchorMoveAt > 0.16) {
        this.sink.playAnchorMovement(Math.min(1.15, Math.max(0.32, d * 88 + 0.28)), ...at(getAnchorControlLocal(stats)));
        this.lastAnchorMoveAt = now;
      }
    }
    this.prevRaise = raise;
    // Wheel: spoke ticks on your input or the hull's own yaw.
    const turn = Math.abs(fin(ship.angularVelocity));
    const intent = clamp01(f.helmIntent);
    if (f.atHelm && (intent > 0 || turn > 0.006)) {
      const speed01 = clamp01(Math.hypot(ship.velocity.x, ship.velocity.z) / Math.max(0.001, stats.maxSpeed));
      const amt = Math.min(1.15, Math.max(0.25, intent * 0.55 + turn * 4.4 + speed01 * 0.18));
      if (now - this.lastHelmAt > Math.min(0.34, Math.max(0.14, 0.34 - amt * 0.16))) {
        this.sink.playHelmTurn(amt, ...at(getHelmControlLocal(stats)));
        this.lastHelmAt = now;
      }
    }
    // Sail rope through the blocks while the trim moves, and the fill thump when it lands.
    if (this.prevTrimH !== null) {
      const dh = Math.abs(ship.sailHeight - this.prevTrimH);
      const da = Math.abs(angleWrap(ship.sailAngle - this.prevTrimA));
      if ((dh > 0.055 || da > 0.18) && now - this.lastTrimAt > 0.36) {
        this.sink.playSailTrim(Math.min(1.25, Math.max(0.35, dh * 7 + da * 1.6)), ...at(getSailControlLocal(stats)));
        this.lastTrimAt = now;
      }
    }
    this.prevTrimH = ship.sailHeight;
    this.prevTrimA = ship.sailAngle;
    const fill = this.fill.update(ship.sailHeight, ship.sailAngle, !!ship.luffing, apparentMs);
    if (fill > 0) {
      const [p, d] = at({ x: 0, z: 0 });
      this.sink.playSailFill(fill, { x: p.x, y: p.y + 6, z: p.z }, d);
    }
    // Cannon load/ram: a gun whose cooldown just ran out was swabbed, loaded and rammed.
    const cds = ship.cannonCooldowns ?? [];
    for (let i = 0; i < cds.length; i++) {
      const prev = this.prevCooldowns[i];
      if (prev !== undefined && prev > 0 && fin(cds[i]) <= 0) {
        this.sink.playCannonLoad(...at(getCannonDeckLocalPosition(stats, i)));
      }
      this.prevCooldowns[i] = fin(cds[i]);
    }
    this.prevCooldowns.length = cds.length;
  }
}
