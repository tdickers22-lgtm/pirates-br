/**
 * THE GAMEPAD (b1.4e; crossdevice-05, vm:liveplay:1).
 *
 * Xbox, PlayStation and Switch Pro pads through the browser Gamepad API, W3C
 * Standard mapping ONLY (gp.mapping === 'standard'): a pad the browser cannot
 * map is ignored rather than guessed at, because a guessed layout puts Fire on
 * the wrong trigger.
 *
 * Polled once per animation frame by InputManager. Like the touch overlay it
 * never writes PlayerInput: it presses and releases the SAME BindingAction rows
 * the keyboard does, read from src/shared/bindings.ts for the context the
 * player is in (foot / helm / cannon / swim / the supply wheel), so the helm's
 * LS left/right is steerLeft/steerRight and the cannon's D-pad picks ammo with
 * no pad-specific game code. Look is the one analogue path: the right stick is
 * a RATE (rad/s), not a distance, so it has its own sink method.
 *
 *   sticks: radial deadzone 0.12, outer deadzone 0.95 (worn sticks never reach
 *           1.0 on the diagonal), look curve exponent 2, 220 deg/s yaw and
 *           150 deg/s pitch at sensitivity 1 (x sensitivity x fovScale).
 *   '.hold' tokens: a button with a tap row AND a hold row in one context (Y =
 *           reload / hold Y = drop chest) sends the tap on a release under
 *           HOLD_MS and the hold row once it has been down HOLD_MS.
 *
 * Pure logic, no DOM: scripts/test-gamepad-curves.mjs drives it with a fake
 * pad; scripts/test-gamepad.mjs runs it in a real match on a stubbed
 * navigator.getGamepads.
 */
import {
  BINDINGS, BINDING_ACTIONS, CONTEXT_OVERLAPS, PAD_BUTTON_INDEX,
  type BindingAction, type BindingContext, type PadButton, tokensFor,
} from '../../shared/bindings.js';

export const PAD_DEADZONE = 0.12;
export const PAD_OUTER = 0.95;
export const LOOK_EXPONENT = 2;
export const LOOK_YAW_DEG_PER_S = 220;
export const LOOK_PITCH_DEG_PER_S = 150;
/** Long press for '.hold' tokens (Y = drop chest, View = scoreboard). */
export const HOLD_MS = 400;
/** A stick direction bit turns on within ~67.5 deg of it (same eight clean
 *  directions as the touch stick). */
const DIRECTION_COS = 0.383;
/** Triggers are analogue on most pads; half pull counts as pressed. */
const TRIGGER_PRESS = 0.5;

/** Radial deadzone with an outer deadzone, rescaled so output runs 0..1 over
 *  the live band and keeps the stick's direction (no square "gates"). */
export function radialDeadzone(x: number, y: number, inner = PAD_DEADZONE, outer = PAD_OUTER): { x: number; y: number; mag: number } {
  const m = Math.hypot(x, y);
  if (!(m > inner)) return { x: 0, y: 0, mag: 0 };
  const scaled = Math.min(1, (m - inner) / (outer - inner));
  return { x: (x / m) * scaled, y: (y / m) * scaled, mag: scaled };
}

/** Look response: magnitude^2 along the stick's direction (fine aim near the
 *  centre, full speed at the rim). */
export function lookCurve(x: number, y: number): { x: number; y: number } {
  const d = radialDeadzone(x, y);
  if (d.mag === 0) return { x: 0, y: 0 };
  const k = Math.pow(d.mag, LOOK_EXPONENT) / d.mag;
  return { x: d.x * k, y: d.y * k };
}

/** Yaw/pitch change for one frame, rad (before the sink's sign convention:
 *  +x = stick right, +y = stick DOWN as the Gamepad API reports). */
export function lookStep(x: number, y: number, dtSec: number, sensitivity = 1, fovScale = 1): { dx: number; dy: number } {
  const c = lookCurve(x, y);
  const deg = Math.PI / 180;
  return {
    dx: c.x * LOOK_YAW_DEG_PER_S * deg * sensitivity * fovScale * dtSec,
    dy: c.y * LOOK_PITCH_DEG_PER_S * deg * sensitivity * fovScale * dtSec,
  };
}

/** The pad context: a play context, the supply wheel, or a menu (MenuNav). */
export type PadContext = Exclude<BindingContext, 'global'> | 'menu';

export interface PadLike {
  readonly mapping: string;
  readonly connected?: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { pressed: boolean; value: number }[];
}

export interface GamepadSink {
  setActionHeld(action: BindingAction, held: boolean): void;
  /** Right stick look, radians this frame (+dx = turn right, +dy = look down). */
  applyPadLook(dxRad: number, dyRad: number): void;
  /** The pad was used (scheme switch to 'gamepad'). */
  notePad(): void;
}

type ButtonRoute = { tap: BindingAction[]; hold: BindingAction[] };
type StickDir = 'up' | 'down' | 'left' | 'right';

/** Button -> actions and LS direction -> actions for one context, straight
 *  from the bindings table (live rows only: reserved rows wait for their slice). */
export function padRoutes(context: Exclude<BindingContext, 'global'>) {
  const buttons = new Map<PadButton, ButtonRoute>();
  const stick = new Map<StickDir, BindingAction[]>();
  let lookOnRS = false;
  for (const action of BINDING_ACTIONS) {
    const row = BINDINGS[action];
    if (row.reserved) continue;
    if (!row.contexts.some((c) => CONTEXT_OVERLAPS[context].includes(c))) continue;
    for (const token of tokensFor(action, 'gamepad')) {
      const m = /^Pad:([A-Za-z]+)(?:\.(up|down|left|right|hold|click))?$/.exec(token);
      if (!m) continue;
      const [, name, suffix] = m;
      if ((name === 'LS' || name === 'RS') && (suffix === undefined || ['up', 'down', 'left', 'right'].includes(suffix))) {
        if (name === 'LS' && suffix) {
          if (!stick.has(suffix as StickDir)) stick.set(suffix as StickDir, []);
          stick.get(suffix as StickDir)!.push(action);
        }
        if (name === 'RS' && !suffix && action === 'look') lookOnRS = true;
        continue;
      }
      // 'LS.click'/'RS.click' are the stick buttons LS/RS; '.hold' is a long press.
      const button = name as PadButton;
      if (!(button in PAD_BUTTON_INDEX)) continue;
      if (!buttons.has(button)) buttons.set(button, { tap: [], hold: [] });
      buttons.get(button)![suffix === 'hold' ? 'hold' : 'tap'].push(action);
    }
  }
  return { buttons, stick, lookOnRS };
}

const ROUTES = new Map<string, ReturnType<typeof padRoutes>>();
function routesFor(context: Exclude<BindingContext, 'global'>) {
  let r = ROUTES.get(context);
  if (!r) { r = padRoutes(context); ROUTES.set(context, r); }
  return r;
}

export class GamepadSource {
  /** Actions this source is holding on the sink. */
  private readonly held = new Set<BindingAction>();
  private readonly downAt = new Map<PadButton, number>();
  private readonly holdFired = new Set<PadButton>();
  private prev: boolean[] = [];
  private context: PadContext = 'menu';
  /** Right stick, deadzoned (for the supply wheel and MenuNav). */
  rightStick = { x: 0, y: 0 };
  /** Left stick, deadzoned (MenuNav flicks). */
  leftStick = { x: 0, y: 0 };
  /** Seconds of right-stick look integrated so far (the pad's own frame
   *  clock; probes compare yaw turned against it). */
  lookClock = 0;
  /** Press edges this poll, by button name (MenuNav reads A/B/D-pad here). */
  readonly edges = new Set<PadButton>();

  constructor(private readonly sink: GamepadSink, private readonly now: () => number = () => Date.now()) {}

  /** The first connected Standard-mapped pad, or null. */
  static pick(pads: ArrayLike<PadLike | null> | null | undefined): PadLike | null {
    if (!pads) return null;
    for (let i = 0; i < pads.length; i += 1) {
      const p = pads[i];
      if (p && p.connected !== false && p.mapping === 'standard') return p;
    }
    return null;
  }

  isHeld(action: BindingAction) { return this.held.has(action); }
  getContext(): PadContext { return this.context; }

  /** Switch context: everything this source holds is released first, so a
   *  stick held forward on foot does not become sails-out at the helm. */
  setContext(context: PadContext) {
    if (context === this.context) return;
    // The wheel is opened FROM a play context by holding LB: keep LB's hold
    // across that switch or the wheel closes the frame it opens.
    const keep = (context === 'wheel' || this.context === 'wheel') ? 'supplyWheel' : null;
    for (const a of [...this.held]) if (a !== keep) this.release(a);
    this.context = context;
  }

  private press(action: BindingAction) {
    if (this.held.has(action)) return;
    this.held.add(action);
    this.sink.setActionHeld(action, true);
  }

  private release(action: BindingAction) {
    if (!this.held.delete(action)) return;
    this.sink.setActionHeld(action, false);
  }

  private tap(action: BindingAction) {
    this.sink.setActionHeld(action, true);
    this.sink.setActionHeld(action, false);
  }

  /** One frame. `pad` null = unplugged: release everything. */
  poll(pad: PadLike | null, dtSec: number, look: { sensitivity: number; fovScale: number } = { sensitivity: 1, fovScale: 1 }) {
    this.edges.clear();
    if (!pad) { this.releaseAll(); this.prev = []; return; }
    const t = this.now();
    const down: boolean[] = [];
    for (let i = 0; i < pad.buttons.length; i += 1) {
      const b = pad.buttons[i];
      down[i] = !!b && (b.pressed || (i === 6 || i === 7 ? b.value >= TRIGGER_PRESS : false));
    }
    const ls = radialDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    const rs = radialDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    this.leftStick = { x: ls.x, y: ls.y };
    this.rightStick = { x: rs.x, y: rs.y };
    let used = ls.mag > 0 || rs.mag > 0;
    for (const [name, index] of Object.entries(PAD_BUTTON_INDEX) as [PadButton, number][]) {
      if (down[index] && !this.prev[index]) { this.edges.add(name); used = true; }
    }
    if (used) this.sink.notePad();

    if (this.context !== 'menu') {
      const routes = routesFor(this.context);
      // Buttons.
      for (const [name, index] of Object.entries(PAD_BUTTON_INDEX) as [PadButton, number][]) {
        const route = routes.buttons.get(name);
        const isDown = !!down[index];
        const wasDown = !!this.prev[index];
        if (!route) {
          if (!isDown) this.downAt.delete(name);
          continue;
        }
        const split = route.hold.length > 0;
        if (isDown && !wasDown) {
          this.downAt.set(name, t);
          this.holdFired.delete(name);
          if (!split) for (const a of route.tap) this.press(a);
        } else if (isDown && split && !this.holdFired.has(name) && t - (this.downAt.get(name) ?? t) >= HOLD_MS) {
          this.holdFired.add(name);
          for (const a of route.hold) this.press(a);
        } else if (!isDown && wasDown) {
          if (split) {
            if (!this.holdFired.has(name)) for (const a of route.tap) this.tap(a);
            for (const a of route.hold) this.release(a);
          } else {
            for (const a of route.tap) this.release(a);
          }
          this.downAt.delete(name);
          this.holdFired.delete(name);
        }
      }
      // The wheel layer has no LB row of its own (supplyWheel lives in the play
      // contexts): letting go of LB is what closes the wheel and takes the pick.
      if (this.context === 'wheel' && !down[PAD_BUTTON_INDEX.LB] && this.prev[PAD_BUTTON_INDEX.LB]) this.release('supplyWheel');
      // Left stick as direction rows (move on foot/swim, sails + rudder at the helm).
      const want = new Set<BindingAction>();
      if (ls.mag > 0) {
        const nx = ls.x / ls.mag;
        const ny = ls.y / ls.mag;
        const on: Record<StickDir, boolean> = { up: -ny > DIRECTION_COS, down: ny > DIRECTION_COS, left: -nx > DIRECTION_COS, right: nx > DIRECTION_COS };
        for (const [dir, actions] of routes.stick) if (on[dir]) for (const a of actions) want.add(a);
      }
      for (const actions of routes.stick.values()) for (const a of actions) {
        if (want.has(a)) this.press(a); else this.release(a);
      }
      // Right stick look (not while the wheel reads it).
      if (routes.lookOnRS && this.context !== 'wheel') {
        const step = lookStep(pad.axes[2] ?? 0, pad.axes[3] ?? 0, dtSec, look.sensitivity, look.fovScale);
        if (step.dx || step.dy) { this.lookClock += dtSec; this.sink.applyPadLook(step.dx, step.dy); }
      }
    }
    this.prev = down;
  }

  releaseAll() {
    for (const a of [...this.held]) this.release(a);
    this.downAt.clear();
    this.holdFired.clear();
  }
}
