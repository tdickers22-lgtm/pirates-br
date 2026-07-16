import type { CannonAmmoType, PlayerInput, WeaponSlot } from '../../shared/types/index.js';

export class InputManager {
  private keys: Set<string> = new Set();
  private yaw = 0;
  private pitch = 0;
  private mouseButtons: Set<number> = new Set();
  private seq = 0;
  private locked = false;
  private wantsRelock = false;
  private lockElement: HTMLElement | null = null;

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

  init(lockElement: HTMLElement = document.body) {
    this.lockElement = lockElement;
    document.addEventListener('keydown', (e) => {
      // Never hijack keys while the player is typing in a text field (e.g. the
      // pirate-name input) — otherwise Space/arrows are preventDefault-ed and
      // gameplay actions fire from letters typed into the menu.
      const active = document.activeElement as HTMLElement | null;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
      }
      if (
        e.code === 'ArrowUp'
        || e.code === 'ArrowDown'
        || e.code === 'ArrowLeft'
        || e.code === 'ArrowRight'
      ) {
        e.preventDefault();
      }
      this.keys.add(e.code);
      // OS keyboard auto-repeat fires keydown repeatedly while a key is held.
      // Edge-triggered actions (interact, jump, trade, reload, slot, etc.) must only fire on the
      // initial press — otherwise holding [X] near the anchor wheel cycles drop/raise forever.
      if (e.repeat) return;
      if (e.code === 'KeyI') {
        if (!this.vHeld && this.locked) document.exitPointerLock?.();
        this.vHeld = true;
      }
      if (this.vHeld && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        this.pendingWheelSlot = Number(e.code.slice(5)) - 1; // Digit1→0 … Digit9→8
      }
      if (e.code === 'KeyX') this.interactPressed = true;
      if (e.code === 'Space') {
        e.preventDefault();
        this.jumpPressed = true;
      }
      if (e.code === 'KeyT') this.tradePressed = true;
      if (e.code === 'KeyP') this.spyglassHeld = true;
      if (e.code === 'KeyL') this.legendPressed = true;
      if (e.code === 'KeyR') this.reloadPressed = true;
      if (e.code === 'KeyB') this.dropChestPressed = true;
      if (e.code === 'KeyE') this.specialAttackPressed = true;
      if (e.code === 'KeyG' && !this.kegHeld) {
        e.preventDefault();
        this.kegHeld = true;
        this.kegPreviewUntil = Date.now() + 900;
      }
      if (!this.vHeld && e.code === 'Digit1') this.slotPressed = 0;
      if (!this.vHeld && e.code === 'Digit2') this.slotPressed = 1;
      if (!this.vHeld && e.code === 'Digit3') this.slotPressed = 2;
      if (!this.vHeld && e.code === 'Digit4') this.slotPressed = 3;
      if (!this.vHeld && e.code === 'Digit5') this.cannonAmmoPressed = 'cannonball';
      if (!this.vHeld && e.code === 'Digit6') this.cannonAmmoPressed = 'firebomb';
      if (!this.vHeld && e.code === 'Digit7') this.cannonAmmoPressed = 'chainshot';
    });
    document.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      // Same typing guard as keydown: without it, releasing 'i' while typing a
      // pirate name in the menu fired requestPointerLock mid-text-entry.
      const activeUp = document.activeElement as HTMLElement | null;
      if (activeUp && (activeUp.tagName === 'INPUT' || activeUp.tagName === 'TEXTAREA' || activeUp.isContentEditable)) {
        return;
      }
      if (e.code === 'KeyP') this.spyglassHeld = false;
      if (e.code === 'KeyI') {
        this.vHeld = false;
        this.lockElement?.requestPointerLock?.().catch(() => {});
      }
      if (e.code === 'KeyG' && this.kegHeld) {
        e.preventDefault();
        this.kegHeld = false;
        this.placeKegPressed = true;
        this.kegPreviewUntil = Date.now() + 450;
      }
    });

    lockElement.addEventListener('mousedown', (e) => {
      if (this.vHeld) return;
      // Place a held keg even on the click that re-acquires pointer lock, so a
      // click-to-place right after Esc / closing the supply wheel isn't swallowed.
      if (this.kegHeld && e.button === 0) {
        e.preventDefault();
        this.kegHeld = false;
        this.placeKegPressed = true;
        this.kegPreviewUntil = Date.now() + 450;
        if (!this.locked && !this.debugAssumeLocked) this.lockElement?.requestPointerLock?.().catch(() => {});
        return;
      }
      if (!this.locked && !this.debugAssumeLocked) {
        this.wantsRelock = true;
        this.lockElement?.requestPointerLock?.().catch(() => {});
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
      this.applyLookDelta(e.movementX, e.movementY);
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.lockElement;
      if (!this.locked) {
        this.mouseButtons.clear();
      } else if (this.wantsRelock) {
        this.wantsRelock = false;
      }
    });

    window.addEventListener('blur', () => {
      this.mouseButtons.clear();
      this.vHeld = false;
      this.kegHeld = false;
    });
  }

  buildInput(): PlayerInput {
    const aiming = this.isAimHeld();
    const wheelUse = this.pendingWheelSlot;
    this.pendingWheelSlot = null;

    const input: PlayerInput = {
      seq: this.seq++,
      ts: Date.now(),
      forward:  this.keys.has('KeyW') || this.keys.has('ArrowUp'),
      back:     this.keys.has('KeyS') || this.keys.has('ArrowDown'),
      left:     this.keys.has('KeyA') || this.keys.has('ArrowLeft'),
      right:    this.keys.has('KeyD') || this.keys.has('ArrowRight'),
      jump:     this.keys.has('Space'),
      jumpPressed: this.jumpPressed,
      fire:     !this.vHeld && this.lockedOrForced && this.mouseButtons.has(0),
      // Set by Game.ts when a use-tool is held (routes LMB to the tool's verb).
      useItem:  false,
      aim:      aiming,
      interact: this.interactPressed,
      interactHeld: this.keys.has('KeyX'),
      anchor:   false,
      // Canvas AMOUNT is hauled by holding [X] at the rigging / W-S at the helm.
      // Sail ANGLE (yard brace / trim) is Q/F while steering — the HUD names these
      // keys ("Trim Left [Q]" / "Trim Right [F]") and the server applies them.
      sailRaise: false,
      sailLower: false,
      sailLeft:  this.keys.has('KeyQ'),
      sailRight: this.keys.has('KeyF'),
      trade:    this.tradePressed,
      reload:   this.reloadPressed,
      placeKeg: this.placeKegPressed,
      dropChest: this.dropChestPressed,
      specialAttack: this.specialAttackPressed,
      slot:     this.slotPressed,
      cannonAmmo: this.cannonAmmoPressed,
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
  private get lockedOrForced() { return this.locked || this.debugAssumeLocked; }

  isAiming() { return this.isAimHeld(); }
  isFiring() { return !this.vHeld && this.lockedOrForced && this.mouseButtons.has(0); }
  isLocked() { return this.locked; }
  isKegPreviewActive() { return this.kegHeld || Date.now() < this.kegPreviewUntil; }
  isInteractHeld() { return this.keys.has('KeyX'); }
  /** True while [I] is held — supply wheel overlay */
  isSupplyWheelOpen() { return this.vHeld; }
  queueWheelSlot(slot: number) {
    if (slot >= 0 && slot <= 9) this.pendingWheelSlot = slot;
  }
  hasPendingActions() {
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
  /** While supply wheel is open, which slot (0–7) has a digit held — for FP preview */
  getSupplyWheelHeldSlot(): number | null {
    if (!this.vHeld) return null;
    for (let i = 1; i <= 9; i++) if (this.keys.has(`Digit${i}`)) return i - 1;
    return null;
  }
  getMoveAxes() {
    return {
      x: ((this.keys.has('KeyD') || this.keys.has('ArrowRight')) ? 1 : 0)
        - ((this.keys.has('KeyA') || this.keys.has('ArrowLeft')) ? 1 : 0),
      z: ((this.keys.has('KeyW') || this.keys.has('ArrowUp')) ? 1 : 0)
        - ((this.keys.has('KeyS') || this.keys.has('ArrowDown')) ? 1 : 0),
    };
  }

  getSwimVerticalIntent() {
    return (this.keys.has('Space') ? 1 : 0) - (this.keys.has('KeyZ') ? 1 : 0);
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

  /** Headless-automation hook: pointer lock never engages under Playwright,
   *  so screenshot tours drive the camera through this instead of mouse deltas. */
  setLook(yaw: number, pitch: number) {
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this.yaw = yaw;
    this.pitch = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, pitch));
  }

  private isAimHeld() {
    return this.lockedOrForced && (
      this.mouseButtons.has(2)
      || this.keys.has('ShiftLeft')
      || this.keys.has('ShiftRight')
    );
  }
}
