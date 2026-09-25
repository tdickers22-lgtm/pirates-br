/**
 * Ambience zones (b2.4h; audio-07): what an island sounds like from where you stand.
 *
 * The branch is named for its volcanic geysers and they were silent. This module owns the
 * zone beds and the positioned island voices; SoundEngine.setAmbience applies its plan once a
 * frame on the ambience bus (so the Ambience slider, the combat duck and the below-deck
 * occlusion all act on it).
 *
 * The pure laws (exported, graded by test-ambience without an AudioContext):
 *   geyserVoice     hiss / roar / cutoff by geyserEruptionLevel (the SAME shared timing the
 *                   plume draws from), times a distance fade. Monotonic in the level: a bigger
 *                   jet is never quieter or duller.
 *   calderaRumble   the sub rumble off a volcano's caldera by distance (1 within 30 m, 0 past 260 m).
 *   lavaBubble      the rate/level of lava bubbling near the crater (0 past 70 m).
 *   waterfallLevel  white water by distance to the nearest fall and its size (0 past 130 m).
 *   jungleLevels    day birds / night insects / frogs by biome, how far inland the listener is,
 *                   night and storm.
 *
 * Sources: VolcanicFx registers every island it builds (biome, centre, radius, caldera,
 * geysers) and installs a read-only accessor here (setZoneSourceProvider). This module never
 * imports the renderer, so the audio tests load it under plain node.
 */
import type { IslandBiome } from '../../shared/types/index.js';

export interface ZonePoint { x: number; y: number; z: number }

/** One island as the ear needs it. `geysers[i].level` is geyserEruptionLevel at the world time
 *  the plume was last drawn with, so sound and steam can never disagree. */
export interface IslandSoundZone {
  islandId: string;
  biome: IslandBiome;
  x: number;
  z: number;
  radius: number;
  caldera: ZonePoint | null;
  geysers: ReadonlyArray<ZonePoint & { level: number }>;
}

type ZoneProvider = () => readonly IslandSoundZone[];
let provider: ZoneProvider | null = null;

/** VolcanicFx installs its accessor here; tests install a fake. null clears it. */
export function setZoneSourceProvider(fn: ZoneProvider | null): void {
  provider = typeof fn === 'function' ? fn : null;
}

/** Every live island zone (empty before the world is built, or if the provider throws). */
export function zoneSources(): readonly IslandSoundZone[] {
  if (!provider) return [];
  try {
    const z = provider();
    return Array.isArray(z) ? z : [];
  } catch {
    return [];
  }
}

const fin = (v: unknown, fb = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, fin(v)));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((fin(x) - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export const GEYSER_AUDIBLE_M = 170;
export const CALDERA_AUDIBLE_M = 260;
export const LAVA_AUDIBLE_M = 70;
export const WATERFALL_AUDIBLE_M = 130;

/** Distance fade shared by the zone voices: 1/(1 + d/ref), faded to exactly 0 at `max`. */
export function zoneFalloff(distM: number, ref: number, max: number): number {
  const d = Math.max(0, fin(distM, Infinity));
  if (!(d < max)) return 0;
  return (1 / (1 + d / ref)) * (1 - smooth(max * 0.7, max, d));
}

export interface GeyserVoice { hiss: number; roar: number; cutoffHz: number; gain: number }
/**
 * The geyser: a steam hiss that builds as the vent starts to spit, a low roar once the jet is
 * up, and a brightening cutoff. Every output is non-decreasing in `level` at a fixed distance.
 */
export function geyserVoice(level: number, distM: number): GeyserVoice {
  const lv = clamp01(level);
  const gain = zoneFalloff(distM, 24, GEYSER_AUDIBLE_M);
  const hiss = (0.22 * smooth(0, 0.12, lv) + 0.78 * lv) * gain;
  const roar = Math.pow(lv, 1.6) * gain;
  const cutoffHz = 1400 + 5200 * lv;
  return { hiss, roar, cutoffHz, gain };
}

/** Caldera rumble 0..1: full within 30 m of the crater, gone past CALDERA_AUDIBLE_M. */
export function calderaRumble(distM: number): number {
  const d = Math.max(0, fin(distM, Infinity));
  if (d <= 30) return 1;
  return zoneFalloff(d - 30, 60, CALDERA_AUDIBLE_M - 30);
}

/** Lava bubbling near the crater: level 0..1 and bubbles per second. */
export function lavaBubble(distM: number): { level: number; perSec: number } {
  const level = zoneFalloff(distM, 14, LAVA_AUDIBLE_M);
  return { level, perSec: level > 0.02 ? 2.5 + 5 * level : 0 };
}

/** Waterfall white water 0..1.6 by distance and size (scale 0.3..1.6). */
export function waterfallLevel(distM: number | null, scale = 1): number {
  if (distM === null || !Number.isFinite(distM)) return 0;
  const size = Math.min(1.6, Math.max(0.3, fin(scale, 1)));
  return zoneFalloff(distM, 26, WATERFALL_AUDIBLE_M) * size;
}

/** How much of each biome is jungle (canopy birds, insects, frogs). */
export const JUNGLE_WEIGHT: Readonly<Record<IslandBiome, number>> = {
  lush: 1, palm_atoll: 0.7, highland: 0.5, volcanic: 0.25, bone: 0.08,
};

export interface JungleLevels { dayBirds: number; insects: number; frogs: number; inland: number }
/**
 * @param distToCentreM listener to island centre, @param radiusM island radius. `inland` is 1
 * deep inside the island, 0 from 1.15 radii out (so the canopy thins toward the beach and the
 * sea takes over).
 */
export function jungleLevels(s: { biome: IslandBiome | string; distToCentreM: number; radiusM: number; night01: number; storm01: number }): JungleLevels {
  const w = JUNGLE_WEIGHT[s.biome as IslandBiome] ?? 0.5;
  const r = Math.max(1, fin(s.radiusM, 1));
  const inland = 1 - smooth(0.55, 1.15, fin(s.distToCentreM, Infinity) / r);
  const night = clamp01(s.night01);
  const storm = clamp01(s.storm01);
  const base = w * inland;
  return {
    inland,
    dayBirds: base * (1 - night) * (1 - storm * 0.85),
    insects: base * night * (1 - storm * 0.7),
    frogs: base * smooth(0.3, 0.8, night) * (1 - storm * 0.6) * (s.biome === 'lush' ? 1 : 0.55),
  };
}

export interface ZoneCall { key: string; pos: ZonePoint; volume: number; rate: number; fallback: 'bird' | 'frog' | 'bubble' | 'steam' }
export interface ZoneFrame {
  caldera: number;
  lava: number;
  insects: number;
  geyser: GeyserVoice & { pos: ZonePoint | null; level: number };
  /** Nearest island within reach (zones tier should be decoding). */
  nearIsland: boolean;
  calls: ZoneCall[];
}

const dist = (a: ZonePoint, b: ZonePoint): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Per-frame planner: the continuous layer levels, plus scheduled one-shots (birds, frogs, lava
 * bubbles, the steam burst when a geyser starts to blow) with world positions. `rand` is
 * injectable so tests are deterministic.
 */
export class Ambience {
  private nextBirdAt = 0;
  private nextFrogAt = 0;
  private nextBubbleAt = 0;
  private prevGeyserLevel = new Map<string, number>();
  last: ZoneFrame | null = null;

  constructor(private readonly rand: () => number = Math.random) {}

  update(now: number, ear: ZonePoint, night01: number, storm01: number, zones: readonly IslandSoundZone[]): ZoneFrame {
    const t = fin(now);
    const out: ZoneFrame = {
      caldera: 0, lava: 0, insects: 0, nearIsland: false, calls: [],
      geyser: { hiss: 0, roar: 0, cutoffHz: 1400, gain: 0, pos: null, level: 0 },
    };
    let birds = 0;
    let frogs = 0;
    let lavaPos: ZonePoint | null = null;
    let lavaPerSec = 0;
    for (const z of zones) {
      if (!z || !Number.isFinite(z.x) || !Number.isFinite(z.z)) continue;
      const dc = Math.hypot(ear.x - z.x, ear.z - z.z);
      if (dc < fin(z.radius, 0) + 220) out.nearIsland = true;
      const j = jungleLevels({ biome: z.biome, distToCentreM: dc, radiusM: z.radius, night01, storm01 });
      birds = Math.max(birds, j.dayBirds);
      out.insects = Math.max(out.insects, j.insects);
      frogs = Math.max(frogs, j.frogs);
      if (z.caldera) {
        const d = dist(ear, z.caldera);
        out.caldera = Math.max(out.caldera, calderaRumble(d));
        const lb = lavaBubble(d);
        if (lb.level > out.lava) { out.lava = lb.level; lavaPos = z.caldera; lavaPerSec = lb.perSec; }
      }
      for (let i = 0; i < z.geysers.length; i++) {
        const g = z.geysers[i];
        const lv = clamp01(g.level);
        const v = geyserVoice(lv, dist(ear, g));
        if (v.hiss + v.roar > out.geyser.hiss + out.geyser.roar) out.geyser = { ...v, pos: { x: g.x, y: g.y, z: g.z }, level: lv };
        // Onset: the vent crosses 0.15 on the way up -> one steam burst at the vent.
        const id = `${z.islandId}:${i}`;
        const prev = this.prevGeyserLevel.get(id) ?? lv;
        this.prevGeyserLevel.set(id, lv);
        if (prev < 0.15 && lv >= 0.15 && v.gain > 0.02) {
          out.calls.push({ key: 'steam.hiss', pos: { x: g.x, y: g.y + 1.5, z: g.z }, volume: Math.min(1, 0.4 + v.gain), rate: 0.9 + this.rand() * 0.15, fallback: 'steam' });
        }
      }
    }
    // Scheduled one-shots: a bird every ~2.5-7 s at full canopy, a frog chorus by night,
    // lava bubbles at the crater. Positions scatter around the ear (birds up in the canopy).
    const around = (rMin: number, rMax: number, up: number): ZonePoint => {
      const a = this.rand() * Math.PI * 2;
      const r = rMin + this.rand() * (rMax - rMin);
      return { x: ear.x + Math.cos(a) * r, y: ear.y + up * this.rand(), z: ear.z + Math.sin(a) * r };
    };
    if (birds > 0.05) {
      if (this.nextBirdAt === 0 || this.nextBirdAt > t + 30) this.nextBirdAt = t + 1 + this.rand() * 3;
      else if (t >= this.nextBirdAt) {
        out.calls.push({ key: 'bird.day', pos: around(12, 40, 14), volume: 0.35 + 0.5 * birds, rate: 0.92 + this.rand() * 0.18, fallback: 'bird' });
        this.nextBirdAt = t + (2.5 + this.rand() * 4.5) / Math.max(0.35, birds);
      }
    } else this.nextBirdAt = 0;
    if (frogs > 0.05) {
      if (this.nextFrogAt === 0 || this.nextFrogAt > t + 30) this.nextFrogAt = t + 0.5 + this.rand() * 2;
      else if (t >= this.nextFrogAt) {
        out.calls.push({ key: 'creature.frog', pos: around(8, 30, 0.5), volume: 0.3 + 0.45 * frogs, rate: 0.85 + this.rand() * 0.3, fallback: 'frog' });
        this.nextFrogAt = t + (1.8 + this.rand() * 3.5) / Math.max(0.35, frogs);
      }
    } else this.nextFrogAt = 0;
    if (lavaPos && lavaPerSec > 0) {
      if (this.nextBubbleAt === 0 || this.nextBubbleAt > t + 30) this.nextBubbleAt = t + this.rand() / lavaPerSec;
      else if (t >= this.nextBubbleAt) {
        const p = lavaPos;
        out.calls.push({ key: '', pos: { x: p.x + (this.rand() - 0.5) * 4, y: p.y, z: p.z + (this.rand() - 0.5) * 4 }, volume: out.lava, rate: 0.7 + this.rand() * 0.8, fallback: 'bubble' });
        this.nextBubbleAt = t + (0.4 + this.rand() * 1.2) / lavaPerSec;
      }
    } else this.nextBubbleAt = 0;
    this.last = out;
    return out;
  }
}
