/**
 * CONTROLS SETTINGS + REBINDING, the model half (b1.4g; crossdevice-13, crossdevice-14).
 *
 * Before this file the one look setting had three different ranges: the menu
 * slider went 0.20-2.00, the menu's storage clamped 0.2-2.0 and InputManager
 * clamped 0.2-2.5. CONTROL_RANGES is now the ONE clamp table: ControlsSettings
 * builds its sliders from it, loadControlSettings() clamps storage with it and
 * InputManager.applyControlSettings() clamps with it (test-input-bindings greps
 * that no other clamp for these values exists).
 *
 * Rebinding works on whole tables: rebind() returns a new table plus what it
 * swapped, and refuses anything validateBindings() would reject. Only the
 * difference from DEFAULT_BINDINGS is persisted, so a later default change
 * still reaches players who never touched that row.
 */
import {
  BINDING_ACTIONS, CONTEXT_OVERLAPS, DEFAULT_BINDINGS, PAD_BUTTON_INDEX,
  isNotApplicable, validateBindings,
  type BindingAction, type BindingRow, type BindingTable,
} from '../../shared/bindings.js';

// ── Settings ──────────────────────────────────────────────────────────────────

/** The one clamp table. min/max/step are what the sliders show; def is the default. */
export const CONTROL_RANGES = {
  /** Mouse / trackpad look, x the historical 0.002 rad/px. */
  mouseSens: { min: 0.2, max: 3.0, step: 0.05, def: 1.0, label: 'Mouse sensitivity' },
  /** Look multiplier while aiming down sights / guarding (all schemes). */
  adsMult: { min: 0.3, max: 1.5, step: 0.05, def: 1.0, label: 'Aim (ADS) multiplier' },
  /** Finger drag-to-look, x TOUCH_LOOK_RAD_PER_PX. */
  touchLook: { min: 0.3, max: 3.0, step: 0.05, def: 1.0, label: 'Touch look' },
  /** Right stick look, x the GamepadSource degree rates. */
  stickLook: { min: 0.3, max: 3.0, step: 0.05, def: 1.0, label: 'Stick look' },
  /** On-screen button scale. */
  touchButtonSize: { min: 0.8, max: 1.4, step: 0.05, def: 1.0, label: 'Touch button size' },
} as const;
export type RangedSetting = keyof typeof CONTROL_RANGES;

export function clampSetting(key: RangedSetting, value: unknown): number {
  const r = CONTROL_RANGES[key];
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return r.def;
  return Math.max(r.min, Math.min(r.max, n));
}

export type TouchButtonsMode = 'auto' | 'on' | 'off';
export type SchemeFlags = { mouse: boolean; gamepad: boolean; touch: boolean };

export type ControlSettings = {
  mouseSens: number;
  adsMult: number;
  touchLook: number;
  stickLook: number;
  touchButtonSize: number;
  /** Invert Y, per scheme (sailing and flight players split on this). */
  invertY: SchemeFlags;
  /** D13 aim assist (touch and gamepad only), on by default. */
  aimAssist: boolean;
  /** Pad rumble / phone vibration. */
  vibration: boolean;
  /** Pointer lock with unadjustedMovement (Chromium): OS acceleration off. */
  rawMouse: boolean;
  /** Mirror the touch overlay: stick right, look and buttons left. */
  leftHanded: boolean;
  /** auto = on the touch scheme; on = always in a match; off = never. */
  touchButtons: TouchButtonsMode;
};

export const DEFAULT_CONTROL_SETTINGS: Readonly<ControlSettings> = Object.freeze({
  mouseSens: CONTROL_RANGES.mouseSens.def,
  adsMult: CONTROL_RANGES.adsMult.def,
  touchLook: CONTROL_RANGES.touchLook.def,
  stickLook: CONTROL_RANGES.stickLook.def,
  touchButtonSize: CONTROL_RANGES.touchButtonSize.def,
  invertY: Object.freeze({ mouse: false, gamepad: false, touch: false }),
  aimAssist: true,
  vibration: true,
  rawMouse: false,
  leftHanded: false,
  touchButtons: 'auto',
}) as Readonly<ControlSettings>;

export const CONTROLS_STORAGE_KEY = 'piratesBR.controls';
export const BINDINGS_STORAGE_KEY = 'piratesBR.bindings';
/** Pre-b1.4g homes of two of these values, read once as a migration. */
const LEGACY_SETTINGS_KEY = 'piratesBR.settings';
const LEGACY_HAPTICS_KEY = 'piratesBR.haptics';

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem?(k: string): void };
function defaultStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Any JSON-ish value -> a complete, clamped ControlSettings. */
export function sanitizeControlSettings(raw: unknown): ControlSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const inv = (o.invertY && typeof o.invertY === 'object' ? o.invertY : {}) as Record<string, unknown>;
  const d = DEFAULT_CONTROL_SETTINGS;
  const mode = o.touchButtons;
  return {
    mouseSens: clampSetting('mouseSens', o.mouseSens ?? d.mouseSens),
    adsMult: clampSetting('adsMult', o.adsMult ?? d.adsMult),
    touchLook: clampSetting('touchLook', o.touchLook ?? d.touchLook),
    stickLook: clampSetting('stickLook', o.stickLook ?? d.stickLook),
    touchButtonSize: clampSetting('touchButtonSize', o.touchButtonSize ?? d.touchButtonSize),
    invertY: {
      mouse: bool(inv.mouse, d.invertY.mouse),
      gamepad: bool(inv.gamepad, d.invertY.gamepad),
      touch: bool(inv.touch, d.invertY.touch),
    },
    aimAssist: bool(o.aimAssist, d.aimAssist),
    vibration: bool(o.vibration, d.vibration),
    rawMouse: bool(o.rawMouse, d.rawMouse),
    leftHanded: bool(o.leftHanded, d.leftHanded),
    touchButtons: mode === 'on' || mode === 'off' || mode === 'auto' ? mode : d.touchButtons,
  };
}

export function loadControlSettings(storage: StorageLike | null = defaultStorage()): ControlSettings {
  if (!storage) return sanitizeControlSettings({});
  try {
    const raw = storage.getItem(CONTROLS_STORAGE_KEY);
    if (raw) return sanitizeControlSettings(JSON.parse(raw));
    // First run on b1.4g: carry the old mouse slider and the vibration toggle over.
    const legacy: Record<string, unknown> = {};
    const old = storage.getItem(LEGACY_SETTINGS_KEY);
    if (old) {
      const parsed = JSON.parse(old) as { sensitivity?: unknown };
      if (typeof parsed.sensitivity === 'number') legacy.mouseSens = parsed.sensitivity;
    }
    if (storage.getItem(LEGACY_HAPTICS_KEY) === 'off') legacy.vibration = false;
    return sanitizeControlSettings(legacy);
  } catch {
    return sanitizeControlSettings({});
  }
}

export function saveControlSettings(settings: ControlSettings, storage: StorageLike | null = defaultStorage()): void {
  try { storage?.setItem(CONTROLS_STORAGE_KEY, JSON.stringify(sanitizeControlSettings(settings))); } catch { /* private mode */ }
}

// ── Rebinding ─────────────────────────────────────────────────────────────────

export type RebindScheme = 'keyboard' | 'gamepad';
/** Only the rows a player changed, per scheme. */
export type BindingOverrides = Partial<Record<BindingAction, Partial<Record<RebindScheme, string[]>>>>;

/** Fixed on purpose: Escape is the browser's own pointer-lock exit, the wheel
 *  pick is the digit ring, and sticks / mouse movement are axes, not buttons. */
const FIXED_ACTIONS: ReadonlySet<BindingAction> = new Set<BindingAction>(['pause', 'wheelPick', 'look', 'bugReport']);

/** Can the player rebind this action on this scheme? (n/a rows, axes and FIXED_ACTIONS cannot.) */
export function isRebindable(action: BindingAction, scheme: RebindScheme, table: BindingTable = DEFAULT_BINDINGS): boolean {
  if (FIXED_ACTIONS.has(action)) return false;
  const b = table[action][scheme];
  if (isNotApplicable(b)) return false;
  return !b.some((t) => t === 'Mouse:move' || /^Pad:[LR]S(\.(up|down|left|right))?$/.test(t));
}

/** Is this token something the scheme can press? */
export function isValidToken(scheme: RebindScheme, token: string): boolean {
  if (scheme === 'keyboard') {
    if (token === 'Escape' || token === 'Mouse:move') return false;
    return /^Mouse[0-2]$/.test(token) || /^[A-Za-z][A-Za-z0-9]*$/.test(token);
  }
  const m = /^Pad:([A-Za-z]+)(\.(click|hold))?$/.exec(token);
  if (!m || !(m[1] in PAD_BUTTON_INDEX)) return false;
  if (m[1] === 'Menu' || m[1] === 'Home') return false; // pause and the OS own these
  if (m[3] === 'click' && m[1] !== 'LS' && m[1] !== 'RS') return false;
  if ((m[1] === 'LS' || m[1] === 'RS') && m[3] !== 'click') return false;
  return true;
}

function overlap(a: BindingRow, b: BindingRow): boolean {
  return a.contexts.some((ca) => b.contexts.some((cb) => CONTEXT_OVERLAPS[ca].includes(cb)));
}

export type RebindResult =
  | { ok: true; table: BindingTable; swapped: { action: BindingAction; from: string; to: string | null }[] }
  | { ok: false; reason: string };

/**
 * Put `token` in slot `slot` (0 = primary) of `action` on `scheme`. Any other
 * action live in an overlapping context that already answers to `token` gets
 * the token this slot held before (a SWAP, so nothing is left unbound); when
 * the slot was empty it simply loses that token (and is refused if that would
 * leave it with no binding). The result must pass validateBindings().
 */
export function rebind(table: BindingTable, action: BindingAction, scheme: RebindScheme, token: string, slot = 0): RebindResult {
  if (!isRebindable(action, scheme, table)) return { ok: false, reason: `${table[action].label} cannot be rebound on ${scheme}` };
  if (!isValidToken(scheme, token)) return { ok: false, reason: `${token} cannot be bound` };
  const mine = table[action][scheme] as readonly string[];
  const i = Math.max(0, Math.min(slot, mine.length));
  const old = mine[i] ?? null;
  if (old === token) return { ok: true, table, swapped: [] };
  const next: Record<BindingAction, BindingRow> = { ...table };
  const mineNext = [...mine];
  mineNext[i] = token;
  next[action] = { ...table[action], [scheme]: mineNext.filter((t, j) => t !== token || j === i) };
  const swapped: { action: BindingAction; from: string; to: string | null }[] = [];
  for (const other of BINDING_ACTIONS) {
    if (other === action) continue;
    const b = next[other][scheme];
    if (isNotApplicable(b) || !b.includes(token) || !overlap(next[action], next[other])) continue;
    const replaced = b.map((t) => (t === token ? old : t)).filter((t): t is string => !!t);
    const deduped = replaced.filter((t, j, a) => a.indexOf(t) === j);
    if (deduped.length === 0) return { ok: false, reason: `${token} is ${next[other].label}'s only ${scheme} binding` };
    next[other] = { ...next[other], [scheme]: deduped };
    swapped.push({ action: other, from: token, to: old });
  }
  const problems = validateBindings(next);
  if (problems.length) return { ok: false, reason: problems[0] };
  return { ok: true, table: next, swapped };
}

/** The difference from the defaults (what gets persisted). */
export function diffBindings(table: BindingTable): BindingOverrides {
  const out: BindingOverrides = {};
  for (const action of BINDING_ACTIONS) {
    for (const scheme of ['keyboard', 'gamepad'] as const) {
      const a = table[action][scheme];
      const d = DEFAULT_BINDINGS[action][scheme];
      if (isNotApplicable(a) || isNotApplicable(d)) continue;
      if (a.length === d.length && a.every((t, j) => t === d[j])) continue;
      (out[action] ??= {})[scheme] = [...a];
    }
  }
  return out;
}

/** Defaults + overrides; a stored table that no longer validates (a default
 *  moved under it) falls back to the defaults rather than a broken layout. */
export function applyOverrides(overrides: unknown): BindingTable {
  const next: Record<BindingAction, BindingRow> = { ...DEFAULT_BINDINGS };
  if (!overrides || typeof overrides !== 'object') return next;
  for (const [action, per] of Object.entries(overrides as Record<string, unknown>)) {
    if (!(action in DEFAULT_BINDINGS) || !per || typeof per !== 'object') continue;
    const a = action as BindingAction;
    for (const scheme of ['keyboard', 'gamepad'] as const) {
      const tokens = (per as Record<string, unknown>)[scheme];
      if (!Array.isArray(tokens) || tokens.length === 0 || !isRebindable(a, scheme)) continue;
      if (!tokens.every((t) => typeof t === 'string' && isValidToken(scheme, t))) continue;
      next[a] = { ...next[a], [scheme]: [...tokens] as string[] };
    }
  }
  return validateBindings(next).length ? { ...DEFAULT_BINDINGS } : next;
}

export function resetBindings(): BindingTable {
  return { ...DEFAULT_BINDINGS };
}

export function loadBindingTable(storage: StorageLike | null = defaultStorage()): BindingTable {
  try {
    const raw = storage?.getItem(BINDINGS_STORAGE_KEY);
    return applyOverrides(raw ? JSON.parse(raw) : null);
  } catch {
    return resetBindings();
  }
}

export function saveBindingTable(table: BindingTable, storage: StorageLike | null = defaultStorage()): void {
  const diff = diffBindings(table);
  try {
    if (Object.keys(diff).length === 0) storage?.removeItem?.(BINDINGS_STORAGE_KEY);
    else storage?.setItem(BINDINGS_STORAGE_KEY, JSON.stringify(diff));
  } catch { /* private mode */ }
}

/** A pressed gamepad button index -> its 'Pad:<name>' token (sticks as clicks). */
export function padTokenForIndex(index: number): string | null {
  for (const [name, i] of Object.entries(PAD_BUTTON_INDEX)) {
    if (i !== index) continue;
    return name === 'LS' || name === 'RS' ? `Pad:${name}.click` : `Pad:${name}`;
  }
  return null;
}
