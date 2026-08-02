/**
 * ONE SIGNAL FOR "HOW MUCH SPARE TIME DOES THIS FRAME HAVE".
 *
 * Five systems in this client amortize expensive work across frames — the
 * first-draw allowance, the island build queue, the sea-rock queue, the island
 * detail warmer and the program warmer — and every one of them was written with
 * its own hard-coded per-frame constant. Each constant is defensible alone and
 * they are not defensible together: they all spend the SAME main thread, on the
 * same frames, and none of them could tell whether that frame had any room in
 * it. A machine holding 60fps was being throttled to one island a frame for no
 * reason, and a machine at 8fps was being handed exactly the same quota.
 *
 * So the governor writes one number here once per frame and they all read it.
 * Above 1 means "there is headroom, stream faster"; below 1 means "the frame is
 * already late, back off". It is deliberately NOT the quality scalar: quality
 * answers how much PICTURE the machine can sustain, this answers how much WORK
 * this particular frame can absorb, and a machine can easily be fine on one and
 * not the other (a settled scene at full quality still has islands arriving).
 *
 * Every consumer applies it through `budgeted()`, which keeps a floor. A
 * throttle that can reach zero is not a throttle, it is a deadlock: the island
 * that is never built is never drawn, so the frame never gets faster, so the
 * island is never built.
 */

/** 0.25 … 1.4. Written by Renderer from FrameGovernor.getStreamingScale(). */
let scale = 1;

export function setFrameBudgetScale(next: number): void {
  scale = Number.isFinite(next) ? Math.max(0.1, Math.min(2, next)) : 1;
}

export function frameBudgetScale(): number {
  return scale;
}

/** Scale an amortized per-frame allowance, never below `floor`. Integer out,
 *  because every consumer counts whole meshes / islands / programs. */
export function budgeted(nominal: number, floor = 1): number {
  return Math.max(floor, Math.round(nominal * scale));
}

/** Measurement rigs settle the world with the allowance open; they must not
 *  also be racing a throttle that reads whatever the software rasteriser was
 *  doing at the time. */
export function resetFrameBudgetScale(): void {
  scale = 1;
}
