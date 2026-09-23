import type { CannonAmmoType, PlayerInput, WeaponSlot } from '../../shared/types/index.js';
import { WHEEL_SLOTS } from '../../shared/wheel.js';
import { sliceForDigit } from '../ui/RadialMenu.js';
import { BINDINGS, BINDING_ACTIONS, type BindingAction, mouseButtonsFor, tokensFor } from '../../shared/bindings.js';
import { InputSchemeTracker, initialScheme } from './InputScheme.js';
import { resolveInputAuthority } from './inputAuthority.js';
import { LookDeltaFilter, requestLockSafe } from './pointerLock.js';
import { TouchControls, touchCapable } from './TouchControls.js';

/** Finger drag-to-look gain (b1.4b): rad per CSS px before sensitivity and fovScale. */
export const TOUCH_LOOK_RAD_PER_PX = 0.0055;

/** The pages [Q] cycles while the supply wheel is held open. */
export type WheelPage = 'items' | 'maps' | 'shop';
const WHEEL_PAGE_ORDER: readonly WheelPage[] = ['items', 'maps', 'shop'];

/** KeyboardEvent.code -> the live (non-reserved) actions it triggers, from the
 *  one bindings table (b1.4a). Reserved rows (ping, emote, scoreboard) claim
 *  their keys but nothing reads them until their slice lands. */
const ACTIONS_BY_CODE: ReadonlyMap<string, readonly BindingAction[]> = (() => {
  const map = new Map<string, BindingAction[]>();
  for (const action of BINDING_ACTIONS) {
    if (BINDINGS[action].reserved) continue;
    for (const token of tokensFor(action, 'mouse')) {
      if (token.startsWith('Mouse')) continue;
      if (!map.has(token)) map.set(token, []);
      map.get(token)!.push(action);
    }
  }
  return map;
})();
const FIRE_BUTTONS = mouseButtonsFor('fire');
const SLOT_ACTIONS: ReadonlyArray<readonly [BindingAction, WeaponSlot]> = [
  ['weapon1', 0], ['weapon2', 1], ['weapon3', 2], ['weapon4', 3],
];
const AMMO_ACTIONS: ReadonlyArray<readonly [BindingAction, CannonAmmoType]> = [
  ['ammoRound', 'cannonball'], ['ammoFire', 'firebomb'], ['ammoChain', 'chainshot'],
];

function isTypingTarget(): boolean {
  const active = document.activeElement as HTMLElement | null;
  return !!active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || !!active.isContentEditable);
}

export class InputManager {
  private keys: Set<string> = new Set();
  private yaw = 0;
  private pitch = 0;
  private mouseButtons: Set<number> = new Set();
  /** Actions held by a virtual source (touch buttons, gamepad): b1.4b/e call
   *  setActionHeld. Read through the same held() as keys and mouse buttons. */
  private virtualHeld: Set<BindingAction> = new Set();
  private seq = 0;
  private locked = false;
  private wantsRelock = false;
  private lockElement: HTMLElement | null = null;
  private readonly lookFilter = new LookDeltaFilter();
  /** The active scheme (last device used). Drives input authority and the lock pill. */
  readonly scheme = new InputSchemeTracker(initialScheme());
  /** On-screen stick, look pad and buttons (b1.4b); mounted on touch-capable devices. */
  private touch: TouchControls | null = null;

  // One-shot flags (cleared each frame)
  private interactPressed = false;
  private tradePressed = false;
  private reloadPressed = false;
  private placeKegPressed = false;
  private dropChestPressed = false;
  private specialAttackPressed = false;
  private kegHeld = false;
  private kegPreviewUntil = 0;
  private jumpPressed = false;
  private slotPressed: WeaponSlot | null = null;
  private cannonAmmoPressed: CannonAmmoType | null = null;
  /** Hold [I] to open supply wheel; click slices or press 1-4 to use pocket items. */
  private vHeld = false;
  private pendingWheelSlot: number | null = null;
  /** Second wheel page ([Q] while the wheel is held): quest maps (SoT radial). */
  private wheelPage: WheelPage = 'items';
  /** ECON-01 send half: the shop line a digit/click picked on the shop page. */
  private pendingShopLineIndex: number | null = null;
  private pendingSelectMapIndex: number | null = null;

  init(lockElement: HTMLElement = document.body) {
    this.lockElement = lockElement;
    this.scheme.attach(typeof document !== 'undefined' ? document : undefined);
    document.addEventListener('keydown', (e) => {
      // Never hijack keys while the player is typing in a text field (e.g. the
      // pirate-name input) — otherwise Space/arrows are preventDefault-ed and
      // gameplay actions fire from letters typed into the menu.
      if (isTypingTarget()) return;
      if (e.code.startsWith('Arrow')) e.preventDefault();
      this.keys.add(e.code);
      // OS keyboard auto-repeat fires keydown repeatedly while a key is held.
      // Edge-triggered actions (interact, jump, trade, reload, slot, etc.) must only fire on the
      // initial press — otherwise holding [X] near the anchor wheel cycles drop/raise forever.
      if (e.repeat) return;
      const actions = ACTIONS_BY_CODE.get(e.code) ?? [];
      if (this.vHeld) {
        // THE WHEEL IS A MODAL LAYER, not a set of per-key exceptions. It used
        // to re-route only [Q] and Digit1-4 and leave every other binding live,
        // so [F] (the trim key the legend advertises next to Q) still braced the
        // yard from inside the overlay, and [X] fired an interact under it
        // (hud-27). Nothing below this block reads a key while [I] is down.
        if (actions.includes('wheelPage')) {
          e.preventDefault();
          this.actionDown('wheelPage');
          return;
        }
        const slot = sliceForDigit(e.code, WHEEL_SLOTS.length);
        if (slot !== null) {
          e.preventDefault();
          this.pickWheelSlot(slot);
        }
        return;
      }
      for (const action of actions) {
        // Space would scroll the page, G is a browser find-as-you-type key.
        if (action === 'jump' || action === 'keg') e.preventDefault();
        this.actionDown(action);
      }
    });
    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      // Same typing guard as keydown: without it, releasing 'i' while typing a
      // pirate name in the menu fired requestPointerLock mid-text-entry.
      if (isTypingTarget()) return;
      for (const action of ACTIONS_BY_CODE.get(e.code) ?? []) {
        if (action === 'keg' && this.kegHeld) e.preventDefault();
        this.actionUp(action);
      }
    });

    lockElement.addEventListener('mousedown', (e) => {
      if (this.vHeld) return;
      // A tap on a phone synthesises a compatibility mousedown: touch input is
      // driven by TouchControls through setActionHeld, never by these events,
      // and a touch session never asks for pointer lock.
      if (this.scheme.current !== 'mouse') return;
      // Place a held keg even on the click that re-acquires pointer lock, so a
      // click-to-place right after Esc / closing the supply wheel isn't swallowed.
      if (this.kegHeld && FIRE_BUTTONS.includes(e.button)) {
        e.preventDefault();
        this.actionUp('keg');
        if (!this.locked && !this.debugAssumeLocked) requestLockSafe(this.lockElement);
        return;
      }
      if (!this.locked && !this.debugAssumeLocked) {
        // The first click after Esc only re-acquires the lock; it never fires.
        this.wantsRelock = true;
        requestLockSafe(this.lockElement);
        e.preventDefault();
        return;
      }
      this.mouseButtons.add(e.button);
    });

    document.addEventListener('mouseup', (e) => {
      this.mouseButtons.delete(e.button);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const delta = this.lookFilter.filter(e.movementX, e.movementY);
      if (delta) this.applyLookDelta(delta.dx, delta.dy);
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.lockElement;
      if (!this.locked) {
        this.mouseButtons.clear();
        this.releaseAllKeys();
      } else {
        // Browsers deliver a spurious warp on the first event after lock.
        this.lookFilter.onLockAcquired();
        if (this.wantsRelock) this.wantsRelock = false;
      }
    });

    if (touchCapable()) {
      this.touch = new TouchControls(this, this.scheme);
      this.touch.onMinimapTap = () => this.onMinimapTap?.();
      this.touch.mount();
    }

    window.addEventListener('blur', () => this.releaseAllKeys());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.releaseAllKeys();
    });
  }

  /** Virtual sources (touch buttons, gamepad) press and release actions here.
   *  Press edges run the same handlers as the keyboard; while the supply wheel
   *  is open only the wheel's own actions get through (the modal layer). */
  setActionHeld(action: BindingAction, held: boolean) {
    const was = this.virtualHeld.has(action);
    if (held === was) return;
    if (held) {
      this.virtualHeld.add(action);
      if (!this.vHeld || action === 'supplyWheel' || action === 'wheelPage') this.actionDown(action);
    } else {
      this.virtualHeld.delete(action);
      this.actionUp(action);
    }
  }

  /** Is the action held on any source (keyboard, mouse button, virtual)? */
  private held(action: BindingAction): boolean {
    if (this.virtualHeld.has(action)) return true;
    for (const token of tokensFor(action, 'mouse')) {
      if (token.startsWith('Mouse')) {
        const button = Number(token.slice(5));
        if (Number.isInteger(button) && this.mouseButtons.has(button)) return true;
      } else if (this.keys.has(token)) {
        return true;
      }
    }
    return false;
  }

  private pickWheelSlot(slot: number) {
    // Slot 9 ('0') is the axe: ten slices, and until now nine digits.
    if (this.wheelPage === 'maps') this.pendingSelectMapIndex = slot;
    else if (this.wheelPage === 'shop') this.pendingShopLineIndex = slot;
    else this.pendingWheelSlot = slot;
  }

  /** Press edge of an action, from any source. */
  private actionDown(action: BindingAction) {
    switch (action) {
      case 'supplyWheel':
        if (!this.vHeld && this.locked) document.exitPointerLock?.();
        this.vHeld = true;
        this.wheelPage = 'items';
        return;
      case 'wheelPage':
        // items -> maps -> the Tallyman's table -> items. The shop page is the
        // SEND half of shop_buy (ECON-01): before it existed the server routed,
        // validated and answered a message no client could ever produce.
        if (!this.vHeld) return;
        this.wheelPage = WHEEL_PAGE_ORDER[
          (WHEEL_PAGE_ORDER.indexOf(this.wheelPage) + 1) % WHEEL_PAGE_ORDER.length
        ];
        return;
      case 'interact': this.interactPressed = true; return;
      case 'jump': this.jumpPressed = true; return;
      // T LEFT THE DEFAULT LAYER (hud-15, PLAN row 95). Trade returns as a
      // CONTEXTUAL rail prompt with CREW-01; until then the wire field stays
      // false. T is now reserved for the emote wheel in the bindings table.
      case 'spyglass': this.spyglassHeld = true; return;
      case 'legend': this.legendPressed = true; return;
      case 'reload': this.reloadPressed = true; return;
      case 'dropChest': this.dropChestPressed = true; return;
      case 'special': this.specialAttackPressed = true; return;
      case 'keg':
        if (this.kegHeld) return;
        this.kegHeld = true;
        this.kegPreviewUntil = Date.now() + 900;
        return;
      default: break;
    }
    for (const [slotAction, slot] of SLOT_ACTIONS) if (action === slotAction) this.slotPressed = slot;
    for (const [ammoAction, ammo] of AMMO_ACTIONS) if (action === ammoAction) this.cannonAmmoPressed = ammo;
  }

  /** Release edge of an action, from any source. */
  private actionUp(action: BindingAction) {
    if (action === 'spyglass') this.spyglassHeld = false;
    if (action === 'supplyWheel' && this.vHeld) {
      this.vHeld = false;
      if (this.scheme.current === 'mouse') requestLockSafe(this.lockElement);
    }
    if (action === 'keg' && this.kegHeld) {
      this.kegHeld = false;
      this.placeKegPressed = true;
      this.kegPreviewUntil = Date.now() + 450;
    }
  }

  buildInput(): PlayerInput {
    const aiming = this.isAimHeld();
    const wheelUse = this.pendingWheelSlot;
    this.pendingWheelSlot = null;

    const input: PlayerInput = {
      seq: this.seq++,
      ts: Date.now(),
      // At the helm the same bits are sails out/in and the rudder (the server
      // reads them by station), so the helm rows OR in for virtual sources.
      forward:  this.held('moveForward') || this.held('sailsOut'),
      back:     this.held('moveBack') || this.held('sailsIn'),
      left:     this.held('moveLeft') || this.held('steerLeft'),
      right:    this.held('moveRight') || this.held('steerRight'),
      jump:     this.held('jump'),
      jumpPressed: this.jumpPressed,
      crouch:   this.held('crouch'),
      fire:     this.isFiring(),
      // Set by Game.ts when a use-tool is held (routes LMB to the tool's verb).
      useItem:  false,
      aim:      aiming,
      interact: !this.vHeld && this.interactPressed,
      interactHeld: !this.vHeld && this.held('interact'),
      anchor:   false,
      // Canvas AMOUNT is hauled by holding [X] at the rigging / W-S at the helm.
      // Sail ANGLE (yard brace / trim) is Q/F while steering — the HUD names these
      // keys ("Trim Left [Q]" / "Trim Right [F]") and the server applies them.
      sailRaise: false,
      sailLower: false,
      // [Q] is the maps-page toggle while the wheel is held — don't trim sails.
      sailLeft:  !this.vHeld && this.held('trimLeft'),
      sailRight: !this.vHeld && this.held('trimRight'),
      trade:    !this.vHeld && this.tradePressed,
      reload:   !this.vHeld && this.reloadPressed,
      placeKeg: !this.vHeld && this.placeKegPressed,
      dropChest: !this.vHeld && this.dropChestPressed,
      specialAttack: !this.vHeld && this.specialAttackPressed,
      slot:     this.vHeld ? null : this.slotPressed,
      cannonAmmo: this.vHeld ? null : this.cannonAmmoPressed,
      yaw:      this.yaw,
      pitch:    this.pitch,
      wheelIndex: wheelUse,
      useWheelItem: wheelUse !== null,
      barrelTakeAll: false,
      interactIntent: null,
    };

    // Clear one-shots
    this.interactPressed = false;
    this.tradePressed = false;
    this.reloadPressed = false;
    this.placeKegPressed = false;
    this.dropChestPressed = false;
    this.specialAttackPressed = false;
    this.jumpPressed = false;
    this.slotPressed = null;
    this.cannonAmmoPressed = null;

    return input;
  }

  getYaw()   { return this.yaw; }
  getPitch() { return this.pitch; }
  /** Headless-QA hook: patrols can't acquire pointer lock, so ?forceinput
   *  treats the pointer as locked for aim/fire gating. */
  private readonly debugAssumeLocked = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('forceinput');
  /** crossdevice-02: touch and gamepad act without pointer lock; the mouse
   *  scheme still needs it (see inputAuthority.ts). */
  private get hasAuthority() {
    return resolveInputAuthority({
      pointerLocked: this.locked, scheme: this.scheme.current, debugAssumeLocked: this.debugAssumeLocked,
    });
  }

  isAiming() { return this.isAimHeld(); }
  isFiring() { return !this.vHeld && this.hasAuthority && this.held('fire'); }
  isLocked() { return this.locked; }
  isKegPreviewActive() { return this.kegHeld || Date.now() < this.kegPreviewUntil; }
  isInteractHeld() { return this.held('interact'); }
  /** True while [I] is held — supply wheel overlay */
  isSupplyWheelOpen() { return this.vHeld; }

  /** Close the wheel from outside a key (a finger picked a wedge). Releases the
   *  Satchel toggle through its own source so the next tap opens it again. */
  closeSupplyWheel() {
    if (this.touch?.source.isHeld('supplyWheel')) this.touch.source.release('supplyWheel');
    else if (this.virtualHeld.has('supplyWheel')) this.setActionHeld('supplyWheel', false);
  }

  /** Game sets this: a tap on the minimap opens the chart (touch). */
  onMinimapTap: (() => void) | null = null;
  /** Which wheel page is showing while [I] is held ([Q] toggles). */
  getWheelPage(): WheelPage { return this.wheelPage; }

  /** One-shot: the Tallyman shelf index a digit picked on the shop page. */
  consumeShopLineIndex(): number | null {
    const index = this.pendingShopLineIndex;
    this.pendingShopLineIndex = null;
    return index;
  }
  /** One-shot: quest-map index picked on the maps page (Digit1..3). */
  consumeSelectMapIndex(): number | null {
    const index = this.pendingSelectMapIndex;
    this.pendingSelectMapIndex = null;
    return index;
  }
  queueWheelSlot(slot: number) {
    if (slot >= 0 && slot <= 9) this.pendingWheelSlot = slot;
  }
  /** THE BROWSER NEVER DELIVERS THE KEYUP FOR A KEY RELEASED WHILE UNFOCUSED.
   *  Cmd-Tab at the helm with [W] held and 'forward' kept riding every packet:
   *  the sloop sailed itself into the storm while the player read Discord
   *  (hud-03). Blur, tab-hide and losing pointer lock all mean "her hands are
   *  off the keyboard" — drop every held key and one-shot, and flag a forced
   *  send so the zeroed input reaches the server on the very next tick. */
  private releaseAllKeys() {
    this.touch?.reset();
    this.keys.clear();
    this.mouseButtons.clear();
    this.virtualHeld.clear();
    this.vHeld = false;
    this.kegHeld = false;
    this.spyglassHeld = false;
    this.interactPressed = false;
    this.tradePressed = false;
    this.reloadPressed = false;
    this.placeKegPressed = false;
    this.dropChestPressed = false;
    this.specialAttackPressed = false;
    this.jumpPressed = false;
    this.slotPressed = null;
    this.cannonAmmoPressed = null;
    this.pendingWheelSlot = null;
    this.releasedAllKeys = true;
  }

  /** One-shot: set by releaseAllKeys so Game forces the zeroed packet out. */
  private releasedAllKeys = false;

  hasPendingActions() {
    if (this.releasedAllKeys) {
      this.releasedAllKeys = false;
      return true;
    }
    return this.interactPressed
      || this.tradePressed
      || this.reloadPressed
      || this.placeKegPressed
      || this.dropChestPressed
      || this.specialAttackPressed
      || this.jumpPressed
      || this.slotPressed !== null
      || this.cannonAmmoPressed !== null
      || this.pendingWheelSlot !== null;
  }
  /** While the supply wheel is open, which slice has its digit held — for the
   *  first-person preview. Reads the shared table, so the axe ('0') counts. */
  getSupplyWheelHeldSlot(): number | null {
    if (!this.vHeld) return null;
    for (const slot of WHEEL_SLOTS) if (this.keys.has(slot.digitCode)) return slot.index;
    return null;
  }
  getMoveAxes() {
    return {
      x: (this.held('moveRight') ? 1 : 0) - (this.held('moveLeft') ? 1 : 0),
      z: (this.held('moveForward') ? 1 : 0) - (this.held('moveBack') ? 1 : 0),
    };
  }

  getSwimVerticalIntent() {
    return (this.held('jump') ? 1 : 0) - (this.held('swimDown') ? 1 : 0);
  }

  /** Spyglass raise key (P) — read by Game each frame; hold-to-use. */
  private spyglassHeld = false;
  isSpyglassHeld() { return this.spyglassHeld; }

  /** Controls-legend toggle key (L) — press edge, consumed by Game. */
  private legendPressed = false;
  consumeLegendPressed() {
    const pressed = this.legendPressed;
    this.legendPressed = false;
    return pressed;
  }

  /** Aim sensitivity scales with FOV so scoped optics (sniper 14°, spyglass 6°)
   *  turn proportionally slower instead of 5-12x too fast. Game sets this each
   *  frame to currentFov / baseFov. */
  private fovScale = 1;
  setFovScale(scale: number) {
    if (!Number.isFinite(scale)) return;
    this.fovScale = Math.max(0.05, Math.min(1, scale));
  }

  /** 1.0 is the historical default; clamped to a sane range to avoid flick-aim accidents. */
  private sensitivity = 1.0;
  setSensitivity(scale: number) {
    if (!Number.isFinite(scale)) return;
    this.sensitivity = Math.max(0.2, Math.min(2.5, scale));
  }
  getSensitivity() { return this.sensitivity; }

  private applyLookDelta(dx: number, dy: number) {
    const k = 0.002 * this.sensitivity * this.fovScale;
    this.yaw -= dx * k;
    this.pitch -= dy * k;
    this.pitch = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, this.pitch));
  }

  /** Finger drag on the look pad (TouchControls): same yaw/pitch as the mouse,
   *  0.0055 rad/px x sensitivity x fovScale (a phone swipe is ~5x fewer px). */
  applyTouchLook(dxPx: number, dyPx: number) {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) return;
    const k = TOUCH_LOOK_RAD_PER_PX * this.sensitivity * this.fovScale;
    this.yaw -= dxPx * k;
    this.pitch -= dyPx * k;
    this.pitch = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, this.pitch));
  }

  /** Touch overlay, for probes and the HUD layout (null off touch devices). */
  getTouchControls() { return this.touch; }

  /** Headless-automation hook: pointer lock never engages under Playwright,
   *  so screenshot tours drive the camera through this instead of mouse deltas. */
  setLook(yaw: number, pitch: number) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this.yaw = yaw;
    this.pitch = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, pitch));
  }

  private isAimHeld() {
    return this.hasAuthority && this.held('aim');
  }
}
