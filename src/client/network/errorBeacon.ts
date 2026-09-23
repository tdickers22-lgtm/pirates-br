/**
 * CLIENT ERROR BEACON (online-12, vm:correctness:3).
 *
 * After launch the only way anybody learns that iPhones crash on load or that
 * Safari drops the WebGL context is if the page says so. This module turns the
 * page's own failure signals into small anonymous POSTs to `/beacon`:
 *   - window `error` and `unhandledrejection`,
 *   - frame faults and the wedged-loop overlay (from frameGuard),
 *   - `webglcontextlost` (from Renderer),
 *   - a load that has not reached the menu 30 s after navigation.
 *
 * Privacy: no name, no player id, no device id, no full UA string. The server
 * side (b1.2g) never writes the IP. Budget: at most MAX_PER_SESSION reports,
 * each distinct message once, each body capped well under the server's 4 KB.
 *
 * Transport: `navigator.sendBeacon` (survives pagehide, never blocks), with a
 * keepalive fetch as the fallback. A 404 before the server route exists is
 * harmless: the POST is fire-and-forget.
 */

export type BeaconKind =
  | 'error' | 'rejection' | 'frame-fault' | 'frame-wedged'
  | 'webglcontextlost' | 'webglcontextrestored' | 'longload';

export const BEACON_URL = '/beacon';
export const MAX_PER_SESSION = 5;
const MESSAGE_MAX = 300;
const STACK_MAX = 1500;

interface BeaconContext { buildId: string; tier: string }
const context: BeaconContext = { buildId: 'dev', tier: 'unknown' };
const sentKeys = new Set<string>();
let sent = 0;
let installed = false;

export function setBeaconContext(patch: Partial<BeaconContext>): void {
  if (patch.buildId) context.buildId = String(patch.buildId).slice(0, 40);
  if (patch.tier) context.tier = String(patch.tier).slice(0, 20);
}

/** Coarse device class: browser family + OS + phone/tablet/desktop. Never the raw UA. */
export function uaClass(ua: string = globalThis.navigator?.userAgent ?? '', touchPoints = globalThis.navigator?.maxTouchPoints ?? 0): string {
  const os = /iPhone|iPod/.test(ua) ? 'ios'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1) ? 'ipados'
      : /Android/.test(ua) ? 'android'
        : /Mac OS X|Macintosh/.test(ua) ? 'mac'
          : /Windows/.test(ua) ? 'windows'
            : /Linux|CrOS/.test(ua) ? 'linux' : 'other';
  const browser = /Edg\//.test(ua) ? 'edge'
    : /Firefox\/|FxiOS/.test(ua) ? 'firefox'
      : /Chrome\/|CriOS/.test(ua) ? 'chrome'
        : /Safari\//.test(ua) ? 'safari' : 'other';
  const device = os === 'ios' || (os === 'android' && /Mobile/.test(ua)) ? 'phone'
    : os === 'ipados' || os === 'android' ? 'tablet' : 'desktop';
  return `${browser}/${os}/${device}`;
}

function describe(err: unknown): { message: string; stack: string } {
  if (err instanceof Error) {
    return { message: `${err.name}: ${err.message}`.slice(0, MESSAGE_MAX), stack: String(err.stack ?? '').slice(0, STACK_MAX) };
  }
  return { message: String(err).slice(0, MESSAGE_MAX), stack: '' };
}

/** Reports one event. Returns false when deduped, over budget or without a transport. */
export function reportBeacon(kind: BeaconKind, err?: unknown): boolean {
  const { message, stack } = describe(err ?? kind);
  const key = `${kind}|${message}`;
  if (sentKeys.has(key) || sent >= MAX_PER_SESSION) return false;
  sentKeys.add(key);
  sent += 1;
  const body = JSON.stringify({
    buildId: context.buildId, kind, message, stack, ua: uaClass(), tier: context.tier,
  });
  try {
    const nav = globalThis.navigator;
    if (nav?.sendBeacon && nav.sendBeacon(BEACON_URL, new Blob([body], { type: 'application/json' }))) return true;
    if (typeof fetch === 'function') {
      void fetch(BEACON_URL, {
        method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' },
      }).catch(() => { /* fire and forget */ });
      return true;
    }
  } catch { /* a reporter never throws into the page */ }
  return false;
}

/** How many reports this session has spent (debug/probe reading). */
export function beaconStats(): { sent: number; max: number } {
  return { sent, max: MAX_PER_SESSION };
}

/**
 * Installs the window hooks once. `isLoaded` tells the 30 s long-load watch
 * whether the menu has arrived.
 */
export function installErrorBeacon(opts: { isLoaded?: () => boolean; longLoadMs?: number } = {}): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e: ErrorEvent) => {
    // A failed <img>/<script> load fires a bare Event with no message; not ours to report.
    if (!e.message && !e.error) return;
    reportBeacon('error', e.error ?? e.message);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    reportBeacon('rejection', e.reason);
  });
  const longLoadMs = opts.longLoadMs ?? 30_000;
  const since = typeof performance !== 'undefined' ? performance.now() : 0;
  window.setTimeout(() => {
    if (opts.isLoaded && !opts.isLoaded()) {
      reportBeacon('longload', `menu not reached ${Math.round((performance.now() - since) / 1000)} s after boot`);
    }
  }, longLoadMs);
}
