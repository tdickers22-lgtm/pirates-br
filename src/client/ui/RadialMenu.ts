/**
 * THE SHARED RADIAL (b1.4d; crossdevice-01, vm:creative:2). One selection
 * model for every wheel in the game: the supply wheel today, the crew-call
 * (ping) and emote wheels later. Every device lands on the same slice rule:
 *
 *  - mouse:   the cursor's angle from the hub picks a slice (hover); releasing
 *             the wheel key over it takes it. Digits pick directly.
 *  - touch:   a tap on a slice takes it (anywhere in its wedge, labels and
 *             icons included, not just the painted path).
 *  - gamepad: the right stick's angle picks; the selection STAYS when the stick
 *             springs back to centre (release the bumper to take it), the way a
 *             thumb lets go before the shoulder does.
 *
 * Slices run clockwise from the top, slice 0 centred on 12 o'clock. Inside the
 * hub dead zone nothing is selected. Pure logic, no DOM: scripts/test-radial-menu.mjs.
 */

export interface RadialConfig {
  /** Slice count (>= 2). */
  readonly slices: number;
  /** Hub dead zone as a fraction of the wheel radius (pointer / touch). */
  readonly deadzone: number;
  /** Stick magnitude below which the stick selects nothing new (0..1). */
  readonly stickDeadzone: number;
  /** Beyond this many radii a pointer is off the wheel (a tap there selects nothing). */
  readonly outerLimit: number;
}

export const DEFAULT_RADIAL: RadialConfig = {
  slices: 10,
  // The supply wheel's hub circle is r 26 of a 200-unit viewBox (0.13 of the
  // box width = 0.26 of the wheel radius 100).
  deadzone: 0.26,
  stickDeadzone: 0.5,
  outerLimit: 1.15,
};

/** Clockwise angle from straight up, in [0, 2pi). dy is screen-down positive. */
export function radialAngle(dx: number, dy: number): number {
  let a = Math.atan2(dx, -dy);
  if (a < 0) a += Math.PI * 2;
  return a;
}

/** The slice an angle falls in (slice 0 centred at the top). */
export function sliceAtAngle(angle: number, slices: number): number {
  const step = (Math.PI * 2) / slices;
  const i = Math.round(angle / step) % slices;
  return i < 0 ? i + slices : i;
}

/** Pointer or touch offset from the hub, in px, against the wheel radius in px. */
export function sliceAtOffset(dx: number, dy: number, radiusPx: number, cfg: RadialConfig = DEFAULT_RADIAL): number | null {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !(radiusPx > 0)) return null;
  const r = Math.hypot(dx, dy) / radiusPx;
  if (r < cfg.deadzone) return null;
  return sliceAtAngle(radialAngle(dx, dy), cfg.slices);
}

/** A tap: like the pointer, but a tap well outside the wheel selects nothing. */
export function sliceAtTap(dx: number, dy: number, radiusPx: number, cfg: RadialConfig = DEFAULT_RADIAL): number | null {
  if (!(radiusPx > 0) || Math.hypot(dx, dy) / radiusPx > cfg.outerLimit) return null;
  return sliceAtOffset(dx, dy, radiusPx, cfg);
}

/** Gamepad stick (x right, y DOWN as the Gamepad API reports it), magnitude 0..1. */
export function sliceAtStick(x: number, y: number, cfg: RadialConfig = DEFAULT_RADIAL): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (Math.hypot(x, y) < cfg.stickDeadzone) return null;
  return sliceAtAngle(radialAngle(x, y), cfg.slices);
}

/** Digit1..Digit9 = slices 0..8, Digit0 = slice 9 (and Numpad the same). */
export function sliceForDigit(code: string, slices: number): number | null {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (!m) return null;
  const n = Number(m[1]);
  const slot = n === 0 ? 9 : n - 1;
  return slot < slices ? slot : null;
}

/**
 * The hover/selection state of one open wheel. Every source writes into the
 * same `hover`; `take()` hands back what the wheel should do on close.
 */
export class RadialMenu {
  hover: number | null = null;
  constructor(readonly cfg: RadialConfig = DEFAULT_RADIAL) {}

  /** Mouse moved: the hover follows the cursor, the hub clears it. */
  pointer(dx: number, dy: number, radiusPx: number): number | null {
    this.hover = sliceAtOffset(dx, dy, radiusPx, this.cfg);
    return this.hover;
  }

  /** Right stick: a deflection selects, centre keeps the last selection. */
  stick(x: number, y: number): number | null {
    const s = sliceAtStick(x, y, this.cfg);
    if (s !== null) this.hover = s;
    return this.hover;
  }

  /** A finger tap: the tapped slice, immediately (null on the hub or off the wheel). */
  tap(dx: number, dy: number, radiusPx: number): number | null {
    const s = sliceAtTap(dx, dy, radiusPx, this.cfg);
    this.hover = null;
    return s;
  }

  /** A digit key: the slice it names, immediately. */
  digit(code: string): number | null {
    return sliceForDigit(code, this.cfg.slices);
  }

  /** The wheel closed: whatever is hovered is taken, and the hover clears. */
  take(): number | null {
    const s = this.hover;
    this.hover = null;
    return s;
  }

  reset() { this.hover = null; }
}
