/**
 * REAL-USER SESSION TELEMETRY (b1.7c, D35, critique gaps 5a and 14).
 *
 * SwiftShader tells us nothing about a real phone's frame rate, thermal
 * throttling or an iOS memory kill. This module sends ONE small anonymous
 * summary per match to `/beacon` (kind `session`), so the live store
 * (`src/server/net/beaconStore.ts`) can answer "what share of phone sessions
 * hold 24 fps" and "how many matches died without an end screen".
 *
 * One summary per match:
 *   - at the end screen (`matchEnd`, matchCompleted: true), or
 *   - on `pagehide` while a match is running (matchCompleted: false), or
 *   - at the NEXT boot when the previous page died mid-match without either
 *     (the reload-without-clean-exit marker: set at match start, cleared at the
 *     end screen; iOS kills a tab for memory without firing pagehide, so a
 *     marker that survives to the next boot unreported is that signature).
 *   A per-match random nonce lets the store replace, never double count, the
 *   rare pagehide-then-bfcache-restore case.
 *
 * Privacy: no IP (the server never writes it), no name, no player id, no
 * device id, no raw UA. The nonce is random per match and never persisted
 * past the match.
 *
 * Frame intervals come from the frame pacer's rendered-interval tap (the
 * interval between two DRAWN frames, not rAF callbacks), binned into a 1 ms
 * histogram so a 20-minute match costs a fixed 1 KB.
 */

import { getBeaconContext, sendBeaconBody } from './errorBeacon.js';
import { CLIENT_BUILD_ID } from './versionGate.js';

export const SESSION_MARKER_KEY = 'pbr.session.marker';
export const SHOW_FPS_KEY = 'pbr.showFps';
/** Histogram upper bound: intervals >= this land in the last bin. */
const HIST_MAX_MS = 250;
const LONG_TASK_MS = 100;
const PILL_WINDOW_MS = 5000;

export type DeviceClass = 'phone' | 'tablet' | 'desktop';

export interface SessionSummary {
  kind: 'session';
  v: 1;
  nonce: string;
  buildId: string;
  device: DeviceClass;
  browser: string;
  tier: string;
  dpr: number;
  frames: number;
  frameP50Ms: number;
  frameP95Ms: number;
  fpsP50: number;
  longTasks: number;
  longFrames: number;
  contextLosses: number;
  reloadWithoutCleanExit: boolean;
  matchCompleted: boolean;
  durationSec: number;
}

interface Marker {
  nonce: string; buildId: string; device: DeviceClass; browser: string; tier: string; dpr: number;
  startedAt: number; reported?: boolean;
}

interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

export interface TelemetryDeps {
  send?: (body: string) => boolean;
  storage?: StorageLike | null;
  now?: () => number;
  wallNow?: () => number;
  random?: () => number;
  ua?: string;
  touchPoints?: number;
  dpr?: number;
  screenMin?: number;
  buildId?: string;
}

/** phone / tablet / desktop + coarse browser family. Never the raw UA. */
export function classifyDevice(ua: string, touchPoints = 0, screenMin = 0): { device: DeviceClass; browser: string } {
  const iphone = /iPhone|iPod/.test(ua);
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
  const android = /Android/.test(ua);
  const device: DeviceClass = iphone || (android && /Mobile/.test(ua)) ? 'phone'
    : ipad || android ? 'tablet'
      : touchPoints > 1 && screenMin > 0 && screenMin < 500 ? 'phone' : 'desktop';
  const browser = /Edg\//.test(ua) ? 'edge'
    : /Firefox\/|FxiOS/.test(ua) ? 'firefox'
      : /SamsungBrowser/.test(ua) ? 'samsung'
        : /Chrome\/|CriOS/.test(ua) ? 'chrome'
          : /Safari\//.test(ua) ? 'safari' : 'other';
  return { device, browser };
}

/** Percentile (0..1) of a 1 ms-bin histogram, as the bin's upper edge in ms. */
export function histPercentile(hist: Uint32Array, total: number, p: number): number {
  if (total <= 0) return 0;
  const target = Math.max(1, Math.ceil(total * p));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i + 1;
  }
  return hist.length;
}

export class SessionTelemetry {
  private readonly deps: Required<Omit<TelemetryDeps, 'storage'>> & { storage: StorageLike | null };
  private hist = new Uint32Array(HIST_MAX_MS);
  private frames = 0;
  private longTasks = 0;
  private longFrames = 0;
  private contextLosses = 0;
  private marker: Marker | null = null;
  private sentNonce = '';
  private tier = 'unknown';
  /** Rolling (time, interval) ring for the fps pill, independent of matches. */
  private recentT: number[] = [];
  private recentMs: number[] = [];
  /** How many summaries this page has sent (probe/test reading). */
  sentCount = 0;

  constructor(deps: TelemetryDeps = {}) {
    const g = globalThis as unknown as { navigator?: Navigator; localStorage?: Storage; devicePixelRatio?: number; screen?: Screen };
    let storage: StorageLike | null = null;
    try { storage = deps.storage !== undefined ? deps.storage : (g.localStorage ?? null); } catch { storage = null; }
    this.deps = {
      send: deps.send ?? sendBeaconBody,
      storage,
      now: deps.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now())),
      wallNow: deps.wallNow ?? (() => Date.now()),
      random: deps.random ?? Math.random,
      ua: deps.ua ?? g.navigator?.userAgent ?? '',
      touchPoints: deps.touchPoints ?? g.navigator?.maxTouchPoints ?? 0,
      dpr: deps.dpr ?? g.devicePixelRatio ?? 1,
      screenMin: deps.screenMin ?? (g.screen ? Math.min(g.screen.width, g.screen.height) : 0),
      buildId: deps.buildId ?? CLIENT_BUILD_ID,
    };
  }

  setTier(tier: string): void { this.tier = String(tier).slice(0, 16); }

  /** The pacer's rendered-interval tap: ms between two drawn frames. */
  recordFrame(intervalMs: number): void {
    if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) return;
    const t = this.deps.now();
    this.recentT.push(t);
    this.recentMs.push(intervalMs);
    let drop = 0;
    while (drop < this.recentT.length && t - this.recentT[drop] > PILL_WINDOW_MS) drop++;
    if (drop > 0) { this.recentT.splice(0, drop); this.recentMs.splice(0, drop); }
    if (!this.marker) return;
    this.hist[Math.min(HIST_MAX_MS - 1, Math.floor(intervalMs))] += 1;
    this.frames += 1;
    if (intervalMs > LONG_TASK_MS) this.longFrames += 1;
  }

  noteLongTask(durationMs: number): void { if (this.marker && durationMs > LONG_TASK_MS) this.longTasks += 1; }
  noteContextLoss(): void { if (this.marker) this.contextLosses += 1; }

  /** Rendered fps p50 over the last 5 s (the Show FPS pill), 0 when idle. */
  fpsP50Recent(): number {
    if (this.recentMs.length === 0) return 0;
    const sorted = [...this.recentMs].sort((a, b) => a - b);
    const mid = sorted[Math.floor((sorted.length - 1) / 2)];
    return mid > 0 ? 1000 / mid : 0;
  }

  inMatch(): boolean { return this.marker !== null; }

  /** Match start: reset the counters and set the reload marker. */
  matchStart(): void {
    if (this.tier === 'unknown') {
      try { this.setTier(getBeaconContext().tier); } catch { /* keep unknown */ }
    }
    if (this.marker && this.sentNonce !== this.marker.nonce) this.flush(false);
    const { device, browser } = classifyDevice(this.deps.ua, this.deps.touchPoints, this.deps.screenMin);
    const nonce = Math.floor(this.deps.random() * 0xffffffff).toString(36) + Math.floor(this.deps.random() * 0xffffffff).toString(36);
    this.marker = {
      nonce, buildId: this.deps.buildId.slice(0, 40), device, browser, tier: this.tier,
      dpr: Math.round(this.deps.dpr * 100) / 100, startedAt: this.deps.now(),
    };
    this.hist.fill(0);
    this.frames = 0; this.longTasks = 0; this.longFrames = 0; this.contextLosses = 0;
    this.writeMarker({ ...this.marker, startedAt: this.deps.wallNow() });
  }

  /** End screen (completed) or Return to Port mid-match (not): the clean exit. Clears the marker and sends the summary. */
  matchEnd(completed = true): void {
    if (!this.marker) return;
    if (completed || this.sentNonce !== this.marker.nonce) this.flush(completed);
    this.marker = null;
    this.removeMarker();
  }

  /** pagehide mid-match: send what we have; the exit was seen, so mark it reported. */
  pageHide(): void {
    if (!this.marker || this.sentNonce === this.marker.nonce) return;
    this.flush(false);
    const stored = this.readMarker();
    if (stored && stored.nonce === this.marker.nonce) this.writeMarker({ ...stored, reported: true });
  }

  /** pageshow from bfcache: the match continues; a later end replaces the pagehide summary (same nonce). */
  pageShow(): void {
    if (this.marker) this.sentNonce = '';
  }

  /**
   * Boot: a marker left by a page that never reached the end screen AND never
   * fired pagehide is the memory-kill signature. Report it once, then clear.
   */
  checkPreviousRun(): SessionSummary | null {
    const stored = this.readMarker();
    if (!stored) return null;
    this.removeMarker();
    if (stored.reported) return null;
    const summary: SessionSummary = {
      kind: 'session', v: 1, nonce: stored.nonce, buildId: stored.buildId, device: stored.device,
      browser: stored.browser, tier: stored.tier, dpr: stored.dpr, frames: 0, frameP50Ms: 0, frameP95Ms: 0,
      fpsP50: 0, longTasks: 0, longFrames: 0, contextLosses: 0, reloadWithoutCleanExit: true,
      matchCompleted: false, durationSec: Math.max(0, Math.round((this.deps.wallNow() - stored.startedAt) / 1000)),
    };
    this.send(summary);
    return summary;
  }

  /** The summary the current match would send now. */
  summary(matchCompleted: boolean): SessionSummary | null {
    const m = this.marker;
    if (!m) return null;
    const p50 = histPercentile(this.hist, this.frames, 0.5);
    return {
      kind: 'session', v: 1, nonce: m.nonce, buildId: m.buildId, device: m.device, browser: m.browser,
      tier: this.tier !== 'unknown' ? this.tier : m.tier, dpr: m.dpr, frames: this.frames,
      frameP50Ms: p50, frameP95Ms: histPercentile(this.hist, this.frames, 0.95),
      fpsP50: p50 > 0 ? Math.round(10000 / p50) / 10 : 0,
      longTasks: this.longTasks, longFrames: this.longFrames, contextLosses: this.contextLosses,
      reloadWithoutCleanExit: false, matchCompleted,
      durationSec: Math.max(0, Math.round((this.deps.now() - m.startedAt) / 1000)),
    };
  }

  private flush(matchCompleted: boolean): void {
    const s = this.summary(matchCompleted);
    if (!s) return;
    this.sentNonce = s.nonce;
    this.send(s);
  }

  private send(s: SessionSummary): void {
    this.sentCount += 1;
    try { this.deps.send(JSON.stringify(s)); } catch { /* never throws into the page */ }
  }

  private readMarker(): Marker | null {
    try {
      const raw = this.deps.storage?.getItem(SESSION_MARKER_KEY);
      const parsed = raw ? (JSON.parse(raw) as Marker) : null;
      return parsed && typeof parsed.nonce === 'string' ? parsed : null;
    } catch { return null; }
  }

  private writeMarker(m: Marker): void {
    try { this.deps.storage?.setItem(SESSION_MARKER_KEY, JSON.stringify(m)); } catch { /* private mode */ }
  }

  private removeMarker(): void {
    try { this.deps.storage?.removeItem(SESSION_MARKER_KEY); } catch { /* private mode */ }
  }
}

export const sessionTelemetry = new SessionTelemetry();
let installed = false;

/** Window hooks, once: pagehide/pageshow, long tasks, context loss (capture), the boot check. */
export function installSessionTelemetry(t: SessionTelemetry = sessionTelemetry): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('pagehide', () => t.pageHide());
  window.addEventListener('pageshow', (e: PageTransitionEvent) => { if (e.persisted) t.pageShow(); });
  // webglcontextlost does not bubble; a capture listener on the document still sees it.
  document.addEventListener('webglcontextlost', () => t.noteContextLoss(), true);
  try {
    const PO = (globalThis as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (PO && PO.supportedEntryTypes?.includes('longtask')) {
      new PO((list) => { for (const e of list.getEntries()) t.noteLongTask(e.duration); }).observe({ type: 'longtask', buffered: false });
    }
  } catch { /* Safari: no longtask; longFrames still counts > 100 ms rendered intervals */ }
  t.checkPreviousRun();
}

// ── Settings > Show FPS pill ─────────────────────────────────────────────

export function loadShowFps(): boolean {
  try { return localStorage.getItem(SHOW_FPS_KEY) === '1'; } catch { return false; }
}

let pill: HTMLElement | null = null;
let pillTimer = 0;

/** Show or hide the pill (rendered fps p50 over the last 5 s, repainted twice a second). */
export function setShowFps(on: boolean, t: SessionTelemetry = sessionTelemetry): void {
  try { localStorage.setItem(SHOW_FPS_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  if (typeof document === 'undefined') return;
  if (!on) {
    if (pillTimer) window.clearInterval(pillTimer);
    pillTimer = 0;
    pill?.remove();
    pill = null;
    return;
  }
  if (pill) return;
  pill = document.createElement('div');
  pill.id = 'hud-fps-pill';
  pill.setAttribute('aria-hidden', 'true');
  pill.style.cssText = 'position:fixed;top:calc(env(safe-area-inset-top, 0px) + 6px);right:calc(env(safe-area-inset-right, 0px) + 8px);'
    + 'z-index:60;pointer-events:none;padding:2px 8px;border-radius:10px;background:rgba(10,18,28,0.62);'
    + 'color:#f4e2b2;font:600 11px/1.5 monospace;letter-spacing:0.04em;';
  pill.textContent = '-- fps';
  document.body.appendChild(pill);
  pillTimer = window.setInterval(() => {
    const fps = t.fpsP50Recent();
    if (pill) pill.textContent = fps > 0 ? `${Math.round(fps)} fps` : '-- fps';
  }, 500);
}

/** Settings row: a checkbox appended to `mount` (the settings panel). */
export function mountShowFpsSetting(mount: HTMLElement | null): HTMLInputElement | null {
  if (!mount || typeof document === 'undefined') return null;
  const row = document.createElement('label');
  row.className = 'settings-row';
  row.style.cssText = 'display:flex;align-items:center;gap:10px;margin:6px 0;font-size:0.8rem;color:#f4e2b2;';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.id = 'settings-show-fps';
  box.checked = loadShowFps();
  box.style.cssText = 'transform:scale(1.4);margin-left:8px;';
  const text = document.createElement('span');
  text.textContent = 'Show FPS';
  row.append(text, box);
  mount.appendChild(row);
  box.addEventListener('change', () => setShowFps(box.checked));
  if (box.checked) setShowFps(true);
  return box;
}
