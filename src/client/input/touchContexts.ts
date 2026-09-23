/**
 * TOUCH CONTEXTS I (b1.4c; crossdevice-01). Which on-screen controls a finger
 * gets, decided by where the pirate is and what is in her hands:
 *
 *  - helm:   a wheel SLIDER (drag right = starboard; springs back to centre by
 *            default, or stays where you leave it with the spring off), Sails up
 *            and Sails down (hold), Trim left/right (hold), Weigh anchor (hold,
 *            only while she is anchored: W at the wheel calls the crew to the
 *            capstan on the server) and Leave (the [X] edge that frees the helm).
 *  - cannon: drag anywhere to aim, Fire, the three ammo chips, Leave.
 *  - swim:   stick + Up / Down.
 *  - tool:   the big button becomes the held tool's verb (Bail, Dig, Raise, Use)
 *            with a fill ring, plus Stow (the aim edge puts a tool away).
 *  - carry:  Drop the chest; no Fire (the server ignores fire with a chest).
 *  - foot:   the b1.4b set (Fire, Aim, Jump, Crouch, Reload, Interact).
 *
 * Pure data and logic, no DOM: scripts/test-touch-controls.mjs drives it.
 * Every button presses a BindingAction from src/shared/bindings.ts, so the wire
 * is the keyboard's wire.
 */
import type { BindingAction } from '../../shared/bindings.js';
import type { EquippableTool } from '../../shared/types/index.js';

export type TouchContext = 'foot' | 'helm' | 'cannon' | 'swim' | 'tool' | 'carry';

export interface TouchContextState {
  atHelm: boolean;
  atCannon: boolean;
  swimming: boolean;
  carrying: boolean;
  equippedTool: EquippableTool | null;
  /** The ship she is steering is at anchor (shows Weigh anchor at the helm). */
  anchored: boolean;
}

/** Stations first (they own the whole screen), then the water, then the hands. */
export function resolveTouchContext(s: TouchContextState): TouchContext {
  if (s.atHelm) return 'helm';
  if (s.atCannon) return 'cannon';
  if (s.swimming) return 'swim';
  if (s.carrying) return 'carry';
  // The spyglass is aimed with Aim, not used with the big button.
  if (s.equippedTool && s.equippedTool !== 'spyglass') return 'tool';
  return 'foot';
}

/** The verb on the big button while a tool is in hand. */
export const TOOL_VERB: Readonly<Record<EquippableTool, string>> = {
  bucket: 'Bail', shovel: 'Dig', lantern: 'Raise', compass: 'Use', axe: 'Chop', spyglass: 'Fire',
};

export interface TouchButtonSpec {
  /** CSS class suffix and data-touch id (the touch token in bindings.ts where one exists). */
  id: string;
  action: BindingAction;
  label: string;
  contexts: readonly TouchContext[];
  /** Carries a --tc-hold progress ring. */
  ring?: boolean;
  /** Only while the ship is anchored (helm). */
  whenAnchored?: boolean;
}

export const TOUCH_BUTTONS: readonly TouchButtonSpec[] = [
  { id: 'fire', action: 'fire', label: 'Fire', contexts: ['foot', 'cannon', 'tool'], ring: true },
  { id: 'aim', action: 'aim', label: 'Aim', contexts: ['foot'] },
  { id: 'stow', action: 'aim', label: 'Stow', contexts: ['tool'] },
  { id: 'jump', action: 'jump', label: 'Jump', contexts: ['foot', 'tool', 'carry'] },
  { id: 'crouch', action: 'crouch', label: 'Crouch', contexts: ['foot', 'tool', 'carry'] },
  { id: 'reload', action: 'reload', label: 'Reload', contexts: ['foot'] },
  { id: 'interact', action: 'interact', label: 'X', contexts: ['foot', 'swim', 'tool', 'carry'], ring: true },
  // Swimming
  { id: 'swim-up', action: 'jump', label: 'Up', contexts: ['swim'] },
  { id: 'swim-down', action: 'swimDown', label: 'Down', contexts: ['swim'] },
  // Carrying
  { id: 'drop', action: 'dropChest', label: 'Drop', contexts: ['carry'] },
  // Helm (the steering slider is its own control, see HelmSlider)
  { id: 'sails-up', action: 'sailsOut', label: 'Sails up', contexts: ['helm'] },
  { id: 'sails-down', action: 'sailsIn', label: 'Sails down', contexts: ['helm'] },
  { id: 'trim-left', action: 'trimLeft', label: 'Trim L', contexts: ['helm'] },
  { id: 'trim-right', action: 'trimRight', label: 'Trim R', contexts: ['helm'] },
  { id: 'anchor', action: 'sailsOut', label: 'Weigh', contexts: ['helm'], whenAnchored: true, ring: true },
  // Cannon
  { id: 'ammo-round', action: 'ammoRound', label: 'Round', contexts: ['cannon'] },
  { id: 'ammo-fire', action: 'ammoFire', label: 'Fire bomb', contexts: ['cannon'] },
  { id: 'ammo-chain', action: 'ammoChain', label: 'Chain', contexts: ['cannon'] },
  // Leave a station: the [X] edge the server reads as "exit current station".
  { id: 'leave', action: 'interact', label: 'Leave', contexts: ['helm', 'cannon'] },
];

/** Buttons visible in a context (helm Weigh only at anchor). */
export function buttonsFor(ctx: TouchContext, anchored = false): TouchButtonSpec[] {
  return TOUCH_BUTTONS.filter((b) => b.contexts.includes(ctx) && (!b.whenAnchored || anchored));
}

/** The label a button shows in a context (the big button speaks the tool). */
export function labelFor(spec: TouchButtonSpec, ctx: TouchContext, tool: EquippableTool | null): string {
  if (spec.id === 'fire' && ctx === 'tool' && tool) return TOOL_VERB[tool];
  return spec.label;
}

/** The move stick belongs to contexts where the pirate walks or swims. At a
 *  station the whole screen is the look/aim pad (drag aims the cannon). */
export function stickEnabled(ctx: TouchContext) {
  return ctx !== 'helm' && ctx !== 'cannon';
}

// ── The helm slider ────────────────────────────────────────────────────────

/** Slider travel (of its half width) before the rudder is put over. */
export const HELM_SLIDER_DEADZONE = 0.22;

/**
 * The wheel slider. The wire has two rudder bits (left/right, the A/D rows),
 * so the slider is a three-state helm: port, amidships, starboard. With the
 * spring ON (default) letting go centres it, like releasing A/D. With the
 * spring OFF it stays where the thumb left it, so a long turn needs no thumb;
 * tapping the centre band brings it back amidships.
 */
export class HelmSlider {
  value = 0;
  constructor(public spring = true) {}

  /** Thumb at `v` in half-widths from the centre (+ = starboard, clamped). */
  set(v: number) { this.value = Math.max(-1, Math.min(1, v)); }

  release() { if (this.spring) this.value = 0; }

  /** The binding rows the slider holds right now. */
  steer(): { steerLeft: boolean; steerRight: boolean } {
    return {
      steerLeft: this.value <= -HELM_SLIDER_DEADZONE,
      steerRight: this.value >= HELM_SLIDER_DEADZONE,
    };
  }
}

export const HELM_SPRING_KEY = 'pbr.touch.helmSpring';

// ── Tools and progress rings ───────────────────────────────────────────────

/**
 * A held tool takes both hands: the attack button drives the tool's own verb
 * (bail, dig, raise the lantern) through useItem and never fires the gun.
 * Device-agnostic (mouse LMB, touch Bail, pad RT); Game.ts applies it to every
 * input it sends.
 */
export function routeHeldTool<T extends { useItem: boolean; fire: boolean; aim: boolean }>(
  input: T, equippedTool: EquippableTool | null, spyglassActive: boolean, firing: boolean,
): T {
  if (spyglassActive || equippedTool) {
    input.useItem = !!equippedTool && !spyglassActive && firing;
    input.fire = false;
    input.aim = false;
  }
  return input;
}

export interface TouchProgressState {
  equippedTool: EquippableTool | null;
  bailScoopProgress: number;
  bucketFilled: boolean;
  hullRepairProgress: number;
  /** Dig progress (0..1) of the buried chest she stands over, if any. */
  digProgress: number | null;
  anchorRaiseProgress: number | null;
}

/** Server progress that the rings show (null = let the button run its own clock). */
export function touchProgress(s: TouchProgressState): { fire: number | null; interact: number | null; anchor: number | null } {
  let fire: number | null = null;
  if (s.equippedTool === 'bucket') {
    // The scoop/heave animation runs 1 -> 0; a full bucket reads as full.
    fire = s.bailScoopProgress > 0 ? 1 - s.bailScoopProgress : s.bucketFilled ? 1 : 0;
  } else if (s.equippedTool === 'shovel' && s.digProgress !== null) {
    fire = s.digProgress;
  }
  const interact = s.hullRepairProgress > 0 ? Math.min(1, s.hullRepairProgress) : null;
  const anchor = s.anchorRaiseProgress !== null ? Math.max(0, Math.min(1, s.anchorRaiseProgress)) : null;
  return { fire, interact, anchor };
}
