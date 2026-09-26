/**
 * CUE CAPTIONS (b3.5e; crossdevice-16, PLAN D33).
 *
 * Closed captions for the sounds that carry game information: water rushing in
 * through a new hole, a cannon firing off to port, footsteps behind you, the
 * wreck's bell, the storm closing. Phones are played muted and deaf or
 * hard-of-hearing players get nothing from the mix, so every curated cue gets a
 * short line with an arrow that points where the sound came from RELATIVE TO
 * THE CAMERA YAW (the arrow turns as you turn).
 *
 *  - SoundEngine emits `this.cue('<id>', pos?, distance?)` from the play method
 *    that voices the sound, BEFORE its "no AudioContext" early return, so a
 *    phone that never unlocked audio still gets its captions.
 *  - Settings > Captions: off / key cues / all (A11ySettings.captions).
 *  - At most CAPTION_MAX_LINES lines, each CAPTION_TTL_S seconds; a repeat of a
 *    cue that is still on screen refreshes it (and its arrow) instead of adding
 *    a line. When a new line needs room, the oldest 'all'-tier line goes first.
 *
 * Pure store + maths up top (graded in node by scripts/test-captions.mjs), the
 * DOM strip at the bottom.
 */
import { activeA11ySettings } from './hudModel.js';

export type CaptionMode = 'off' | 'key' | 'all';
export type CaptionTier = 'key' | 'all';
export const CAPTION_MODES: readonly CaptionMode[] = ['off', 'key', 'all'];

export interface CaptionCueDef {
  label: string;
  /** 'key' shows in both modes; 'all' only when Captions = all. */
  tier: CaptionTier;
  /** Draw a bearing arrow when the emitter passes a world position. */
  directional: boolean;
  /** Only caption someone ELSE's sound: skip when distance <= REMOTE_MIN_M (your own cannon, your own feet). */
  remoteOnly?: boolean;
  /** Do not caption past this many metres (the sound is inaudible or irrelevant beyond it). */
  maxDistance?: number;
}

/** The curated list. Every id here is emitted by SoundEngine (test-captions greps it). */
export const CAPTION_CUES = {
  water_rushing: { label: 'Water rushing in', tier: 'key', directional: true, maxDistance: 60 },
  cannon_fire: { label: 'Cannon fire', tier: 'key', directional: true, remoteOnly: true, maxDistance: 400 },
  cannonball_incoming: { label: 'Cannonball whistling', tier: 'key', directional: true },
  hull_struck: { label: 'Hull struck', tier: 'key', directional: true, maxDistance: 200 },
  ships_collide: { label: 'Ships colliding', tier: 'key', directional: true, maxDistance: 240 },
  hull_grounding: { label: 'Hull scraping ground', tier: 'key', directional: true, maxDistance: 240 },
  gunshot: { label: 'Gunshot', tier: 'key', directional: true, remoteOnly: true, maxDistance: 250 },
  footsteps: { label: 'Footsteps', tier: 'key', directional: true, remoteOnly: true, maxDistance: 30 },
  keg_fuse: { label: 'Keg fuse hissing', tier: 'key', directional: true, maxDistance: 60 },
  explosion: { label: 'Explosion', tier: 'key', directional: true, maxDistance: 400 },
  fire: { label: 'Fire crackling', tier: 'key', directional: true, maxDistance: 80 },
  sail_torn: { label: 'Sail tearing', tier: 'key', directional: true, maxDistance: 200 },
  ship_bell: { label: 'Ship bell tolling', tier: 'key', directional: true },
  storm_closing: { label: 'Storm closing in', tier: 'key', directional: false },
  shark: { label: 'Shark growling', tier: 'key', directional: true, maxDistance: 80 },
  shark_bite: { label: 'Shark biting', tier: 'key', directional: true, maxDistance: 80 },
  pirate_down: { label: 'Pirate down', tier: 'key', directional: false },
  bounty_posted: { label: 'Bounty horn', tier: 'key', directional: false },
  wreck_rising: { label: 'Wreck rising', tier: 'key', directional: false },
  chest_lifted: { label: 'Chest lifted', tier: 'key', directional: false },
  chest_opened: { label: 'Chest opened', tier: 'all', directional: false },
  respawn_beacon: { label: 'Respawn beacon', tier: 'all', directional: true, maxDistance: 200 },
  chainshot: { label: 'Chainshot whirring', tier: 'all', directional: true },
  thunder: { label: 'Thunder', tier: 'all', directional: false },
  match_horn: { label: 'Match horn', tier: 'all', directional: false },
  splash: { label: 'Splash', tier: 'all', directional: true, remoteOnly: true, maxDistance: 90 },
  anchor_dropped: { label: 'Anchor dropped', tier: 'all', directional: true, maxDistance: 120 },
  anchor_raised: { label: 'Anchor raised', tier: 'all', directional: true, maxDistance: 120 },
  door_creak: { label: 'Door creaking', tier: 'all', directional: false },
  tree_falling: { label: 'Tree falling', tier: 'all', directional: true, maxDistance: 120 },
  digging: { label: 'Digging', tier: 'all', directional: false },
  hammering: { label: 'Hammering', tier: 'all', directional: false },
  bailing: { label: 'Bailing water', tier: 'all', directional: false },
  cannon_loaded: { label: 'Cannon loaded', tier: 'all', directional: true, maxDistance: 60 },
  animal: { label: 'Animal calls', tier: 'all', directional: true, maxDistance: 60 },
} as const satisfies Record<string, CaptionCueDef>;

export type CaptionCueId = keyof typeof CAPTION_CUES;

export const CAPTION_MAX_LINES = 3;
export const CAPTION_TTL_S = 2.5;
/** Closer than this the sound is "on you": no arrow, and a remoteOnly cue is your own. */
export const CAPTION_ON_YOU_M = 1.5;
export const REMOTE_MIN_M = 0.5;

export type CaptionArrow = '' | '↑' | '↗' | '→' | '↘' | '↓' | '↙' | '←' | '↖';
const ARROWS: readonly Exclude<CaptionArrow, ''>[] = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const ARROW_WORDS: Record<CaptionArrow, string> = {
  '': '', '↑': 'ahead', '↗': 'ahead right', '→': 'right', '↘': 'behind right',
  '↓': 'behind', '↙': 'behind left', '←': 'left', '↖': 'ahead left',
};
export function arrowWord(a: CaptionArrow): string { return ARROW_WORDS[a]; }

/**
 * Bearing of a sound relative to where the camera looks, as one of 8 arrows.
 * (dx, dz) = source minus listener on the ground plane; (fwdX, fwdZ) = the
 * camera's flattened forward. Right = (-fwdZ, fwdX), the same convention as
 * SoundEngine's stereo pan (forward (0,-1) has right (+1, 0)).
 */
export function captionArrow(dx: number, dz: number, fwdX: number, fwdZ: number): CaptionArrow {
  if (![dx, dz, fwdX, fwdZ].every(Number.isFinite)) return '';
  if (Math.hypot(dx, dz) < CAPTION_ON_YOU_M) return '';
  const fl = Math.hypot(fwdX, fwdZ);
  if (fl < 1e-6) return '';
  const fx = fwdX / fl, fz = fwdZ / fl;
  const front = dx * fx + dz * fz;
  const right = dx * -fz + dz * fx;
  const ang = Math.atan2(right, front); // 0 ahead, +pi/2 right
  const sector = ((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8;
  return ARROWS[sector];
}

export interface CaptionPos { x: number; y: number; z: number }
export interface CaptionLine { id: CaptionCueId; label: string; tier: CaptionTier; arrow: CaptionArrow; text: string; expiresAt: number }

interface Entry { id: CaptionCueId; tier: CaptionTier; pos: CaptionPos | null; bornAt: number; expiresAt: number }

/** Is this cue shown under `mode`, at `distance` metres? */
export function captionAllowed(id: CaptionCueId, mode: CaptionMode, distance?: number): boolean {
  const def: CaptionCueDef | undefined = CAPTION_CUES[id];
  if (!def || mode === 'off') return false;
  if (mode === 'key' && def.tier !== 'key') return false;
  const d = typeof distance === 'number' && Number.isFinite(distance) ? distance : null;
  if (def.remoteOnly && (d === null || d <= REMOTE_MIN_M)) return false;
  if (def.maxDistance !== undefined && d !== null && d > def.maxDistance) return false;
  return true;
}

/** The caption store: dedupe, 3-line cap, 2.5 s lifetime, arrows from the latest listener pose. */
export class CaptionStore {
  private entries: Entry[] = [];
  private lx = 0; private lz = 0; private fx = 0; private fz = -1; private known = false;
  /** Bumps whenever the visible set changes (the view repaints on change only). */
  version = 0;

  setListener(pos: CaptionPos, fwdX: number, fwdZ: number): void {
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return;
    this.lx = pos.x; this.lz = pos.z; this.fx = fwdX; this.fz = fwdZ; this.known = true;
  }

  /** Add or refresh a caption. Returns false when the mode or distance filters it out. */
  push(id: CaptionCueId, now: number, mode: CaptionMode, pos?: CaptionPos | null, distance?: number): boolean {
    const def: CaptionCueDef | undefined = CAPTION_CUES[id];
    if (!def) return false;
    let d = distance;
    const p = pos && Number.isFinite(pos.x) && Number.isFinite(pos.z) ? { x: pos.x, y: pos.y, z: pos.z } : null;
    // No distance given (a breach on your own hull): measure it from the listener.
    if (d === undefined && p && this.known) d = Math.hypot(p.x - this.lx, p.z - this.lz);
    if (!captionAllowed(id, mode, d)) return false;
    this.prune(now);
    const keepPos = def.directional ? p : null;
    const same = this.entries.find((e) => e.id === id);
    if (same) {
      same.expiresAt = now + CAPTION_TTL_S;
      if (keepPos) same.pos = keepPos;
    } else {
      if (this.entries.length >= CAPTION_MAX_LINES) {
        // Room: the oldest 'all' line goes first, then the oldest of any tier.
        let victim = this.entries.findIndex((e) => e.tier === 'all');
        if (victim < 0 || (def.tier === 'all' && this.entries[victim].tier !== 'all')) victim = 0;
        this.entries.splice(victim, 1);
      }
      this.entries.push({ id, tier: def.tier, pos: keepPos, bornAt: now, expiresAt: now + CAPTION_TTL_S });
    }
    this.version++;
    return true;
  }

  private prune(now: number): void {
    const before = this.entries.length;
    if (before === 0) return;
    this.entries = this.entries.filter((e) => e.expiresAt > now);
    if (this.entries.length !== before) this.version++;
  }

  /** Lines on screen at `now`, oldest first, with arrows for the CURRENT camera yaw. */
  lines(now: number): CaptionLine[] {
    this.prune(now);
    return this.entries.map((e) => {
      const def: CaptionCueDef = CAPTION_CUES[e.id];
      const arrow = e.pos && this.known ? captionArrow(e.pos.x - this.lx, e.pos.z - this.lz, this.fx, this.fz) : '';
      return { id: e.id, label: def.label, tier: e.tier, arrow, text: arrow ? `${arrow} ${def.label}` : def.label, expiresAt: e.expiresAt };
    });
  }

  clear(): void {
    if (this.entries.length) this.version++;
    this.entries = [];
  }
}

/** The one store the game uses (SoundEngine writes, the HUD strip reads). */
export const cueCaptions = new CaptionStore();

const clockS = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

/** SoundEngine's entry point: caption `id` under the player's current Captions setting. */
export function emitCaption(id: CaptionCueId, pos?: CaptionPos | null, distance?: number): void {
  const mode = activeA11ySettings().captions;
  if (mode === 'off') return;
  if (cueCaptions.push(id, clockS(), mode, pos, distance)) ensureTicking();
}

// ---------------------------------------------------------------------------
// DOM strip: bottom-centre, above the combat row, inside #hud (hidden with it).
// ---------------------------------------------------------------------------
let strip: HTMLElement | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let paintedKey = '';

/** Mount the caption strip (HudController constructor). Idempotent. */
export function mountCueCaptions(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  if (strip && strip.isConnected) return strip;
  strip = document.getElementById('hud-captions');
  if (!strip) {
    strip = document.createElement('div');
    strip.id = 'hud-captions';
    strip.setAttribute('role', 'log');
    strip.setAttribute('aria-live', 'polite');
    strip.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:calc(150px + env(safe-area-inset-bottom, 0px))', 'transform:translateX(-50%)',
      'display:flex', 'flex-direction:column', 'align-items:center', 'gap:4px', 'pointer-events:none', 'z-index:40',
      'zoom:var(--hud-text-scale, 1)', 'max-width:min(560px, 90vw)',
    ].join(';');
    (document.getElementById('hud') ?? document.body).append(strip);
  }
  paint();
  return strip;
}

function ensureTicking(): void {
  if (typeof window === 'undefined') return;
  if (!strip) mountCueCaptions();
  paint();
  if (timer === null) timer = setInterval(paint, 100);
}

function paint(): void {
  if (!strip) return;
  const lines = cueCaptions.lines(clockS());
  const key = lines.map((l) => `${l.id}|${l.text}`).join('\n');
  if (key !== paintedKey) {
    paintedKey = key;
    strip.replaceChildren(...lines.map((l) => {
      const el = document.createElement('div');
      el.className = `hud-caption hud-caption-${l.tier}`;
      el.dataset.cue = l.id;
      el.textContent = l.text;
      if (l.arrow) el.setAttribute('aria-label', `${l.label}, ${arrowWord(l.arrow)}`);
      el.style.cssText = 'background:rgba(8,10,14,0.72);color:#f4efe2;font:600 15px/1.25 system-ui,sans-serif;'
        + 'padding:3px 10px;border-radius:4px;white-space:nowrap;text-shadow:0 1px 2px #000;';
      return el;
    }));
  }
  if (lines.length === 0 && timer !== null) { clearInterval(timer); timer = null; }
}
