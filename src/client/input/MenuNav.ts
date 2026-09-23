/**
 * MENUS ON A PAD (b1.4e; crossdevice-05). A visible focus ring walks the
 * controls on screen with the D-pad or the left stick, A activates the ringed
 * control, B backs out through the one ModalStack (the same stack Escape uses,
 * hud-22), so a pad player can queue, open Settings, leave a panel and read the
 * onboarding cards without touching a mouse.
 *
 * Candidates are `[data-nav]` plus every native control (button, link, input,
 * select, [role=button], tabbable) that is visible and not covered: a control
 * under an open panel fails the hit test at its centre, so the ring never walks
 * behind a modal. Movement is spatial (nearest control in the pressed
 * direction, off-axis distance weighted x2). The first ring lands on
 * `[data-nav-default]`, else the public Play button, else the first control.
 *
 * `pickNext` is pure (scripts/test-gamepad-curves.mjs checks it); the class is
 * the DOM glue InputManager drives once per frame while the pad is in menu mode.
 */
import { modalStack } from '../ui/ModalStack.js';

export type NavDir = 'up' | 'down' | 'left' | 'right';
export type NavRect = { x: number; y: number; w: number; h: number };

const CANDIDATES = '[data-nav], button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
const DEFAULT_IDS = ['menu-play-btn'];
const BACK_SELECTOR = '[data-nav-back], .back-btn, [id$="-back"], [id$="-back-btn"], [id$="-close"]';
/** Held direction: first repeat after this, then every REPEAT_MS. */
const REPEAT_DELAY_MS = 400;
const REPEAT_MS = 150;
export const FOCUS_CLASS = 'pad-focus';

/** Index of the nearest candidate in `dir` from `from`, or -1. */
export function pickNext(from: NavRect, rects: readonly NavRect[], dir: NavDir): number {
  const fx = from.x + from.w / 2;
  const fy = from.y + from.h / 2;
  let best = -1;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const dx = cx - fx;
    const dy = cy - fy;
    const along = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) return;
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = i; }
  });
  return best;
}

export class MenuNav {
  private focused: HTMLElement | null = null;
  private heldDir: NavDir | null = null;
  private nextRepeat = 0;
  private styled = false;

  constructor(private readonly doc: Document = document) {}

  getFocused() { return this.focused; }

  private visible(el: HTMLElement): boolean {
    if ((el as HTMLButtonElement).disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const style = this.doc.defaultView?.getComputedStyle(el);
    if (style && (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0)) return false;
    const view = this.doc.defaultView;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (view && cx >= 0 && cy >= 0 && cx <= view.innerWidth && cy <= view.innerHeight) {
      const hit = this.doc.elementFromPoint(cx, cy);
      if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) return false;
    }
    return true;
  }

  candidates(): HTMLElement[] {
    return [...this.doc.querySelectorAll<HTMLElement>(CANDIDATES)].filter((el) => this.visible(el));
  }

  private ensureStyle() {
    if (this.styled) return;
    this.styled = true;
    const s = this.doc.createElement('style');
    s.setAttribute('data-menu-nav', '');
    s.textContent = `.${FOCUS_CLASS}{outline:3px solid #f5c542 !important;outline-offset:3px !important;box-shadow:0 0 0 6px rgba(245,197,66,.35) !important}`;
    this.doc.head.appendChild(s);
  }

  focus(el: HTMLElement | null) {
    if (this.focused === el) return;
    this.focused?.classList.remove(FOCUS_CLASS);
    this.focused = el;
    if (!el) return;
    this.ensureStyle();
    el.classList.add(FOCUS_CLASS);
    try { el.focus({ preventScroll: true }); } catch { /* not focusable */ }
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  /** Put the ring somewhere sensible if it is missing or its control left. */
  ensureFocus(): HTMLElement | null {
    const list = this.candidates();
    if (this.focused && list.includes(this.focused)) return this.focused;
    const preferred = list.find((el) => el.hasAttribute('data-nav-default'))
      ?? list.find((el) => DEFAULT_IDS.includes(el.id))
      ?? list[0] ?? null;
    this.focus(preferred);
    return preferred;
  }

  move(dir: NavDir) {
    const current = this.ensureFocus();
    if (!current) return;
    if (current instanceof HTMLInputElement && current.type === 'range' && (dir === 'left' || dir === 'right')) {
      if (dir === 'left') current.stepDown(); else current.stepUp();
      current.dispatchEvent(new Event('input', { bubbles: true }));
      current.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    if (current instanceof HTMLSelectElement && (dir === 'left' || dir === 'right')) {
      const n = current.options.length;
      if (n) {
        current.selectedIndex = (current.selectedIndex + (dir === 'right' ? 1 : n - 1)) % n;
        current.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    const list = this.candidates().filter((el) => el !== current);
    const box = (el: HTMLElement): NavRect => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const i = pickNext(box(current), list.map(box), dir);
    if (i >= 0) this.focus(list[i]);
  }

  /** A: press the ringed control. */
  activate() {
    const el = this.ensureFocus();
    if (!el) return;
    if (el instanceof HTMLInputElement && ['text', 'search', 'email', 'number'].includes(el.type)) { el.focus(); return; }
    el.click();
  }

  /** B: close the top modal; failing that, press a visible Back/Close control. */
  back() {
    if (modalStack.closeTop()) return;
    const back = [...this.doc.querySelectorAll<HTMLElement>(BACK_SELECTOR)].find((el) => this.visible(el));
    back?.click();
  }

  /** One frame of pad input while in menu mode. `dir` is the held direction. */
  update(input: { dir: NavDir | null; a: boolean; b: boolean }, now: number) {
    if (input.dir && input.dir !== this.heldDir) {
      this.move(input.dir);
      this.nextRepeat = now + REPEAT_DELAY_MS;
    } else if (input.dir && now >= this.nextRepeat) {
      this.move(input.dir);
      this.nextRepeat = now + REPEAT_MS;
    }
    this.heldDir = input.dir;
    if (input.a) this.activate();
    else if (input.b) this.back();
    else if (!this.focused || !this.focused.isConnected) this.ensureFocus();
  }

  /** The player went back to the mouse or into play: drop the ring. */
  clear() {
    this.focus(null);
    this.heldDir = null;
  }
}
