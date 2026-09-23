/**
 * WHO IS ALLOWED TO FIRE, AIM AND LOOK (b1.4a; crossdevice-02).
 *
 * Fire, aim and look used to require pointer lock outright (`lockedOrForced`).
 * Touch and most gamepad sessions never hold pointer lock, so a touch or pad
 * layer on top would have had fire and aim silently dropped. The rule is now a
 * pure function of the input scheme:
 *  - mouse scheme: only under pointer lock (the first click after Esc only
 *    re-acquires the lock, it never fires; that desktop behaviour is unchanged);
 *  - touch / gamepad: always (they do not use the pointer);
 *  - ?forceinput QA flag: always.
 * The keyboard typing guard and the supply-wheel modal guard stay in
 * InputManager on top of this.
 */
import type { InputSchemeId } from '../../shared/bindings.js';

export type AuthorityState = {
  readonly pointerLocked: boolean;
  readonly scheme: InputSchemeId;
  readonly debugAssumeLocked?: boolean;
};

export function resolveInputAuthority(state: AuthorityState): boolean {
  if (state.debugAssumeLocked) return true;
  if (state.scheme === 'touch' || state.scheme === 'gamepad') return true;
  return state.pointerLocked;
}

/** The "click to look around" pill is a mouse-scheme device only: a phone or a
 *  pad player cannot click to lock, so telling them to is wrong. */
export function lockHintVisible(state: {
  readonly inMatch: boolean;
  readonly menuVisible: boolean;
  readonly pointerLocked: boolean;
  readonly scheme: InputSchemeId;
}): boolean {
  return state.inMatch && !state.menuVisible && !state.pointerLocked && state.scheme === 'mouse';
}
