/**
 * The plank-repair blow clock, shared by the first-person hammer swing
 * (ViewmodelController / poses.ts) and the mallet one-shot (FloodAudio), so
 * every hammer sound lands on a visible impact (b2-ask-03). Pure, no THREE.
 */

/** One hammer blow lasts 0.8 s: the server's HOLE_REPAIR_TIME 1.6/2.4/3.2 s is
 *  2/3/4 blows by hole size, so blows = round(repairTime / 0.8). */
export const REPAIR_BLOW_S = 0.8;
export function repairBlowsFor(repairTime: number): number {
  const n = Math.round((Number.isFinite(repairTime) ? repairTime : 2.4) / REPAIR_BLOW_S);
  return Math.min(6, Math.max(1, n));
}
/** Blow position (0..blows) from the replicated hullRepairProgress (0..1). */
export function repairBlowPosition(progress: number, blows: number): number {
  return Math.min(1, Math.max(0, progress)) * blows;
}
/** Blow phase 0..1 from the replicated hullRepairProgress (0..1). The head
 *  meets the plank at HAMMER_IMPACT_PHASE of every blow, so the last impact
 *  lands before the server closes the hole at progress 1. */
export function repairBlowPhase(progress: number, blows: number): number {
  const x = repairBlowPosition(progress, blows);
  return x - Math.floor(x);
}
export const HAMMER_IMPACT_PHASE = 0.72;
/** Impacts (head meets plank) crossed moving the blow position from `prevX`
 *  to `x`: the integers k with prevX < k + HAMMER_IMPACT_PHASE <= x. */
export function repairImpactsCrossed(prevX: number, x: number): number {
  if (!(x > prevX)) return 0;
  return Math.floor(x - HAMMER_IMPACT_PHASE) - Math.floor(prevX - HAMMER_IMPACT_PHASE);
}
