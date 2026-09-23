/**
 * WHAT THE PLAYER PRESSES, IN THE WORDS OF THE DEVICE IN THEIR HANDS (b1.4f;
 * mechanicshud-05, crossdevice-08, crossdevice-18, vm:mechanicshud:3).
 *
 * Every prompt, card, legend line, How to Play row and objective used to type a
 * keyboard key ("[X] Take Helm", "hold W", "LMB · Fire"). A phone player has no
 * X and a pad player has no W. Copy now names an ACTION and asks this module
 * how to draw it on the active scheme:
 *
 *   glyph('interact')         mouse '[X]'   gamepad '(X)'   touch '‹X›' (the chip's face)
 *   holdGlyph('interact')     '[Hold X]'    '(Hold X)'      '‹Hold X›'
 *   keys('sailsOut')          'W'           'LS ↑'          'Sails up'
 *
 * The table is src/shared/bindings.ts; the touch faces are TOUCH_BUTTONS; letter
 * keys follow the physical layout via navigator.keyboard.getLayoutMap() where the
 * browser has it (Chromium), so an AZERTY player reads [A] for the trim key
 * that sits where QWERTY's Q is. The active scheme is <html data-input-scheme>,
 * set by InputScheme on the last device used, so copy built each frame follows a
 * device switch with no plumbing; static copy in index.html carries data-glyph*
 * attributes and is re-rendered by installGlyphs() on every scheme change.
 *
 * This file and bindings.ts are the only places allowed to spell a key
 * (scripts/test-no-hardcoded-keys.mjs).
 */
import { BINDINGS, isNotApplicable, type BindingAction, type InputSchemeId } from '../../shared/bindings.js';
import { ECONOMY } from '../../shared/constants/index.js';
import { WHEEL_KEY_HINT } from '../../shared/wheel.js';
import { TOUCH_BUTTONS } from '../input/touchContexts.js';

// ── Keyboard layout ─────────────────────────────────────────────────────────
let layout: ReadonlyMap<string, string> | null = null;

/** Use a KeyboardLayoutMap-like map (code -> produced character); null = QWERTY names. */
export function setKeyboardLayout(map: ReadonlyMap<string, string> | null): void {
  layout = map;
}

/** Ask the browser for the physical layout once (Chromium only; Safari/Firefox keep QWERTY names). */
export async function initKeyboardLayout(): Promise<boolean> {
  try {
    const kb = (globalThis.navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<ReadonlyMap<string, string>> } } | undefined)?.keyboard;
    if (!kb?.getLayoutMap) return false;
    setKeyboardLayout(await kb.getLayoutMap());
    return true;
  } catch {
    return false;
  }
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  Space: 'SPACE', ShiftLeft: 'SHIFT', ShiftRight: 'SHIFT', ControlLeft: 'CTRL', ControlRight: 'CTRL',
  AltLeft: 'ALT', AltRight: 'ALT', Tab: 'TAB', Escape: 'Esc', Enter: 'Enter', Backspace: 'Backspace',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  // A trackpad has no "LMB": a click is a click, a right click is two fingers.
  Mouse0: 'Click', Mouse1: 'Middle-click', Mouse2: 'Right-click', 'Mouse:move': 'Mouse',
};

const PAD_NAMES: Readonly<Record<string, string>> = {
  'LS.click': 'L3', 'RS.click': 'R3', DUp: 'D-pad ↑', DDown: 'D-pad ↓', DLeft: 'D-pad ←', DRight: 'D-pad →',
  'LS.up': 'LS ↑', 'LS.down': 'LS ↓', 'LS.left': 'LS ←', 'LS.right': 'LS →',
  'RS.up': 'RS ↑', 'RS.down': 'RS ↓', 'RS.left': 'RS ←', 'RS.right': 'RS →',
};

const TOUCH_NAMES: Readonly<Record<string, string>> = {
  'stick.up': 'Stick ↑', 'stick.down': 'Stick ↓', 'stick.left': 'Stick ←', 'stick.right': 'Stick →',
  'look-pad': 'Drag', 'helm-slider.left': 'Slider ◀', 'helm-slider.right': 'Slider ▶',
  minimap: 'Minimap', pause: 'Pause', 'wheel-slice': 'Tap a slice', 'wheel-page': 'Page',
  'weapon-1': 'Chip 1', 'weapon-2': 'Chip 2', 'weapon-3': 'Chip 3', 'weapon-4': 'Chip 4',
  aim: 'Aim', ping: 'Ping', emote: 'Emote', scoreboard: 'Crews',
};

/** The printed name of one binding token on its scheme ('KeyX' -> 'X', 'Pad:RT' -> 'RT', 'fire' -> 'Fire'). */
export function keyLabel(token: string): string {
  if (token.startsWith('Pad:')) {
    const t = token.slice(4);
    if (t.endsWith('.hold')) return `Hold ${keyLabel(`Pad:${t.slice(0, -5)}`)}`;
    return PAD_NAMES[t] ?? t;
  }
  if (NAMED_KEYS[token]) return NAMED_KEYS[token];
  if (/^Key[A-Z]$/.test(token)) {
    const ch = layout?.get(token);
    return ch && ch.trim() ? ch.toUpperCase() : token.slice(3);
  }
  if (/^Digit\d$/.test(token)) return token.slice(5);
  if (/^Numpad\d$/.test(token)) return `Num ${token.slice(6)}`;
  if (/^F\d{1,2}$/.test(token)) return token;
  const button = TOUCH_BUTTONS.find((b) => b.id === token);
  if (button) return button.label;
  return TOUCH_NAMES[token] ?? token;
}

/** Where an n/a row sends the player instead (bindings.ts states the reason). */
const NA_ROUTE: Partial<Record<InputSchemeId, Partial<Record<BindingAction, BindingAction>>>> = {
  mouse: { weaponNext: 'weapon1', weaponPrev: 'weapon1' },
  gamepad: { legend: 'pause', bugReport: 'pause', spyglass: 'supplyWheel', weapon1: 'weaponNext', weapon2: 'weaponNext', weapon3: 'weaponNext', weapon4: 'weaponNext' },
  touch: { legend: 'pause', bugReport: 'pause', weaponNext: 'weapon1', weaponPrev: 'weapon1' },
};

function tokens(action: BindingAction, scheme: InputSchemeId): readonly string[] {
  const row = BINDINGS[action];
  const b = scheme === 'mouse' ? row.keyboard : scheme === 'gamepad' ? row.gamepad : row.touch;
  if (!isNotApplicable(b)) return b;
  const via = NA_ROUTE[scheme]?.[action];
  return via ? tokens(via, scheme) : [];
}

/** The scheme the player is using now (<html data-input-scheme>, mouse before any input). */
export function currentScheme(): InputSchemeId {
  const s = (globalThis.document?.documentElement?.dataset?.inputScheme ?? 'mouse') as InputSchemeId;
  return s === 'gamepad' || s === 'touch' ? s : 'mouse';
}

/**
 * The bare name of the control(s) for an action: 'X', 'SHIFT/Right-click',
 * 'RT', 'Fire'. On mouse+keyboard a key and a mouse button bound together are
 * both named (the key is the trackpad's way in, D2); otherwise the first token.
 */
export function keys(action: BindingAction, scheme: InputSchemeId = currentScheme()): string {
  const t = tokens(action, scheme);
  if (t.length === 0) return BINDINGS[action].label;
  if (scheme === 'mouse' && t.some((x) => x.startsWith('Mouse')) && t.some((x) => !x.startsWith('Mouse'))) {
    const keysFirst = [...t.filter((x) => !x.startsWith('Mouse')), ...t.filter((x) => x.startsWith('Mouse'))];
    return [...new Set(keysFirst.map(keyLabel))].join('/');
  }
  return keyLabel(t[0]);
}

function wrap(inner: string, scheme: InputSchemeId): string {
  return scheme === 'mouse' ? `[${inner}]` : scheme === 'gamepad' ? `(${inner})` : `‹${inner}›`;
}

/** '[X]' keyboard, '(X)' pad, '‹X›' touch (the on-screen button's face). */
export function glyph(action: BindingAction, scheme: InputSchemeId = currentScheme()): string {
  return wrap(keys(action, scheme), scheme);
}

/** '[Hold X]' / '(Hold X)' / '‹Hold X›' for hold verbs. */
export function holdGlyph(action: BindingAction, scheme: InputSchemeId = currentScheme()): string {
  return wrap(`Hold ${keys(action, scheme)}`, scheme);
}

/** Several actions in one glyph: '[5/6/7]', '(D-pad ←/D-pad →/Y)', '‹Round/Fire bomb/Chain›'. */
export function glyphSet(actions: readonly BindingAction[], scheme: InputSchemeId = currentScheme()): string {
  return wrap([...new Set(actions.map((a) => keys(a, scheme)))].join('/'), scheme);
}

/** "[A] or [D]" / "(LS ←) or (LS →)" / "‹Slider ◀› or ‹Slider ▶›". */
export function glyphEither(a: BindingAction, b: BindingAction, scheme: InputSchemeId = currentScheme()): string {
  return `${glyph(a, scheme)} or ${glyph(b, scheme)}`;
}

/** The win line, from the rule itself (crossdevice-18: the copy said 9,000 while the rule was 8000). */
export function winGoldText(): string {
  return `${ECONOMY.GOLD_WIN_TARGET.toLocaleString('en-US')} gold`;
}
export function winCopy(): string {
  return `Bank ${winGoldText()}`;
}

/**
 * The controls card, generated from the table for a scheme. Plain text lines
 * (the renderer escapes them). On mouse+keyboard the wording keeps the shape the
 * legend audit reads ('X · Interact', 'Hold I · ', 'Q/F', '1–4', '5/6/7').
 */
export function legendLines(scheme: InputSchemeId = currentScheme()): string[] {
  const kb = scheme === 'mouse';
  const L = (a: BindingAction) => (kb ? keys(a, scheme) : glyph(a, scheme));
  const K = (a: BindingAction) => keys(a, scheme);
  const pair = (a: BindingAction, b: BindingAction) => (kb ? `${K(a)}/${K(b)}` : glyphSet([a, b], scheme));
  const move = kb
    ? `${K('moveForward')}${K('moveLeft')}${K('moveBack')}${K('moveRight')} (or the arrow keys)`
    : scheme === 'gamepad' ? '(LS)' : '‹Stick› (left thumb)';
  const lines: string[] = [];
  lines.push(`${move} · Move${kb ? '' : ` | ${scheme === 'gamepad' ? '(RS)' : '‹Drag› the right side'} · Look`} | ${L('jump')} · Jump / Swim up | ${L('swimDown')} · Swim down | ${L('crouch')} · Crouch`);
  lines.push(`${L('interact')} · Interact — walk up and look at a thing, one prompt shows | ${L('dropChest')} · Drop a carried chest`);
  lines.push(`Look for the gold station tags aboard: ⚓ Capstan at the bow · Hold ${L('interact')} raises the anchor`);
  lines.push(`⛵ Rope stations at the mast rails · Hold ${L('interact')} drops / raises the sails (crewmates on the rope haul faster)`);
  lines.push(`Helm: ${pair('steerLeft', 'steerRight')} · Steer · ${pair('sailsOut', 'sailsIn')} · Sails out / in · ${pair('trimLeft', 'trimRight')} · Angle the sails · Hold ${L('sailsOut')} · Weigh anchor | Crow's nest · ladder up the mainmast`);
  const weapons = kb ? `${K('weapon1')}–${K('weapon4')}` : scheme === 'gamepad' ? glyphSet(['weaponNext', 'weaponPrev'], scheme) : 'Tap a weapon chip';
  const ammo = kb ? `${K('ammoRound')}/${K('ammoFire')}/${K('ammoChain')}` : glyphSet(['ammoRound', 'ammoFire', 'ammoChain'], scheme);
  lines.push(`${weapons} · Weapons | ${L('reload')} · Reload | ${L('special')} · Special attack | ${ammo} · Cannon Ammo | ${L('keg')} · Hold for powder keg, release to place`);
  const pick = kb ? `${WHEEL_KEY_HINT} to take one` : scheme === 'gamepad' ? `${glyph('wheelPick', scheme)} to take one` : 'tap a slice to take one';
  const page = scheme === 'touch' ? '' : ` · ${L('wheelPage')} flips to your charts`;
  lines.push(`${scheme === 'touch' ? L('supplyWheel') : `Hold ${L('supplyWheel')}`} · Supply wheel & tools (${pick}${page})`);
  lines.push(`${L('fire')} · Fire | ${kb ? keys('aim', scheme).replace('/', ' or ') : L('aim')} · Aim — with a cutlass drawn it raises your guard instead`);
  const tail = [`${L('spyglass')} · Spyglass`, `${L('map')} · Map (${scheme === 'touch' ? 'Close' : L('pause')} closes it)`, `${L('legend')} · This card`];
  if (kb) tail.push(`${K('bugReport')} · Bug report`);
  lines.push(tail.join(' | '));
  return lines;
}

// ── Static copy in index.html ───────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Fill every glyph slot under root for the current scheme:
 *   data-glyph="interact"        -> '[X]'
 *   data-glyph-hold="supplyWheel" -> '[Hold I]'
 *   data-glyph-keys="map"         -> 'M'
 *   data-glyph-set="ammoRound,ammoFire,ammoChain" -> '[5/6/7]'
 *   data-win-gold                 -> '8,000 gold'
 *   data-legend                   -> the generated controls card
 */
export function renderGlyphs(root: ParentNode = document, scheme: InputSchemeId = currentScheme()): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-glyph]')) el.textContent = glyph(el.dataset.glyph as BindingAction, scheme);
  for (const el of root.querySelectorAll<HTMLElement>('[data-glyph-hold]')) el.textContent = holdGlyph(el.dataset.glyphHold as BindingAction, scheme);
  for (const el of root.querySelectorAll<HTMLElement>('[data-glyph-keys]')) el.textContent = keys(el.dataset.glyphKeys as BindingAction, scheme);
  for (const el of root.querySelectorAll<HTMLElement>('[data-glyph-set]')) el.textContent = glyphSet((el.dataset.glyphSet ?? '').split(',') as BindingAction[], scheme);
  for (const el of root.querySelectorAll<HTMLElement>('[data-win-gold]')) el.textContent = winGoldText();
  for (const el of root.querySelectorAll<HTMLElement>('[data-legend]')) {
    el.innerHTML = legendLines(scheme).map((l) => esc(l).replace(/ \| /g, ' &nbsp;|&nbsp; ')).join('<br>');
  }
}

let installed = false;
/** Render now, after the layout map resolves, and on every scheme change. Idempotent. */
export function installGlyphs(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  renderGlyphs();
  void initKeyboardLayout().then((ok) => { if (ok) renderGlyphs(); });
  if (typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => renderGlyphs()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-input-scheme'] });
  }
}
