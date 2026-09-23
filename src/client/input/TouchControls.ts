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
 * b1.4c adds CONTEXTS (src/client/input/touchContexts.ts): Game.ts calls
 * setContext() every frame and the arc re-forms for the helm (wheel slider,
 * sails, trim, weigh anchor, Leave), the cannon (drag aim, Fire, ammo chips,
 * Leave), swimming (Up/Down), a held tool (Bail/Dig/Raise with a fill ring,
 * Stow) and a carried chest (Drop). A button that disappears while held is
 * released, so a context change never leaves an action stuck on.
 *
 * The overlay only shows on the touch scheme, in a match (menu and loading
 * screens hidden). Everything it does goes through VirtualInputSource into
 * the one bindings table; nothing here touches the wire.
 */
import type { BindingAction } from '../../shared/bindings.js';
import { SHIP } from '../../shared/constants/index.js';
import type { EquippableTool } from '../../shared/types/index.js';
import type { InputSchemeTracker } from './InputScheme.js';
import {
  HELM_SPRING_KEY, HelmSlider, TOUCH_BUTTONS, labelFor, stickEnabled,
  type TouchButtonSpec, type TouchContext,
} from './touchContexts.js';
import { VirtualInputSource, type VirtualInputSink } from './VirtualInputSource.js';

/** Share of the screen width (from the left) that belongs to the move stick. */
export const STICK_ZONE = 0.45;
/** Stick radius in CSS px: full deflection at this distance from the spawn point. */
export const STICK_RADIUS_PX = 56;

/** What Game.ts tells the overlay every frame. */
export interface TouchContextView {
  context: TouchContext;
  anchored: boolean;
  tool: EquippableTool | null;
  /** Server progress for the rings (null = the button runs its own clock). */
  progress?: { fire: number | null; interact: number | null; anchor: number | null };
}

function readSpring(): boolean {
  try { return globalThis.localStorage?.getItem(HELM_SPRING_KEY) !== '0'; } catch { return true; }
}

type Role = { kind: 'stick'; baseX: number; baseY: number }
  | { kind: 'look'; lastX: number; lastY: number; startX: number; startY: number; since: number; travel: number };

/** A look-pad touch this short and still is a TAP (minimap opens the chart). */
export const TAP_MAX_TRAVEL_PX = 10;
export const TAP_MAX_MS = 350;

/** Did a look-pad tap land on the minimap (its box, even under the arc)? */
export function tapHitsBox(x: number, y: number, box: { left: number; top: number; right: number; bottom: number } | null): boolean {
  return !!box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

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
  private readonly buttons = new Map<string, { el: HTMLButtonElement; spec: TouchButtonSpec; release: () => void }>();
  private helmEl: HTMLDivElement | null = null;
  private helmKnob: HTMLDivElement | null = null;
  private springBtn: HTMLButtonElement | null = null;
  private readonly helm = new HelmSlider(readSpring());
  private helmPointer: number | null = null;
  private context: TouchContext = 'foot';
  private viewKey = '';
  /** Server-driven ring values; null = the button's own clock. */
  private progress: { fire: number | null; interact: number | null; anchor: number | null } = { fire: null, interact: null, anchor: null };
  private readonly roles = new Map<number, Role>();
  private active = false;
  private interactSince = 0;
  private ringRaf = 0;
  private poll: ReturnType<typeof setInterval> | null = null;
  /** Set by InputManager: a look-pad tap on the minimap (Game opens the chart). */
  onMinimapTap: (() => void) | null = null;

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
    for (const spec of TOUCH_BUTTONS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `tc-btn tc-${spec.id}${spec.ring ? ' tc-ring' : ''}`;
      btn.dataset.touch = spec.id;
      btn.textContent = spec.label;
      const release = spec.toggle ? this.bindToggle(btn, spec.action) : this.bindHold(btn, spec.action);
      root.appendChild(btn);
      this.buttons.set(spec.id, { el: btn, spec, release });
      if (spec.id === 'interact') this.interactBtn = btn;
    }
    root.appendChild(this.buildHelm());
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
    this.applyView({ context: 'foot', anchored: false, tool: null }, true);
    this.refresh();
  }

  /** The helm wheel slider: a track across the lower left, the knob follows
   *  the thumb; +-22% of the half width puts the rudder over (HelmSlider). */
  private buildHelm() {
    const wrap = document.createElement('div');
    wrap.className = 'tc-helm';
    wrap.dataset.touch = 'helm-slider';
    const knob = document.createElement('div');
    knob.className = 'tc-helm-knob';
    wrap.appendChild(knob);
    const spring = document.createElement('button');
    spring.type = 'button';
    spring.className = 'tc-helm-spring';
    spring.dataset.touch = 'helm-spring';
    this.helmEl = wrap;
    this.helmKnob = knob;
    this.springBtn = spring;
    this.renderSpring();
    const valueAt = (e: PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      return ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    };
    wrap.addEventListener('pointerdown', (e) => {
      if (this.helmPointer !== null) return;
      e.preventDefault(); e.stopPropagation();
      try { wrap.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
      this.helmPointer = e.pointerId;
      this.setHelm(valueAt(e));
    });
    wrap.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.helmPointer) return;
      e.preventDefault();
      this.setHelm(valueAt(e));
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.helmPointer) return;
      this.helmPointer = null;
      this.helm.release();
      this.setHelm(this.helm.value);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) wrap.addEventListener(type, end);
    spring.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.helm.spring = !this.helm.spring;
      try { globalThis.localStorage?.setItem(HELM_SPRING_KEY, this.helm.spring ? '1' : '0'); } catch { /* private mode */ }
      if (this.helm.spring && this.helmPointer === null) { this.helm.release(); this.setHelm(0); }
      this.renderSpring();
    });
    const box = document.createElement('div');
    box.className = 'tc-helm-box';
    box.append(wrap, spring);
    return box;
  }

  private renderSpring() {
    if (!this.springBtn) return;
    this.springBtn.textContent = this.helm.spring ? 'Spring' : 'Hold';
    this.springBtn.classList.toggle('pressed', !this.helm.spring);
  }

  private setHelm(v: number) {
    this.helm.set(v);
    const steer = this.helm.steer();
    for (const action of ['steerLeft', 'steerRight'] as const) {
      if (steer[action]) this.source.press(action);
      else this.source.release(action);
    }
    if (this.helmKnob) this.helmKnob.style.left = `${((this.helm.value + 1) / 2) * 100}%`;
    this.helmEl?.classList.toggle('over', steer.steerLeft || steer.steerRight);
  }

  /** Game.ts, every frame: where the pirate is and what is in her hands. */
  setContext(view: TouchContextView) {
    if (view.progress) this.progress = view.progress;
    this.applyView(view, false);
    // Toggles show their real state (the wheel closes itself after a pick).
    for (const b of this.buttons.values()) {
      if (b.spec.toggle) b.el.classList.toggle('pressed', this.source.isHeld(b.spec.action));
    }
    this.paintProgress();
  }

  getContext() { return this.context; }

  private applyView(view: TouchContextView, force: boolean) {
    const key = `${view.context}|${view.anchored ? 1 : 0}|${view.tool ?? ''}`;
    if (!force && key === this.viewKey) return;
    this.viewKey = key;
    const leaving = this.context;
    this.context = view.context;
    this.root?.setAttribute('data-ctx', view.context);
    // Hidden controls let go first (a Sails-up thumb when the helm is left).
    const shown = new Set<string>();
    for (const [id, b] of this.buttons) {
      const on = b.spec.contexts.includes(view.context) && (!b.spec.whenAnchored || view.anchored);
      if (on) shown.add(id);
      else if (b.el.classList.contains('pressed')) b.release();
      b.el.hidden = !on;
      b.el.textContent = labelFor(b.spec, view.context, view.tool);
    }
    if (leaving === 'helm' && view.context !== 'helm') {
      this.helmPointer = null;
      this.helm.value = 0;
      this.setHelm(0);
    }
    if (this.helmEl?.parentElement) (this.helmEl.parentElement as HTMLElement).hidden = view.context !== 'helm';
    if (!stickEnabled(view.context)) {
      for (const [id, role] of this.roles) {
        if (role.kind === 'stick') { this.roles.delete(id); this.source.setStick(0, 0); this.stickBase?.classList.remove('shown'); }
      }
    }
  }

  /** Rings that follow the server (bail scoop, dig, repair, anchor). */
  private paintProgress() {
    const set = (id: string, v: number | null) => {
      const b = this.buttons.get(id);
      if (!b || v === null) return;
      b.el.style.setProperty('--tc-hold', v.toFixed(3));
    };
    set('fire', this.context === 'tool' ? this.progress.fire : null);
    set('anchor', this.progress.anchor);
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

  /** Tap on, tap off. The press edge runs on the first tap; the release edge
   *  on the second (or when the owner closes it, e.g. a wheel pick). */
  private bindToggle(el: HTMLElement, action: BindingAction): () => void {
    el.addEventListener('pointerdown', (e) => {
      if (!isFingerLike(e) && this.scheme.current !== 'touch') return;
      e.preventDefault();
      e.stopPropagation();
      if (this.source.isHeld(action)) this.source.release(action);
      else this.source.press(action);
      el.classList.toggle('pressed', this.source.isHeld(action));
    });
    return () => {
      if (this.source.isHeld(action)) this.source.release(action);
      el.classList.remove('pressed');
    };
  }

  private bindHold(el: HTMLElement, action: BindingAction, touchOnly = false): () => void {
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
    return () => {
      if (ids.size === 0) return;
      ids.clear();
      el.classList.remove('pressed');
      this.source.release(action);
      if (action === 'interact') this.stopRing();
    };
  }

  /** The hold ring: one sweep per hammer swing (SHIP.HULL_REPAIR_SWING_TIME),
   *  the server's own clock for one plank, so a finger reads the same cadence
   *  the keyboard player hears. */
  private startRing() {
    this.interactSince = performance.now();
    const tick = () => {
      if (!this.interactBtn) return;
      const t = (performance.now() - this.interactSince) / 1000;
      const frac = this.progress.interact
        ?? (t % SHIP.HULL_REPAIR_SWING_TIME) / SHIP.HULL_REPAIR_SWING_TIME;
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
    if (e.clientX < w * STICK_ZONE && stickEnabled(this.context)) {
      if (hasStick) return;
      this.roles.set(e.pointerId, { kind: 'stick', baseX: e.clientX, baseY: e.clientY });
      this.showStick(e.clientX, e.clientY, 0, 0);
    } else {
      if (hasLook) return;
      this.roles.set(e.pointerId, {
        kind: 'look', lastX: e.clientX, lastY: e.clientY,
        startX: e.clientX, startY: e.clientY, since: e.timeStamp, travel: 0,
      });
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
      role.travel += Math.hypot(e.clientX - role.lastX, e.clientY - role.lastY);
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
    } else if (e.type === 'pointerup' && role.travel < TAP_MAX_TRAVEL_PX
      && e.timeStamp - role.since < TAP_MAX_MS) {
      // The minimap is read-only for fingers (touch.css), so the look pad
      // under it decides: a still, short tap inside its box opens the chart.
      const mini = document.getElementById('minimap-shell');
      const r = mini && getComputedStyle(mini).visibility !== 'hidden' ? mini.getBoundingClientRect() : null;
      if (tapHitsBox(role.startX, role.startY, r && r.width > 0 ? r : null)) this.onMinimapTap?.();
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
    // Blur or leaving the match recentres even a latched wheel: the rudder
    // bits were just released, so the knob must not show her still turning.
    this.helmPointer = null;
    this.helm.value = 0;
    this.helmEl?.classList.remove('over');
    this.helmKnob?.style.setProperty('left', `${((this.helm.value + 1) / 2) * 100}%`);
    this.root?.querySelectorAll('.tc-btn.pressed').forEach((el) => el.classList.remove('pressed'));
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
