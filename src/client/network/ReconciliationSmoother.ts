/**
 * THE LOCAL PLAYER'S DRAWN RECONCILIATION (b2.0d; critique gap 7).
 *
 * Reconciliation (PredictionRing.replay on every input_ack, steered by
 * PredictionClock) keeps the predicted body where the server will have it. When
 * an ack disagrees with the prediction the predicted body moves at once; drawing
 * that move is the "snap" the player sees. On a real link the residual is set by
 * the upstream wire, not by the client: an input that sat behind a lost TCP
 * segment is applied 100-200 ms after its predicted start, and at 5.5 m/s the
 * server's body ends up 0.3-0.8 m from the predicted one (test-wan-netcode seed 5:
 * p99 0.320 m, worst 0.80 m). No client-side clock can foresee a retransmit.
 *
 * So the correction is not drawn in one frame. The drawn body is the predicted
 * body plus an offset; each ack ADDS its correction to the offset (the drawn body
 * stays put), and the offset decays with time constant TAU_S, so a correction c
 * is shown as c x (1 - e^(-dt/TAU)) per frame (15% a frame at 60 Hz for 100 ms),
 * i.e. a short slide instead of a pop. An offset past SNAP_M is not a
 * misprediction to hide but a different place (respawn, teleport, a desync): it
 * is dropped and the body snaps, and the caller counts it.
 *
 * The prediction itself is untouched: gameplay (hit tests, aim origin, the next
 * replay) reads the predicted body, only the renderer reads `drawn`.
 *
 * PURE: no clock, no allocation per call. TAU_S 0 is "no smoothing" (the whole
 * correction is released on the next frame), the arm test-wan-netcode's snap
 * bar must fail.
 */
export class ReconciliationSmoother {
  /** Offset from the predicted body to the drawn body, metres (world or deck frame, the caller's). */
  x = 0;
  y = 0;
  z = 0;
  /** Default time constant of the decay, seconds. */
  static readonly TAU_S = 0.1;
  /** An offset past this is a relocation, not a misprediction: snap. */
  static readonly SNAP_M = 2.0;

  constructor(readonly tauS: number = ReconciliationSmoother.TAU_S, readonly snapM: number = ReconciliationSmoother.SNAP_M) {}

  /**
   * The predicted body just moved by (dx, dy, dz) because of reconciliation
   * (new predicted - old predicted). Keeps the drawn body where it was.
   * Returns false when the accumulated offset passed SNAP_M and was dropped.
   */
  absorb(dx: number, dy: number, dz: number): boolean {
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) { this.reset(); return false; }
    this.x -= dx; this.y -= dy; this.z -= dz;
    if (Math.hypot(this.x, this.y, this.z) > this.snapM) { this.reset(); return false; }
    return true;
  }

  /** Decay the offset over one render frame of `dt` seconds. Returns how far the drawn body slid relative to the predicted one this frame, metres. */
  decay(dt: number): number {
    const keep = this.tauS > 0 && dt > 0 ? Math.exp(-dt / this.tauS) : 0;
    const lose = 1 - keep;
    const step = Math.hypot(this.x, this.y, this.z) * lose;
    this.x *= keep; this.y *= keep; this.z *= keep;
    if (Math.abs(this.x) < 1e-5 && Math.abs(this.y) < 1e-5 && Math.abs(this.z) < 1e-5) { this.x = 0; this.y = 0; this.z = 0; }
    return step;
  }

  /** A frame change (boarding, leaving a deck) or a state transition: the old offset means nothing in the new frame. */
  reset(): void { this.x = 0; this.y = 0; this.z = 0; }
}
