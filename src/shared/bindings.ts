/**
 * EVERY CONTROL IN THE GAME, IN ONE TABLE (b1.4a; crossdevice-14, mechanicshud-05).
 *
 * Before this file the bindings were `e.code === 'KeyX'` literals spread over
 * InputManager, Game and ModalStack, and every prompt and card named a keyboard
 * key. Touch, gamepad, rebinding and glyphs (D2, D12) all need the same answer
 * to "what does the player press for X", so there is exactly one:
 *
 *   action -> { keyboard/mouse tokens, Standard Gamepad tokens, touch button id, contexts }
 *
 * Consumers: InputManager (reads the keyboard/mouse tokens instead of literals),
 * Game (map / pause / bug report), and later GamepadSource (b1.4e), TouchControls
 * (b1.4b/c), InputGlyphs (b1.4f) and rebinding (b1.4g). Client-only truth: no
 * server module imports this (PlayerInput on the wire is unchanged). It lives in
 * shared/ beside wheel.ts because it is the game's control vocabulary.
 *
 * Token grammar
 *  - keyboard: a KeyboardEvent.code ('KeyX', 'Space', 'ShiftLeft', 'F8'), or
 *    'Mouse0' (left) / 'Mouse1' (middle) / 'Mouse2' (right) / 'Mouse:move'.
 *  - gamepad: 'Pad:<button>' on the W3C Standard Gamepad layout (names below);
 *    sticks are 'Pad:LS.up' etc.; a '.hold' suffix is the long-press of that
 *    button (a different token from the tap, so tap/hold pairs never conflict).
 *  - touch: an on-screen control id ('fire', 'stick.up', 'helm-slider.left').
 *  - a binding that deliberately has no control on a scheme carries
 *    { na: '<reason>' } so the gap is a decision, never an oversight.
 */
import { WHEEL_SLOTS } from './wheel.js';

/** Standard Gamepad button index for each name (https://w3c.github.io/gamepad/#remapping). */
export const PAD_BUTTON_INDEX = {
  A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, View: 8, Menu: 9,
  LS: 10, RS: 11, DUp: 12, DDown: 13, DLeft: 14, DRight: 15, Home: 16,
} as const;
export type PadButton = keyof typeof PAD_BUTTON_INDEX;

/**
 * Where an action is live. Contexts that can be true at the same time are
 * listed in CONTEXT_OVERLAPS; two actions whose contexts overlap may never share
 * a token. 'global' overlaps everything; 'wheel' is the modal supply wheel
 * (nothing else reads a key while it is held, hud-27).
 */
export type BindingContext = 'global' | 'foot' | 'helm' | 'cannon' | 'swim' | 'wheel';
export const BINDING_CONTEXTS: readonly BindingContext[] = ['global', 'foot', 'helm', 'cannon', 'swim', 'wheel'];
export const CONTEXT_OVERLAPS: Readonly<Record<BindingContext, readonly BindingContext[]>> = {
  global: ['global', 'foot', 'helm', 'cannon', 'swim', 'wheel'],
  foot: ['global', 'foot'],
  helm: ['global', 'helm'],
  cannon: ['global', 'cannon'],
  swim: ['global', 'swim'],
  wheel: ['global', 'wheel'],
};

export type NotApplicable = { readonly na: string };
export type SchemeBinding = readonly string[] | NotApplicable;
export type InputSchemeId = 'mouse' | 'gamepad' | 'touch';

export type BindingRow = {
  readonly label: string;
  readonly contexts: readonly BindingContext[];
  /** 'tap' fires once per press; 'hold' is read while down (hold verbs, sticks). */
  readonly kind: 'tap' | 'hold' | 'axis';
  readonly keyboard: SchemeBinding;
  readonly gamepad: SchemeBinding;
  readonly touch: SchemeBinding;
  /** Reserved for a later slice: the tokens are claimed so nothing else takes them,
   *  but no code reads them yet. Names the slice that makes them live. */
  readonly reserved?: string;
};

const PLAY: readonly BindingContext[] = ['foot', 'helm', 'cannon', 'swim'];
const na = (reason: string): NotApplicable => ({ na: reason });

const DEFAULTS = {
  // ── Moving (on foot and swimming; at the helm the same keys are the rudder and sails) ──
  moveForward: { label: 'Move forward', contexts: ['foot', 'swim'], kind: 'axis', keyboard: ['KeyW', 'ArrowUp'], gamepad: ['Pad:LS.up'], touch: ['stick.up'] },
  moveBack: { label: 'Move back', contexts: ['foot', 'swim'], kind: 'axis', keyboard: ['KeyS', 'ArrowDown'], gamepad: ['Pad:LS.down'], touch: ['stick.down'] },
  moveLeft: { label: 'Move left', contexts: ['foot', 'swim'], kind: 'axis', keyboard: ['KeyA', 'ArrowLeft'], gamepad: ['Pad:LS.left'], touch: ['stick.left'] },
  moveRight: { label: 'Move right', contexts: ['foot', 'swim'], kind: 'axis', keyboard: ['KeyD', 'ArrowRight'], gamepad: ['Pad:LS.right'], touch: ['stick.right'] },
  look: { label: 'Look around', contexts: PLAY, kind: 'axis', keyboard: ['Mouse:move'], gamepad: ['Pad:RS'], touch: ['look-pad'] },
  jump: { label: 'Jump / swim up', contexts: ['foot', 'swim'], kind: 'hold', keyboard: ['Space'], gamepad: ['Pad:A'], touch: ['jump'] },
  crouch: { label: 'Crouch', contexts: ['foot'], kind: 'hold', keyboard: ['KeyC'], gamepad: ['Pad:B'], touch: ['crouch'] },
  swimDown: { label: 'Swim down', contexts: ['swim'], kind: 'hold', keyboard: ['KeyZ'], gamepad: ['Pad:B'], touch: ['swim-down'] },
  // ── Hands ──
  interact: { label: 'Interact (hold for hold verbs)', contexts: PLAY, kind: 'hold', keyboard: ['KeyX'], gamepad: ['Pad:X'], touch: ['interact'] },
  fire: { label: 'Fire', contexts: ['foot', 'cannon'], kind: 'hold', keyboard: ['Mouse0'], gamepad: ['Pad:RT'], touch: ['fire'] },
  // Shift is the trackpad's aim: no action may need button 2 without an alternative (D2).
  aim: { label: 'Aim / guard', contexts: ['foot'], kind: 'hold', keyboard: ['Mouse2', 'ShiftLeft', 'ShiftRight'], gamepad: ['Pad:LT'], touch: ['aim'] },
  reload: { label: 'Reload', contexts: ['foot'], kind: 'tap', keyboard: ['KeyR'], gamepad: ['Pad:Y'], touch: ['reload'] },
  special: { label: 'Special attack', contexts: ['foot'], kind: 'tap', keyboard: ['KeyE'], gamepad: ['Pad:RS.click'], touch: ['special'] },
  keg: { label: 'Powder keg (hold, release to place)', contexts: ['foot'], kind: 'hold', keyboard: ['KeyG'], gamepad: ['Pad:LS.click'], touch: ['keg'] },
  dropChest: { label: 'Drop a carried chest', contexts: ['foot'], kind: 'tap', keyboard: ['KeyB'], gamepad: ['Pad:Y.hold'], touch: ['drop'] },
  spyglass: { label: 'Spyglass (hold)', contexts: ['foot', 'helm'], kind: 'hold', keyboard: ['KeyP'], gamepad: na('equip the spyglass from the supply wheel (LB) and aim with LT'), touch: ['spyglass'] },
  weapon1: { label: 'Weapon 1', contexts: ['foot'], kind: 'tap', keyboard: ['Digit1'], gamepad: na('RB / D-pad cycles weapons (weaponNext/weaponPrev)'), touch: ['weapon-1'] },
  weapon2: { label: 'Weapon 2', contexts: ['foot'], kind: 'tap', keyboard: ['Digit2'], gamepad: na('RB / D-pad cycles weapons (weaponNext/weaponPrev)'), touch: ['weapon-2'] },
  weapon3: { label: 'Weapon 3', contexts: ['foot'], kind: 'tap', keyboard: ['Digit3'], gamepad: na('RB / D-pad cycles weapons (weaponNext/weaponPrev)'), touch: ['weapon-3'] },
  weapon4: { label: 'Weapon 4', contexts: ['foot'], kind: 'tap', keyboard: ['Digit4'], gamepad: na('RB / D-pad cycles weapons (weaponNext/weaponPrev)'), touch: ['weapon-4'] },
  weaponNext: { label: 'Next weapon', contexts: ['foot'], kind: 'tap', keyboard: na('digits 1-4 pick a weapon directly'), gamepad: ['Pad:RB', 'Pad:DRight'], touch: na('the weapon chips pick a weapon directly'), reserved: 'b1.4e' },
  weaponPrev: { label: 'Previous weapon', contexts: ['foot'], kind: 'tap', keyboard: na('digits 1-4 pick a weapon directly'), gamepad: ['Pad:DLeft'], touch: na('the weapon chips pick a weapon directly'), reserved: 'b1.4e' },
  supplyWheel: { label: 'Supply wheel (hold)', contexts: ['foot', 'helm', 'cannon'], kind: 'hold', keyboard: ['KeyI'], gamepad: ['Pad:LB'], touch: ['satchel'] },
  // ── Stations ──
  steerLeft: { label: 'Steer to port', contexts: ['helm'], kind: 'axis', keyboard: ['KeyA', 'ArrowLeft'], gamepad: ['Pad:LS.left'], touch: ['helm-slider.left'] },
  steerRight: { label: 'Steer to starboard', contexts: ['helm'], kind: 'axis', keyboard: ['KeyD', 'ArrowRight'], gamepad: ['Pad:LS.right'], touch: ['helm-slider.right'] },
  sailsOut: { label: 'Sails out', contexts: ['helm'], kind: 'hold', keyboard: ['KeyW', 'ArrowUp'], gamepad: ['Pad:LS.up'], touch: ['sails-up'] },
  sailsIn: { label: 'Sails in', contexts: ['helm'], kind: 'hold', keyboard: ['KeyS', 'ArrowDown'], gamepad: ['Pad:LS.down'], touch: ['sails-down'] },
  trimLeft: { label: 'Angle the sails left', contexts: ['helm'], kind: 'hold', keyboard: ['KeyQ'], gamepad: ['Pad:DLeft'], touch: ['trim-left'] },
  trimRight: { label: 'Angle the sails right', contexts: ['helm'], kind: 'hold', keyboard: ['KeyF'], gamepad: ['Pad:DRight'], touch: ['trim-right'] },
  ammoRound: { label: 'Cannon ammo: round shot', contexts: ['cannon'], kind: 'tap', keyboard: ['Digit5'], gamepad: ['Pad:DLeft'], touch: ['ammo-round'] },
  ammoFire: { label: 'Cannon ammo: firebomb', contexts: ['cannon'], kind: 'tap', keyboard: ['Digit6'], gamepad: ['Pad:DRight'], touch: ['ammo-fire'] },
  ammoChain: { label: 'Cannon ammo: chainshot', contexts: ['cannon'], kind: 'tap', keyboard: ['Digit7'], gamepad: ['Pad:Y'], touch: ['ammo-chain'] },
  // ── Crew (reserved: V/MMB ping, T emote; creative-01/04, vm:creative:1) ──
  ping: { label: 'Crew ping (hold for the call wheel)', contexts: PLAY, kind: 'tap', keyboard: ['KeyV', 'Mouse1'], gamepad: ['Pad:DUp'], touch: ['ping'], reserved: 'b5 crew calls (radial from b1.4d)' },
  emote: { label: 'Emote wheel', contexts: ['foot'], kind: 'hold', keyboard: ['KeyT'], gamepad: ['Pad:DDown'], touch: ['emote'], reserved: 'b5 emotes (radial from b1.4d)' },
  // ── Supply wheel layer (modal) ──
  wheelPick: { label: 'Take from the wheel', contexts: ['wheel'], kind: 'tap', keyboard: [...WHEEL_SLOTS.map((s) => s.digitCode), 'Mouse0'], gamepad: ['Pad:RS', 'Pad:A'], touch: ['wheel-slice'] },
  wheelPage: { label: 'Flip the wheel page', contexts: ['wheel'], kind: 'tap', keyboard: ['KeyQ'], gamepad: ['Pad:RB'], touch: ['wheel-page'] },
  // ── Global ──
  map: { label: 'Map', contexts: ['global'], kind: 'tap', keyboard: ['KeyM'], gamepad: ['Pad:View'], touch: ['minimap'] },
  scoreboard: { label: 'Scoreboard (hold)', contexts: ['global'], kind: 'hold', keyboard: ['Tab'], gamepad: ['Pad:View.hold'], touch: ['scoreboard'], reserved: 'b1.5 / b5 scoreboard' },
  pause: { label: 'Pause / back', contexts: ['global'], kind: 'tap', keyboard: ['Escape'], gamepad: ['Pad:Menu'], touch: ['pause'] },
  legend: { label: 'Controls card', contexts: ['global'], kind: 'tap', keyboard: ['KeyL'], gamepad: na('the pause menu (Menu) shows the controls card'), touch: na('the pause button shows the controls card') },
  bugReport: { label: 'Bug report', contexts: ['global'], kind: 'tap', keyboard: ['F8'], gamepad: na('desktop QA tool; Pause > Report a bug covers pads'), touch: na('desktop QA tool; Pause > Report a bug covers touch') },
} satisfies Record<string, BindingRow>;

export type BindingAction = keyof typeof DEFAULTS;
export const BINDINGS: Readonly<Record<BindingAction, BindingRow>> = DEFAULTS;
export const BINDING_ACTIONS = Object.keys(DEFAULTS) as BindingAction[];

export function isNotApplicable(binding: SchemeBinding): binding is NotApplicable {
  return !Array.isArray(binding);
}

/** The tokens an action answers to on a scheme ([] when n/a). */
export function tokensFor(action: BindingAction, scheme: InputSchemeId, table: Readonly<Record<BindingAction, BindingRow>> = BINDINGS): readonly string[] {
  const row = table[action];
  const binding = scheme === 'mouse' ? row.keyboard : scheme === 'gamepad' ? row.gamepad : row.touch;
  return isNotApplicable(binding) ? [] : binding;
}

/** True when a KeyboardEvent.code / mouse token triggers this action. */
export function isBound(action: BindingAction, token: string, table: Readonly<Record<BindingAction, BindingRow>> = BINDINGS): boolean {
  return tokensFor(action, 'mouse', table).includes(token);
}

/** Mouse button number for 'Mouse<n>' tokens bound to the action. */
export function mouseButtonsFor(action: BindingAction, table: Readonly<Record<BindingAction, BindingRow>> = BINDINGS): number[] {
  return tokensFor(action, 'mouse', table)
    .filter((t) => /^Mouse\d$/.test(t))
    .map((t) => Number(t.slice(5)));
}

/** Every keyboard code the table binds (reserved rows optionally excluded). */
export function keyboardCodes(opts: { includeReserved?: boolean } = {}, table: Readonly<Record<BindingAction, BindingRow>> = BINDINGS): string[] {
  const out = new Set<string>();
  for (const action of Object.keys(table) as BindingAction[]) {
    if (table[action].reserved && !opts.includeReserved) continue;
    for (const t of tokensFor(action, 'mouse', table)) if (!t.startsWith('Mouse')) out.add(t);
  }
  return [...out];
}

function contextsOverlap(a: readonly BindingContext[], b: readonly BindingContext[]): boolean {
  return a.some((ca) => b.some((cb) => CONTEXT_OVERLAPS[ca].includes(cb)));
}

/**
 * The table's own gate: every action has a binding or an explicit n/a reason on
 * every scheme, and no token is shared by two actions whose contexts overlap.
 * Returns human-readable problems ([] = valid). Used by test-input-bindings and
 * by rebinding (b1.4g) to refuse a conflicting override.
 */
export function validateBindings(table: Readonly<Record<string, BindingRow>> = BINDINGS): string[] {
  const problems: string[] = [];
  const actions = Object.keys(table);
  for (const action of actions) {
    const row = table[action];
    if (row.contexts.length === 0) problems.push(`${action}: no context`);
    for (const scheme of ['keyboard', 'gamepad', 'touch'] as const) {
      const b = row[scheme];
      if (isNotApplicable(b)) {
        if (!b.na || b.na.trim().length < 8) problems.push(`${action}.${scheme}: n/a without a reason`);
      } else if (b.length === 0) {
        problems.push(`${action}.${scheme}: empty binding (use { na: reason })`);
      }
    }
  }
  for (let i = 0; i < actions.length; i += 1) {
    for (let j = i + 1; j < actions.length; j += 1) {
      const a = table[actions[i]];
      const b = table[actions[j]];
      if (!contextsOverlap(a.contexts, b.contexts)) continue;
      for (const scheme of ['keyboard', 'gamepad', 'touch'] as const) {
        const ta = a[scheme];
        const tb = b[scheme];
        if (isNotApplicable(ta) || isNotApplicable(tb)) continue;
        const shared = ta.filter((t) => tb.includes(t));
        if (shared.length) problems.push(`${actions[i]} and ${actions[j]} share ${scheme} ${shared.join(', ')} in an overlapping context`);
      }
    }
  }
  return problems;
}
