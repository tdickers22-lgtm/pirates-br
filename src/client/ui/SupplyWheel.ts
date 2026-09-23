/**
 * THE SUPPLY WHEEL ON THE SHARED RADIAL (b1.4d). Moved out of Game.ts, where
 * the mouse hover, the per-path click and the release-to-take lived as three
 * separate rules, and where a finger could only hit the thin painted path.
 * Now every device goes through RadialMenu:
 *
 *  - mouse:   hover by angle (window mousemove), release [I] over a slice
 *             takes it, a click takes it at once; digits come from InputManager.
 *  - touch:   a tap anywhere in a wedge (icon, label, count) takes it and closes
 *             the wheel (the Satchel button toggles it open).
 *  - gamepad: stick(x, y) selects, release of LB takes it (b1.4e wires the pad).
 *
 * DOM-light on purpose: the geometry needs only a box with getBoundingClientRect,
 * so scripts/test-touch-controls.mjs taps a real SupplyWheel with a stub box.
 */
import { RadialMenu, DEFAULT_RADIAL } from './RadialMenu.js';

export interface WheelBox {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

export interface SupplyWheelHost {
  isOpen(): boolean;
  /** Use or equip a slot (Game.activateWheelSlot: carry/preview guards). */
  activate(slot: number): void;
  /** Close the wheel after a touch pick (releases the Satchel toggle). */
  close(): void;
}

/** The wheel's radius in viewBox units (slices are r 92 of a 200-unit box). */
const WHEEL_R_OF_BOX = 0.5;

export class SupplyWheel {
  readonly menu = new RadialMenu(DEFAULT_RADIAL);
  private wasOpen = false;

  constructor(private readonly box: WheelBox | null, private readonly host: SupplyWheelHost) {}

  /** Wire the DOM: one pointerdown on the whole svg, one mousemove on the window. */
  bind(svg: SVGSVGElement | null, win: Window = window) {
    if (!svg) return;
    svg.addEventListener('pointerdown', (event) => {
      if (!this.host.isOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      this.tapAt(event.clientX, event.clientY, event.pointerType !== 'mouse');
    });
    win.addEventListener('mousemove', (event) => {
      if (!this.host.isOpen()) { this.menu.reset(); return; }
      this.pointerAt(event.clientX, event.clientY);
    });
  }

  private hub(): { cx: number; cy: number; r: number } | null {
    if (!this.box) return null;
    const rect = this.box.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return null;
    return { cx: rect.left + rect.width * 0.5, cy: rect.top + rect.height * 0.5, r: Math.min(rect.width, rect.height) * WHEEL_R_OF_BOX };
  }

  /** Mouse hover (radial select; release of the wheel key takes it). */
  pointerAt(clientX: number, clientY: number): number | null {
    const h = this.hub();
    if (!h) return null;
    return this.menu.pointer(clientX - h.cx, clientY - h.cy, h.r);
  }

  /** A click or tap on the wheel: take the slice under it now. A finger also
   *  closes the wheel (it was opened by a toggle, not a held key). */
  tapAt(clientX: number, clientY: number, finger: boolean): number | null {
    const h = this.hub();
    if (!h) return null;
    const slot = this.menu.tap(clientX - h.cx, clientY - h.cy, h.r);
    if (slot === null) return null;
    this.host.activate(slot);
    if (finger) this.host.close();
    return slot;
  }

  /** Gamepad right stick (b1.4e). */
  stick(x: number, y: number): number | null {
    return this.host.isOpen() ? this.menu.stick(x, y) : null;
  }

  get hoverSlot(): number | null { return this.menu.hover; }

  /** Every frame: on the frame the wheel closes, take whatever is hovered. */
  update() {
    const open = this.host.isOpen();
    if (this.wasOpen && !open) {
      const slot = this.menu.take();
      if (slot !== null) this.host.activate(slot);
    }
    if (!open) this.menu.reset();
    this.wasOpen = open;
  }
}
