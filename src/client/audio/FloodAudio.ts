// SoT-style flooding sound (b2.4d, audio-02). Per hull within earshot:
//  - up to FLOOD_GUSH_VOICES positioned gush loops, one ON each breach (floodFx's
//    getFloodEmitters: world pos, exit speed sqrt(2 g h), submerged-inside, release strength),
//    level from speed and tear size, the deepest kept when there are more;
//  - a slosh bed at the hull by hold fill and roll/pitch RATE, a gurgle above half full;
//  - one-shots on edges: hole punched (wood crack by size), plank knocked on (patch knock,
//    the gush then releases over 300 ms with the jet), mallet blow on every visible hammer impact of repair,
//    founder stages (groan, frame cracks, air bursting out, suction).
// Another hull is attenuated by distance AND by its planking. The Web Audio side lives behind
// FloodAudioHost (SoundEngine implements it) so the gate drives this class on a fake host.
import type { ShipHole } from '../../shared/types/index.js';
import { repairBlowPosition, repairBlowsFor, repairImpactsCrossed } from '../rendering/viewmodel/repairBlows.js';
import {
  FLOOD_AUDIBLE_M, FLOOD_GUSH_RELEASE_S, FLOOD_GUSH_VOICES, FLOOD_HULL_OCCLUSION, FLOOD_HULL_OCCLUSION_CUTOFF, FLOOD_MAX_SHIPS,
  floodDistanceGain, founderCuesCrossed, gurgleLevel, gushFromSpeed, holePunchParams,
  pickGushVoices, sloshLevel,
} from './floodAudioModel.js';

export interface FloodVec { x: number; y: number; z: number }

export type FloodLoopKind = 'gush' | 'slosh' | 'gurgle';
export type FloodOneShotKind =
  | 'holePunch' | 'patchKnock' | 'hammer' | 'scoop' | 'fling' | 'groan' | 'frameCrack' | 'airRelease' | 'suction';

export interface FloodLoopParams { gain: number; cutoff: number; rate: number; pos: FloodVec }
export interface FloodLoopHandle {
  set(p: FloodLoopParams, glideS: number): void;
  stop(releaseS: number): void;
  /** False once the host took the voice back (the VoiceAllocator stole it for a
   *  louder or more important sound): FloodAudio drops the handle and asks again. */
  alive?(): boolean;
}
export interface FloodAudioHost {
  /** A looping water voice, or null when the host has no voice for it (the loop
   *  counts against the same voice cap as every sample; `own` = the hull you are on). */
  openLoop(kind: FloodLoopKind, pos: FloodVec, own?: boolean): FloodLoopHandle | null;
  /** Positioned one-shot; the host applies its own distance law. volume already carries hull occlusion. */
  oneShot(kind: FloodOneShotKind, pos: FloodVec | null, volume: number, rate: number): void;
}

/** The part of floodFx's FloodEmitter this needs. */
export interface FloodAudioEmitter {
  holeId: number;
  worldPos: FloodVec;
  v: number;
  submergedInside: boolean;
  strength: number;
}

export interface FloodAudioShip {
  id: string;
  position: FloodVec;
  waterLevel?: number;
  roll?: number;
  pitch?: number;
  holes?: ShipHole[];
  sinking?: boolean;
  sinkProgress?: number;
  alive?: boolean;
  rotation?: number;
}

export interface FloodAudioFrame {
  dt: number;
  listener: FloodVec;
  /** The hull the listener stands on (heard open, always voiced first). */
  aboardShipId: string | null;
  ships: Iterable<FloodAudioShip>;
  emitters(shipId: string): readonly FloodAudioEmitter[];
  /** Local player's plank progress 0..1 (hullRepairProgress) and where the mallet is. */
  /** The local plank repair. `blowX` is the first-person swing's live blow
   *  position (ViewmodelController.getRepairBlowPosition); without it the blow
   *  clock is derived from progress and `repairTime` (s). */
  repair?: { progress: number; pos: FloodVec; blowX?: number | null; repairTime?: number } | null;
}

interface ShipTrack {
  gush: Map<number, FloodLoopHandle>;
  slosh: FloodLoopHandle | null;
  gurgle: FloodLoopHandle | null;
  holes: Map<number, boolean>;
  prevRoll: number;
  prevPitch: number;
  prevSink: number;
  seen: boolean;
}

function dist(a: FloodVec, b: FloodVec): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
function finite(n: number | undefined, d = 0): number {
  return typeof n === 'number' && Number.isFinite(n) ? n : d;
}

const byDistance = (a: { d: number }, b: { d: number }): number => a.d - b.d;
const holePos = (h: ShipHole): FloodVec => ({ x: h.x, y: h.y, z: h.z });

export class FloodAudio {
  /** The listener's space applied to its OWN hull (b2.4g): +4 dB below deck, 1.2 kHz / -6 dB heard
   *  from the weather deck. Other hulls keep FLOOD_HULL_OCCLUSION (never both). SoundEngine sets it. */
  ownSpace: { gain: number; cutoff: number } = { gain: 1, cutoff: Infinity };
  private readonly tracks = new Map<string, ShipTrack>();
  private repairX = -1;
  private prevRepair = 0;
  /** Loop gains written last update, per ship (gates and probes). */
  readonly lastGains = new Map<string, { gush: number[]; slosh: number; gurgle: number }>();

  // Per-frame scratch (b2 gate, frame-allocation): the candidate list, its records, the kept-id
  // set and the hole-size map are reused every update, never rebuilt.
  private readonly candPool: Array<{ ship: FloodAudioShip; d: number; own: boolean }> = [];
  private readonly cands: Array<{ ship: FloodAudioShip; d: number; own: boolean }> = [];
  private readonly keep = new Set<string>();
  private readonly holeSize = new Map<number, number | undefined>();

  constructor(private readonly host: FloodAudioHost) {}

  /** Number of live gush loops (all ships). */
  get gushVoices(): number {
    let n = 0;
    for (const t of this.tracks.values()) n += t.gush.size;
    return n;
  }

  update(frame: FloodAudioFrame): void {
    const dt = Math.max(0, Math.min(0.25, finite(frame.dt)));
    const L = frame.listener;
    // Which hulls to voice: the one underfoot, then the nearest others within earshot.
    const cands = this.cands;
    cands.length = 0;
    for (const ship of frame.ships) {
      if (!ship || typeof ship.id !== 'string' || ship.alive === false) continue;
      const own = ship.id === frame.aboardShipId;
      const d = dist(L, ship.position);
      if (!own && !(d <= FLOOD_AUDIBLE_M)) continue;
      let c = this.candPool[cands.length];
      if (!c) { c = { ship, d: 0, own: false }; this.candPool.push(c); }
      c.ship = ship; c.d = own ? -1 : d; c.own = own;
      cands.push(c);
    }
    cands.sort(byDistance);
    const keep = this.keep;
    keep.clear();
    for (let i = 0; i < cands.length && i < FLOOD_MAX_SHIPS; i++) {
      const c = cands[i];
      keep.add(c.ship.id);
      this.updateShip(c.ship, c.own, dt, L, frame.emitters(c.ship.id) ?? []);
    }
    for (const [id, tr] of this.tracks) {
      if (!keep.has(id)) this.dropTrack(id, tr);
    }
    this.updateRepair(frame.repair ?? null);
  }

  /** Silence everything (match end, respawn). */
  reset(): void {
    for (const [id, tr] of this.tracks) this.dropTrack(id, tr);
    this.repairX = -1;
    this.prevRepair = 0;
  }

  /** Local bail edges: scoop (bucket dips) and fling (water over the rail). */
  bucket(kind: 'scoop' | 'fling', pos: FloodVec | null): void {
    this.host.oneShot(kind, pos, kind === 'fling' ? 0.9 : 0.6, kind === 'fling' ? 0.95 : 1.2);
  }

  private dropTrack(id: string, tr: ShipTrack): void {
    for (const h of tr.gush.values()) h.stop(FLOOD_GUSH_RELEASE_S);
    tr.slosh?.stop(0.7);
    tr.gurgle?.stop(0.7);
    this.tracks.delete(id);
    this.lastGains.delete(id);
  }

  private updateShip(ship: FloodAudioShip, own: boolean, dt: number, L: FloodVec, emitters: readonly FloodAudioEmitter[]): void {
    let tr = this.tracks.get(ship.id);
    const roll = finite(ship.roll);
    const pitch = finite(ship.pitch);
    if (!tr) {
      tr = { gush: new Map(), slosh: null, gurgle: null, holes: new Map(), prevRoll: roll, prevPitch: pitch, prevSink: -1, seen: false };
      this.tracks.set(ship.id, tr);
    }
    const occl = own ? this.ownSpace.gain : FLOOD_HULL_OCCLUSION;
    const holeSize = this.holeSize;
    holeSize.clear();
    // ── edges on the hole list: punched, patched, plank knocked off ──
    for (const h of ship.holes ?? []) {
      if (!h || typeof h.id !== 'number') continue;
      holeSize.set(h.id, h.size);
      const was = tr.holes.get(h.id);
      tr.holes.set(h.id, !!h.patched);
      if (!tr.seen) continue; // first sight of a hull: learn its holes silently
      const at = emitters.find((e) => e.holeId === h.id)?.worldPos ?? this.holeWorld(ship, holePos(h));
      if ((was === undefined && !h.patched) || (was === true && !h.patched)) {
        const p = holePunchParams(h.size);
        this.host.oneShot('holePunch', at, p.volume * occl, p.rate);
      } else if (was === false && h.patched) {
        this.host.oneShot('patchKnock', at, 0.8 * occl, 1);
      }
    }
    // ── founder stages ──
    const sink = ship.sinking ? Math.min(1, Math.max(0, finite(ship.sinkProgress))) : -1;
    if (tr.seen && sink >= 0) {
      for (const kind of founderCuesCrossed(tr.prevSink, sink)) {
        this.host.oneShot(kind, ship.position, occl * (kind === 'groan' ? 1 : 0.85), kind === 'suction' ? 0.7 : 1);
      }
    }
    tr.prevSink = sink;
    tr.seen = true;
    // ── gush loops on the breaches ──
    const picked = pickGushVoices(emitters, FLOOD_GUSH_VOICES);
    const live = new Set<number>();
    const gains: number[] = [];
    for (const e of picked) {
      const g = gushFromSpeed(e.v, holeSize.get(e.holeId), e.submergedInside, e.strength);
      const gain = g.level * floodDistanceGain(dist(L, e.worldPos), own) * (own ? this.ownSpace.gain : 1);
      let h = tr.gush.get(e.holeId);
      if (h && h.alive && !h.alive()) { tr.gush.delete(e.holeId); h = undefined; }
      if (!h && gain > 1e-4) {
        h = this.host.openLoop('gush', e.worldPos, own) ?? undefined;
        if (h) tr.gush.set(e.holeId, h);
      }
      if (!h) continue;
      live.add(e.holeId);
      gains.push(gain);
      const cutoff = own ? Math.min(g.cutoff, this.ownSpace.cutoff) : Math.min(g.cutoff, FLOOD_HULL_OCCLUSION_CUTOFF);
      // A releasing (patched) jet follows its 300 ms fade; a live one glides.
      h.set({ gain, cutoff, rate: g.rate, pos: e.worldPos }, e.v <= 0 ? 0.05 : 0.12);
    }
    for (const [id, h] of tr.gush) {
      if (!live.has(id)) {
        h.stop(FLOOD_GUSH_RELEASE_S);
        tr.gush.delete(id);
      }
    }
    // ── slosh + gurgle at the hull ──
    const fill = Math.min(1, Math.max(0, finite(ship.waterLevel)));
    const rollRate = dt > 0 ? (roll - tr.prevRoll) / dt : 0;
    const pitchRate = dt > 0 ? (pitch - tr.prevPitch) / dt : 0;
    tr.prevRoll = roll;
    tr.prevPitch = pitch;
    const dg = floodDistanceGain(dist(L, ship.position), own) * (own ? this.ownSpace.gain : 1);
    const s = sloshLevel(fill, rollRate, pitchRate);
    const sloshGain = s.level * dg;
    tr.slosh = this.loopTo(tr.slosh, 'slosh', own, ship.position, sloshGain, own ? Math.min(s.cutoff, this.ownSpace.cutoff) : Math.min(s.cutoff, FLOOD_HULL_OCCLUSION_CUTOFF), s.rate);
    const gg = gurgleLevel(fill) * 0.6 * dg;
    tr.gurgle = this.loopTo(tr.gurgle, 'gurgle', own, ship.position, gg, 520, 0.5);
    this.lastGains.set(ship.id, { gush: gains, slosh: sloshGain, gurgle: gg });
  }

  private loopTo(h: FloodLoopHandle | null, kind: FloodLoopKind, own: boolean, pos: FloodVec, gain: number, cutoff: number, rate: number): FloodLoopHandle | null {
    if (h && h.alive && !h.alive()) h = null;
    if (gain <= 1e-4) {
      if (h) h.stop(0.6);
      return null;
    }
    const v = h ?? this.host.openLoop(kind, pos, own);
    v?.set({ gain, cutoff, rate, pos }, 0.4);
    return v;
  }

  private updateRepair(repair: FloodAudioFrame['repair']): void {
    const p = repair ? finite(repair.progress) : 0;
    if (repair && p > 0 && p >= this.prevRepair) {
      // b2-ask-03: one mallet hit per VISIBLE blow, on the frame the hammer
      // face meets the plank (HAMMER_IMPACT_PHASE of the shared blow clock),
      // so a 1.6/2.4/3.2 s repair sounds 2/3/4 hits, never on a raise.
      const x = repair.blowX != null && Number.isFinite(repair.blowX)
        ? repair.blowX
        : repairBlowPosition(p, repairBlowsFor(repair.repairTime ?? 2.4));
      const from = this.repairX < 0 ? 0 : this.repairX;
      // A snapshot jump never machine-guns: at most one hit per frame.
      if (repairImpactsCrossed(from, x) > 0) {
        this.host.oneShot('hammer', repair.pos, 1, 0.94 + (Math.floor(x) % 3) * 0.04);
      }
      this.repairX = Math.max(from, x);
    } else {
      this.repairX = -1;
    }
    this.prevRepair = p;
  }

  /** Hull-local hole to world on the server's pose model (floodFx holeWorldPoint). */
  private holeWorld(ship: FloodAudioShip, local: FloodVec): FloodVec {
    const r = finite(ship.rotation);
    const c = Math.cos(r);
    const s = Math.sin(r);
    return {
      x: ship.position.x + local.x * c + local.z * s,
      y: ship.position.y + local.y + local.x * Math.sin(finite(ship.roll)) - local.z * Math.sin(finite(ship.pitch)),
      z: ship.position.z + local.z * c - local.x * s,
    };
  }
}
