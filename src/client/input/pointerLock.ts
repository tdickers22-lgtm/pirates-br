/**
 * POINTER LOCK THAT NEVER THROWS, AND LOOK DELTAS THAT NEVER SPIKE
 * (b1.4a; crossdevice-11).
 *
 * `el.requestPointerLock?.().catch(...)` throws a TypeError wherever the call
 * returns undefined (WebKit, older Firefox): the lock still engaged, but every
 * click threw and skipped its preventDefault. And Chromium/Safari deliver an
 * occasional huge movementX/Y on the first event after lock, which flicked the
 * camera half a turn.
 */

export type LockTarget = {
  requestPointerLock?: (options?: { unadjustedMovement?: boolean }) => unknown;
};

/**
 * Request pointer lock; tolerant of a missing method, a synchronous throw, an
 * undefined return and a rejected promise. When `unadjustedMovement` (raw input)
 * is refused, retries once without options. Returns true when a request was
 * issued (not a promise that it will be granted).
 */
export function requestLockSafe(el: LockTarget | null | undefined, options?: { unadjustedMovement?: boolean }): boolean {
  if (!el || typeof el.requestPointerLock !== 'function') return false;
  try {
    const result = options ? el.requestPointerLock(options) : el.requestPointerLock();
    const maybe = result as { catch?: (fn: (err: unknown) => void) => unknown } | undefined | null;
    if (maybe && typeof maybe.catch === 'function') {
      maybe.catch(() => {
        if (!options) return;
        // Raw input unsupported (or refused): fall back to a plain request.
        try {
          const retry = el.requestPointerLock?.() as { catch?: (fn: () => void) => unknown } | undefined;
          if (retry && typeof retry.catch === 'function') retry.catch(() => {});
        } catch { /* nothing else to try */ }
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** Per-event clamp on |movementX| and |movementY|, CSS px. */
export const LOOK_DELTA_CLAMP_PX = 300;

/**
 * Filters mouse-look deltas: the first movement after a lock is acquired is
 * discarded (the browser's spurious warp), then each axis is clamped to
 * +-LOOK_DELTA_CLAMP_PX per event.
 */
export class LookDeltaFilter {
  private skipNext = false;

  /** Call when pointer lock is (re)acquired. */
  onLockAcquired() { this.skipNext = true; }

  /** Returns the delta to apply, or null to drop the event. */
  filter(dx: number, dy: number): { dx: number; dy: number } | null {
    if (this.skipNext) {
      this.skipNext = false;
      return null;
    }
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
    const c = LOOK_DELTA_CLAMP_PX;
    return { dx: Math.max(-c, Math.min(c, dx)), dy: Math.max(-c, Math.min(c, dy)) };
  }
}
