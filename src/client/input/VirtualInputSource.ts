/**
 * A VIRTUAL INPUT SOURCE (b1.4b): on-screen touch controls today, the gamepad
 * (b1.4e) next. It never writes PlayerInput itself. It presses and releases
 * the SAME BindingAction rows the keyboard does (src/shared/bindings.ts) on a
 * sink, and InputManager merges them through the one held() read, so a touch
 * [X] hold is bit-for-bit the keyboard [X] hold on the wire: interact edge on
 * the press, interactHeld on every tick until the release.
 *
 * Pure logic, no DOM: scripts/test-touch-controls.mjs drives it directly.
 */
import type { BindingAction } from '../../shared/bindings.js';

export interface VirtualInputSink {
  setActionHeld(action: BindingAction, held: boolean): void;
  /** Look by a finger drag, in CSS pixels (the sink applies rad/px x sens x fovScale). */
  applyTouchLook(dxPx: number, dyPx: number): void;
}

/** Stick travel (0..1 of its radius) below which nothing moves. */
export const STICK_DEADZONE = 0.22;
/** A direction bit turns on when the stick points within ~67.5 deg of it
 *  (sin 22.5 deg): eight clean directions, diagonals included. */
const DIRECTION_COS = 0.383;
/** Level-read actions (fire) must survive at least one input tick, or a quick
 *  tap between two 30 Hz sends never reaches the server. */
const MIN_HOLD_MS: Partial<Record<BindingAction, number>> = { fire: 120, aim: 60 };

const STICK_ACTIONS = ['moveForward', 'moveBack', 'moveLeft', 'moveRight'] as const;

export class VirtualInputSource {
  private readonly held = new Map<BindingAction, number>();
  private readonly releaseTimers = new Map<BindingAction, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly sink: VirtualInputSink, now: () => number = () => Date.now()) {
    this.now = now;
  }

  isHeld(action: BindingAction) { return this.held.has(action); }

  press(action: BindingAction) {
    const pending = this.releaseTimers.get(action);
    if (pending) { clearTimeout(pending); this.releaseTimers.delete(action); }
    if (this.held.has(action)) return;
    this.held.set(action, this.now());
    this.sink.setActionHeld(action, true);
  }

  release(action: BindingAction) {
    const since = this.held.get(action);
    if (since === undefined || this.releaseTimers.has(action)) return;
    const wait = (MIN_HOLD_MS[action] ?? 0) - (this.now() - since);
    if (wait > 0) {
      this.releaseTimers.set(action, setTimeout(() => {
        this.releaseTimers.delete(action);
        this.releaseNow(action);
      }, wait));
      return;
    }
    this.releaseNow(action);
  }

  private releaseNow(action: BindingAction) {
    if (!this.held.delete(action)) return;
    this.sink.setActionHeld(action, false);
  }

  /** Stick vector in stick radii, screen axes (+x right, +y DOWN). */
  setStick(x: number, y: number) {
    const mag = Math.hypot(x, y);
    const on = mag >= STICK_DEADZONE;
    const nx = on ? x / mag : 0;
    const ny = on ? y / mag : 0;
    const want: Record<(typeof STICK_ACTIONS)[number], boolean> = {
      moveForward: on && -ny > DIRECTION_COS,
      moveBack: on && ny > DIRECTION_COS,
      moveLeft: on && -nx > DIRECTION_COS,
      moveRight: on && nx > DIRECTION_COS,
    };
    for (const action of STICK_ACTIONS) {
      if (want[action]) this.press(action);
      else this.releaseNow(action);
    }
  }

  look(dxPx: number, dyPx: number) {
    if (dxPx || dyPx) this.sink.applyTouchLook(dxPx, dyPx);
  }

  /** Blur, tab hide, leaving the match: every finger is off the glass. */
  releaseAll() {
    for (const timer of this.releaseTimers.values()) clearTimeout(timer);
    this.releaseTimers.clear();
    for (const action of [...this.held.keys()]) this.releaseNow(action);
  }
}
