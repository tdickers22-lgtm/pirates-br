/**
 * THE FRAME LOOP CANNOT DIE (correctness-06).
 *
 * `Game.frame()` used to re-arm requestAnimationFrame as its LAST statement,
 * with nothing around the body. One throw anywhere in a frame (a Safari
 * AudioParam RangeError from a NaN gain, a mesh lookup on an entity removed
 * between snapshot and frame, a HUD node missing on a phone layout) stopped
 * rAF forever: the canvas froze on its last image, inputs stopped, and the
 * socket worker's heartbeat kept the seat alive, so the pirate stood still
 * until somebody killed him. The player saw nothing; only the console knew.
 *
 * The contract now:
 *  - the next frame is scheduled in a `finally`, so ONE exception costs ONE
 *    frame and never the loop;
 *  - each distinct message is logged once (a fault repeating at 60 Hz must not
 *    bury the console) and reported to the error beacon;
 *  - FAULT_LIMIT consecutive faulting frames (0.5 s at 60 Hz) mean the client
 *    is wedged, not unlucky: the reload overlay goes up ONCE, with the copy the
 *    spec fixes, and one beacon says so. A clean frame resets the streak.
 *
 * Kept free of `three` and of Game so `scripts/test-frame-guard.mjs` can drive
 * it with a fake scheduler and a fake clock.
 */

export const FRAME_FAULT_LIMIT = 30;
export const FRAME_FAULT_COPY = 'Something broke on our side. Reload to rejoin (your seat is held for a minute)';

export interface FrameGuardOptions {
  /** Arms the next frame. `requestAnimationFrame` in the client. */
  schedule: (cb: (now: number) => void) => unknown;
  /** Consecutive faulting frames before the reload overlay. */
  faultLimit?: number;
  /** Called for the first occurrence of each distinct fault message. */
  onFault?: (err: unknown, info: { consecutive: number; total: number }) => void;
  /** Called exactly once, when the streak first reaches the limit. */
  onWedged?: (err: unknown) => void;
  log?: (msg: string, err: unknown) => void;
}

export class FrameGuard {
  /** Frames whose body ran to completion. The probe reads this advancing. */
  frames = 0;
  /** Every faulting frame, ever. */
  totalFaults = 0;
  /** Faulting frames in a row; a clean frame resets it. */
  consecutiveFaults = 0;
  /** The reload overlay has been raised (it is raised at most once). */
  wedged = false;
  private injected = 0;
  private readonly seen = new Set<string>();
  private readonly limit: number;

  constructor(private readonly opts: FrameGuardOptions) {
    this.limit = Math.max(1, opts.faultLimit ?? FRAME_FAULT_LIMIT);
  }

  /** Debug hook (`__piratesBR.injectFrameFault(n)`): the next `n` frame bodies throw. */
  injectFault(n: number): void {
    this.injected = Math.max(0, Math.floor(Number(n) || 0));
  }

  /**
   * Run one frame. `loop` is the function the scheduler calls next (usually the
   * caller's own frame method): it is armed in `finally`, whatever `body` does.
   */
  run(now: number, body: (now: number) => void, loop: (now: number) => void): void {
    try {
      if (this.injected > 0) {
        this.injected -= 1;
        throw new Error('injected frame fault');
      }
      body(now);
      this.frames += 1;
      this.consecutiveFaults = 0;
    } catch (err) {
      this.noteFault(err);
    } finally {
      this.opts.schedule(loop);
    }
  }

  private noteFault(err: unknown): void {
    this.totalFaults += 1;
    this.consecutiveFaults += 1;
    const key = faultKey(err);
    if (!this.seen.has(key)) {
      // Bounded: a fault whose message embeds a number would otherwise grow this forever.
      if (this.seen.size < 64) this.seen.add(key);
      (this.opts.log ?? ((m, e) => console.error(m, e)))('[frame] fault (logged once per message)', err);
      try {
        this.opts.onFault?.(err, { consecutive: this.consecutiveFaults, total: this.totalFaults });
      } catch { /* a reporter must never become the next fault */ }
    }
    if (!this.wedged && this.consecutiveFaults >= this.limit) {
      this.wedged = true;
      try { this.opts.onWedged?.(err); } catch { /* same */ }
    }
  }
}

function faultKey(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 300);
  return String(err).slice(0, 300);
}

/**
 * The reload overlay. Built on demand (it should never exist in a healthy
 * session) and self-contained, so it does not depend on the HUD that may be
 * the very thing throwing.
 */
export function showFrameFaultOverlay(doc: Document = document): HTMLElement {
  const existing = doc.getElementById('frame-fault-overlay');
  if (existing) return existing;
  const root = doc.createElement('div');
  root.id = 'frame-fault-overlay';
  root.setAttribute('role', 'alertdialog');
  root.setAttribute('aria-live', 'assertive');
  root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;'
    + 'justify-content:center;background:rgba(6,10,16,0.82);color:#f3e7c9;'
    + 'font:600 18px/1.4 system-ui,-apple-system,sans-serif;text-align:center;padding:24px;';
  const box = doc.createElement('div');
  box.style.cssText = 'max-width:520px;display:flex;flex-direction:column;gap:18px;align-items:center;';
  const text = doc.createElement('p');
  text.style.margin = '0';
  text.textContent = FRAME_FAULT_COPY;
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = 'Reload';
  button.style.cssText = 'font:700 18px system-ui,sans-serif;padding:12px 32px;border-radius:10px;'
    + 'border:0;background:#d9a441;color:#1a1208;cursor:pointer;min-height:48px;';
  button.addEventListener('click', () => { doc.defaultView?.location.reload(); });
  box.append(text, button);
  root.append(box);
  doc.body.append(root);
  return root;
}
