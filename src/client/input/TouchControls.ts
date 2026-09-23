/**
 * TOUCH CONTROLS FOR PHONE AND IPAD (b1.4b; crossdevice-01/04, liveplay-03).
 *
 * Pointer Events, tracked by pointerId, so two thumbs work at once:
 *  - the left 45% of the screen spawns a dynamic move stick under the thumb;
 *  - the right 55% is drag-to-look (0.0055 rad/px x sensitivity x fovScale,
 *    applied by InputManager.applyTouchLook);
 *  - a thumb arc of buttons: Fire (72 px), Aim, Jump, Crouch, Reload and the
 *    Interact chip. Interact is PRESS AND HOLD like the keyboard [X]: the press
 *    is the interact edge, and interactHeld rides every tick until pointerup,
 *    pointercancel or lostpointercapture, so repair, bail, capstan, halyard,
 *    brace, dig and revive all work by finger. The [X] prompt itself is the
 *    same hold target on touch.
 *
 * The overlay only shows on the touch scheme, in a match (menu and loading
 * screens hidden). Everything it does goes through VirtualInputSource into
 * the one bindings table; nothing here touches the wire.
 */
import type { BindingAction } from '../../shared/bindings.js';
import { SHIP } from '../../shared/constants/index.js';
import type { InputSchemeTracker } from './InputScheme.js';
import { VirtualInputSource, type VirtualInputSink } from './VirtualInputSource.js';

/** Share of the screen width (from the left) that belongs to the move stick. */
export const STICK_ZONE = 0.45;
/** Stick radius in CSS px: full deflection at this distance from the spawn point. */
export const STICK_RADIUS_PX = 56;

interface ButtonSpec { id: string; action: BindingAction; label: string; }
const BUTTONS: readonly ButtonSpec[] = [
  { id: 'fire', action: 'fire', label: 'Fire' },
  { id: 'aim', action: 'aim', label: 'Aim' },
  { id: 'jump', action: 'jump', label: 'Jump' },
  { id: 'crouch', action: 'crouch', label: 'Crouch' },
  { id: 'reload', action: 'reload', label: 'Reload' },
  { id: 'interact', action: 'interact', label: 'X' },
];

type Role = { kind: 'stick'; baseX: number; baseY: number } | { kind: 'look'; lastX: number; lastY: number };

function isFingerLike(e: PointerEvent) {
  return e.pointerType === 'touch' || e.pointerType === 'pen';
}

function hiddenEl(id: string) {
  const el = document.getElementById(id);
  if (!el) return true;
  const style = getComputedStyle(el);
  return style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
}

export class TouchControls {
  readonly source: VirtualInputSource;
  private root: HTMLDivElement | null = null;
  private zone: HTMLDivElement | null = null;
  private stickBase: HTMLDivElement | null = null;
  private stickKnob: HTMLDivElement | null = null;
  private interactBtn: HTMLButtonElement | null = null;
  private readonly roles = new Map<number, Role>();
  private active = false;
  private interactSince = 0;
  private ringRaf = 0;
  private poll: ReturnType<typeof setInterval> | null = null;

  constructor(sink: VirtualInputSink, private readonly scheme: InputSchemeTracker) {
    this.source = new VirtualInputSource(sink);
  }

  mount(parent: HTMLElement = document.body) {
    if (this.root) return;
    // Loaded with the overlay (Vite splits it into its own chunk), so the
    // stylesheet never reaches a desktop and Node suites can import this file.
    // @ts-expect-error a side-effect stylesheet: Vite resolves it, tsc has no CSS module types.
    void import('../styles/touch.css');
    const root = document.createElement('div');
    root.id = 'touch-controls';
    root.setAttribute('aria-hidden', 'true');
    const zone = document.createElement('div');
    zone.className = 'tc-zone';
    const base = document.createElement('div');
    base.className = 'tc-stick';
    const knob = document.createElement('div');
    knob.className = 'tc-knob';
    base.appendChild(knob);
    root.append(zone, base);
    for (const spec of BUTTONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tc-btn tc-${spec.id}`;
      btn.dataset.touch = spec.id;
      btn.textContent = spec.label;
      this.bindHold(btn, spec.action);
      root.appendChild(btn);
      if (spec.id === 'interact') this.interactBtn = btn;
    }
    parent.appendChild(root);
    this.root = root;
    this.zone = zone;
    this.stickBase = base;
    this.stickKnob = knob;

    zone.addEventListener('pointerdown', (e) => this.onZoneDown(e));
    zone.addEventListener('pointermove', (e) => this.onZoneMove(e));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      zone.addEventListener(type, (e) => this.onZoneEnd(e));
    }
    // No double-tap zoom, no long-press callout, no compat mouse events.
    root.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    // The [X] prompt is a hold target on touch (InteractionPrompts ignores its
    // click on the touch scheme so the press is not sent twice).
    const prompt = document.getElementById('interact-prompt');
    if (prompt) this.bindHold(prompt, 'interact', true);

    this.scheme.onChange(() => this.refresh());
    this.poll = setInterval(() => this.refresh(), 250);
    this.refresh();
  }

  /** Shown on the touch scheme, in a match. */
  private refresh() {
    const want = this.scheme.current === 'touch' && hiddenEl('menu-screen') && hiddenEl('loading-screen');
    if (want === this.active) return;
    this.active = want;
    this.root?.classList.toggle('active', want);
    if (!want) this.reset();
  }

  isActive() { return this.active; }

  private bindHold(el: HTMLElement, action: BindingAction, touchOnly = false) {
    const ids = new Set<number>();
    el.addEventListener('pointerdown', (e) => {
      if (touchOnly && !isFingerLike(e)) return;
      if (!touchOnly && !isFingerLike(e) && this.scheme.current !== 'touch') return;
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
      ids.add(e.pointerId);
      el.classList.add('pressed');
      this.source.press(action);
      if (action === 'interact') this.startRing();
    });
    const end = (e: PointerEvent) => {
      if (!ids.delete(e.pointerId)) return;
      if (ids.size > 0) return;
      el.classList.remove('pressed');
      this.source.release(action);
      if (action === 'interact') this.stopRing();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  /** The hold ring: one sweep per hammer swing (SHIP.HULL_REPAIR_SWING_TIME),
   *  the server's own clock for one plank, so a finger reads the same cadence
   *  the keyboard player hears. */
  private startRing() {
    this.interactSince = performance.now();
    const tick = () => {
      if (!this.interactBtn) return;
      const t = (performance.now() - this.interactSince) / 1000;
      const frac = (t % SHIP.HULL_REPAIR_SWING_TIME) / SHIP.HULL_REPAIR_SWING_TIME;
      this.interactBtn.style.setProperty('--tc-hold', frac.toFixed(3));
      this.ringRaf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.ringRaf);
    this.ringRaf = requestAnimationFrame(tick);
  }

  private stopRing() {
    cancelAnimationFrame(this.ringRaf);
    this.interactBtn?.style.setProperty('--tc-hold', '0');
  }

  private onZoneDown(e: PointerEvent) {
    if (!this.active || this.roles.has(e.pointerId)) return;
    e.preventDefault();
    const w = window.innerWidth || 1;
    const hasStick = [...this.roles.values()].some((r) => r.kind === 'stick');
    const hasLook = [...this.roles.values()].some((r) => r.kind === 'look');
    if (e.clientX < w * STICK_ZONE) {
      if (hasStick) return;
      this.roles.set(e.pointerId, { kind: 'stick', baseX: e.clientX, baseY: e.clientY });
      this.showStick(e.clientX, e.clientY, 0, 0);
    } else {
      if (hasLook) return;
      this.roles.set(e.pointerId, { kind: 'look', lastX: e.clientX, lastY: e.clientY });
    }
    try { this.zone?.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
  }

  private onZoneMove(e: PointerEvent) {
    const role = this.roles.get(e.pointerId);
    if (!role) return;
    e.preventDefault();
    if (role.kind === 'stick') {
      let dx = e.clientX - role.baseX;
      let dy = e.clientY - role.baseY;
      const mag = Math.hypot(dx, dy);
      if (mag > STICK_RADIUS_PX) { dx *= STICK_RADIUS_PX / mag; dy *= STICK_RADIUS_PX / mag; }
      this.source.setStick(dx / STICK_RADIUS_PX, dy / STICK_RADIUS_PX);
      this.showStick(role.baseX, role.baseY, dx, dy);
    } else {
      this.source.look(e.clientX - role.lastX, e.clientY - role.lastY);
      role.lastX = e.clientX;
      role.lastY = e.clientY;
    }
  }

  private onZoneEnd(e: PointerEvent) {
    const role = this.roles.get(e.pointerId);
    if (!role) return;
    this.roles.delete(e.pointerId);
    if (role.kind === 'stick') {
      this.source.setStick(0, 0);
      this.stickBase?.classList.remove('shown');
    }
  }

  private showStick(x: number, y: number, dx: number, dy: number) {
    if (!this.stickBase || !this.stickKnob) return;
    this.stickBase.classList.add('shown');
    this.stickBase.style.left = `${x}px`;
    this.stickBase.style.top = `${y}px`;
    this.stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** Every finger off the glass (blur, tab hidden, left the match). */
  reset() {
    this.roles.clear();
    this.source.releaseAll();
    this.stopRing();
    this.stickBase?.classList.remove('shown');
    this.root?.querySelectorAll('.pressed').forEach((el) => el.classList.remove('pressed'));
    document.getElementById('interact-prompt')?.classList.remove('pressed');
  }

  dispose() {
    if (this.poll) clearInterval(this.poll);
    this.reset();
    this.root?.remove();
    this.root = null;
  }
}

/** A device that can deliver touches at all (phone, iPad, touch laptop). */
export function touchCapable(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return (navigator.maxTouchPoints ?? 0) > 0 || 'ontouchstart' in window;
}
