/**
 * THE ACTIVE INPUT SCHEME = THE LAST DEVICE USED (b1.4a; D12).
 *
 * Mouse + keyboard (trackpad included), Standard gamepad, or touch. Schemes
 * switch live: prompts, the lock pill, input authority and (later) glyphs read
 * `current`. Keyboard input counts as the mouse scheme. Touch is recognised
 * from Pointer Events' pointerType, so the compatibility mouse events a tap
 * synthesises never flip a phone back to the mouse scheme. The gamepad source
 * (b1.4e) calls note('gamepad') when a stick or button moves past its deadzone.
 */
import type { InputSchemeId } from '../../shared/bindings.js';

export type SchemeListener = (scheme: InputSchemeId, previous: InputSchemeId) => void;

/** Mouse movement must travel this far (px, summed) before a touch/pad session
 *  hands the scheme back to the mouse; a bumped desk is not a scheme change. */
const MOUSE_WAKE_PX = 12;

export class InputSchemeTracker {
  private scheme: InputSchemeId;
  private listeners: SchemeListener[] = [];
  private mouseTravel = 0;

  constructor(initial: InputSchemeId = 'mouse') {
    this.scheme = initial;
  }

  get current(): InputSchemeId { return this.scheme; }

  onChange(fn: SchemeListener): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }

  /** Record that a device was used. Returns true when the scheme changed. */
  note(scheme: InputSchemeId): boolean {
    if (scheme !== 'mouse') this.mouseTravel = 0;
    if (scheme === this.scheme) return false;
    const previous = this.scheme;
    this.scheme = scheme;
    for (const fn of this.listeners) fn(scheme, previous);
    return true;
  }

  /** Mouse motion: switches to the mouse scheme only after MOUSE_WAKE_PX of travel. */
  noteMouseMove(dx: number, dy: number): boolean {
    if (this.scheme === 'mouse') return false;
    this.mouseTravel += Math.abs(dx) + Math.abs(dy);
    if (this.mouseTravel < MOUSE_WAKE_PX) return false;
    return this.note('mouse');
  }

  /** Wire DOM listeners. Safe to call without a DOM (returns immediately). */
  attach(doc: Pick<Document, 'addEventListener'> | undefined = typeof document !== 'undefined' ? document : undefined) {
    if (!doc) return;
    doc.addEventListener('pointerdown', (e: Event) => {
      const type = (e as PointerEvent).pointerType;
      this.note(type === 'touch' || type === 'pen' ? 'touch' : 'mouse');
    }, true);
    doc.addEventListener('pointermove', (e: Event) => {
      const p = e as PointerEvent;
      if (p.pointerType === 'mouse') this.noteMouseMove(p.movementX ?? 0, p.movementY ?? 0);
    }, true);
    doc.addEventListener('keydown', () => { this.note('mouse'); }, true);
    this.onChange((scheme) => {
      if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.dataset.inputScheme = scheme;
      }
    });
    if (typeof document !== 'undefined' && document.documentElement) {
      document.documentElement.dataset.inputScheme = this.scheme;
    }
  }
}

/** First guess before any input: a coarse-only pointer (phone, iPad without a
 *  trackpad) starts on touch; everything else on the mouse scheme. */
export function initialScheme(): InputSchemeId {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'mouse';
  try {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const fine = window.matchMedia('(any-pointer: fine)').matches;
    return coarse && !fine ? 'touch' : 'mouse';
  } catch {
    return 'mouse';
  }
}
