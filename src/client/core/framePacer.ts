/**
 * FRAME PACER (performance-06, b1.5c).
 *
 * The client used to render every rAF callback. On a 90/120 Hz Android phone or
 * a 120/144 Hz desktop monitor that is 1.5-2.4x the GPU work the governor was
 * budgeting for, and on a phone it is pure heat: phones throttle within 3-6
 * minutes of sustained full-GPU load and a match is 10-20, so the blur arrives
 * exactly in the late fights. Nothing offered a 30 fps battery mode either.
 *
 * The pacer SKIPS rAF callbacks that arrive before the cap's next due time. The
 * caller (Game.frameBody) returns before touching `lastFrameTime`, so the next
 * RENDERED frame's raw dt is the rendered interval, and that interval is what
 * the sim integrates and what the governor grades (the performance verifier's
 * point: grading 33 ms paced frames against a 16.7 ms budget is the exact
 * mis-grading `FrameGovernor.setDisplayHz` was written to stop, so the governor
 * also reads the cap directly and targets it).
 *
 * Due times sit on a fixed lattice (`due += interval`), not "now + interval":
 * on a 144 Hz panel (6.94 ms) a cap of 60 then averages 60 exactly instead of
 * collapsing to 48 (every third callback). A frame that arrives more than one
 * interval late resyncs the lattice, so a slow device is never asked to catch up.
 *
 * Defaults (PLAN b1.5c): desktop renders at the display rate (option 30 / 60 /
 * uncapped), tablets 60, phones 30 with a 60 opt-in, Battery saver 30 anywhere.
 * `?fps=30|60|uncapped|auto` overrides for rigs. Server-authoritative sim and
 * frame-rate-independent interpolation are untouched: the pacer only decides
 * which callbacks draw.
 *
 * Pure apart from `environmentFrameCap` (DOM reads, guarded), so
 * scripts/test-frame-pacer.mjs drives it with a synthetic clock.
 */
import { isMobileClient, mobileFormFactor, readGpuRendererString } from '../rendering/QualityPreference.js';

export type FrameCapChoice = 'auto' | '30' | '60' | 'uncapped';
export type PacerForm = 'phone' | 'tablet' | 'desktop';
export interface FrameCapSettings {
  choice: FrameCapChoice;
  batterySaver: boolean;
}

/** A callback this close to its due time still draws: rAF timestamps jitter by
 *  a millisecond or so, and skipping a frame that was 0.3 ms early would halve
 *  the rate on a display whose refresh equals the cap. */
export const FRAME_CAP_TOLERANCE_MS = 1.5;
export const BATTERY_SAVER_FPS = 30;
const STORAGE_KEY = 'piratesBR.frameCap';

export function parseFrameCapChoice(value: unknown): FrameCapChoice | null {
  return value === 'auto' || value === '30' || value === '60' || value === 'uncapped' ? value : null;
}

/** The cap in fps; 0 = no cap (render at the display rate). */
export function resolveFrameCap(form: PacerForm, settings: FrameCapSettings): number {
  if (settings.batterySaver) return BATTERY_SAVER_FPS;
  switch (settings.choice) {
    case '30': return 30;
    case '60': return 60;
    case 'uncapped': return 0;
    default: return form === 'phone' ? 30 : form === 'tablet' ? 60 : 0;
  }
}

export class FramePacer {
  private capFps = 0;
  private intervalMs = 0;
  private due = Number.NEGATIVE_INFINITY;
  private renderedCount = 0;
  private skippedCount = 0;
  /** b1.7c: rendered-interval tap (ms between two DRAWN frames) for sessionTelemetry. */
  private lastRenderedAt = Number.NaN;
  private renderedTap: ((intervalMs: number) => void) | null = null;

  setRenderedTap(fn: ((intervalMs: number) => void) | null): void {
    this.renderedTap = fn;
  }

  private noteRendered(nowMs: number): void {
    this.renderedCount += 1;
    if (this.renderedTap && this.lastRenderedAt === this.lastRenderedAt) this.renderedTap(nowMs - this.lastRenderedAt);
    this.lastRenderedAt = nowMs;
  }

  constructor(capFps = 0) {
    this.setCap(capFps);
  }

  /** 0 (or anything not a positive number) = uncapped. Takes effect on the next callback. */
  setCap(capFps: number): void {
    const cap = Number.isFinite(capFps) && capFps > 0 ? capFps : 0;
    if (cap === this.capFps) return;
    this.capFps = cap;
    this.intervalMs = cap > 0 ? 1000 / cap : 0;
    this.due = Number.NEGATIVE_INFINITY;
  }

  getCap(): number {
    return this.capFps;
  }

  /** True when this rAF callback should draw; false = skip it entirely. */
  shouldRender(nowMs: number): boolean {
    if (this.intervalMs <= 0) {
      this.noteRendered(nowMs);
      return true;
    }
    if (nowMs < this.due - FRAME_CAP_TOLERANCE_MS) {
      this.skippedCount += 1;
      return false;
    }
    this.due = nowMs - this.due > this.intervalMs ? nowMs + this.intervalMs : this.due + this.intervalMs;
    this.noteRendered(nowMs);
    return true;
  }

  getCounts(): { rendered: number; skipped: number } {
    return { rendered: this.renderedCount, skipped: this.skippedCount };
  }
}

export function loadFrameCapSettings(): FrameCapSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { choice?: unknown; batterySaver?: unknown }) : {};
    return { choice: parseFrameCapChoice(parsed.choice) ?? 'auto', batterySaver: parsed.batterySaver === true };
  } catch {
    return { choice: 'auto', batterySaver: false };
  }
}

export function saveFrameCapSettings(settings: FrameCapSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode */
  }
}

/** phone / tablet / desktop from the same signals the tier detector uses. */
export function detectPacerForm(): PacerForm {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'desktop';
  if (!isMobileClient(readGpuRendererString(), navigator)) return 'desktop';
  const w = window.screen?.width || window.innerWidth;
  const h = window.screen?.height || window.innerHeight;
  return mobileFormFactor(w, h);
}

/** The cap this session opens with: `?fps=` beats the stored choice. */
export function environmentFrameCap(): number {
  if (typeof window === 'undefined') return 0;
  const settings = loadFrameCapSettings();
  const param = parseFrameCapChoice(new URLSearchParams(window.location.search).get('fps'));
  if (param) return resolveFrameCap(detectPacerForm(), { choice: param, batterySaver: false });
  return resolveFrameCap(detectPacerForm(), settings);
}

/** The session's pacer. Game.frameBody asks it; the governor reads its cap. */
export const framePacer = new FramePacer(environmentFrameCap());

export function activeFrameCapFps(): number {
  return framePacer.getCap();
}

/** For the settings UI: store the choice and apply it live (next callback). */
export function applyFrameCapSettings(settings: FrameCapSettings): number {
  saveFrameCapSettings(settings);
  const cap = resolveFrameCap(detectPacerForm(), settings);
  framePacer.setCap(cap);
  return cap;
}
