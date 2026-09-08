/**
 * THE DEATH CAMERA STOPS FRAMING AN EMPTY DECK (avatar-24, liveplay-16).
 *
 * The per-player mesh loop set `mesh.visible = !isLocal && …`. That is right
 * for a living pirate — you are looking out of his eyes and drawing his skull
 * inside the near plane is how you get a head full of geometry — but it also
 * meant the LOCAL body was never drawn when he died. The camera then lifts off
 * the corpse's eye and cranes up (Game.SPECTATE_RISE_SECONDS) to frame… the
 * spot where nothing is. Every other pirate in the match leaves a body that
 * crumples and fades over eight seconds; yours left nothing at all, and the
 * five seconds after your own death are the five a player watches hardest.
 *
 * Pure, so `scripts/test-crew-ui.mjs` can state the rule under plain node.
 */

export interface CorpseVisibilityInput {
  /** Is this the pirate whose eyes the camera normally sits behind? */
  isLocal: boolean;
  /** Server state is 'eliminated' or 'respawning'. */
  isDead: boolean;
  /** A skeleton's remains are still within their linger window. */
  skeletonDeathVisible: boolean;
  /** A pirate corpse record exists and has not faded out. */
  pirateCorpseVisible: boolean;
  /** Below the two-and-a-half-pixel draw floor (characterTooSmallToDraw). */
  tooSmallToDraw: boolean;
  /** The local swim viewmodel is standing in for the body. */
  useLocalSwimViewmodel: boolean;
  /** The local pirate's own body is drawn this frame (avatar-10): head culled,
   *  arms culled while a first-person rig has hands out, shadow cast on the
   *  deck. False at the 'low' tier, which has no shadow pass to pay for it. */
  localBodyDrawn?: boolean;
}

/**
 * The one rule for "is this body on screen".
 *
 * The local pirate is drawn ONLY as a corpse: alive, the camera is inside his
 * head. `tooSmallToDraw` still wins over everything — a corpse two pixels tall
 * is forty draw calls for nothing, and the local corpse is never far away, so
 * this costs no draws in practice.
 */
export function playerMeshVisible(i: CorpseVisibilityInput): boolean {
  if (i.tooSmallToDraw) return false;
  if (i.useLocalSwimViewmodel) return false;
  const remains = i.skeletonDeathVisible || i.pirateCorpseVisible;
  if (i.isLocal) return remains || (!!i.localBodyDrawn && !i.isDead);
  return remains || !i.isDead;
}
