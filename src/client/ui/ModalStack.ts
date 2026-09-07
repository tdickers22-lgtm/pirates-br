/**
 * ONE STACK, ONE ESCAPE KEY (hud-22).
 *
 * Every overlay in this product invented its own way out, and three of them
 * had none at all:
 *
 *  • the onboarding cards (SAIL / FIGHT / WIN) could only be left with a mouse
 *    — Next and Skip were buttons, Escape did nothing, and Enter did nothing.
 *    A player who opened them from the legend footer mid-voyage had a card over
 *    their deck and a pointer lock they had just broken to click it.
 *  • the Settings and How-to-Play panels were left by clicking Back. At 540 px
 *    of viewport height the panel is taller than the screen and Back is BELOW
 *    the fold, so the menu was a dead end (the panel scrolls now, and its
 *    footer is sticky — see index.html — but the key has to work too).
 *  • the lifetime-stats modal DID take Escape, through a `document` listener of
 *    its own that fired whether or not it was the top thing on screen.
 *
 * Three private conventions is the same as none: the player learns nothing and
 * cannot predict what a key does. So there is one stack. The last thing opened
 * is the thing Escape closes and the thing Enter confirms, and nothing else
 * sees the key.
 *
 * The core is DOM-free on purpose — `scripts/test-modal-stack.mjs` drives it
 * under plain node — and `installModalStack()` is the only part that touches
 * `document`.
 */

export interface ModalEntry {
  /** Stable id. Opening the same id twice moves it to the top, never doubles it. */
  id: string;
  /** Take it off the screen. The stack has already popped it when this runs. */
  close: () => void;
  /** Enter's meaning while this is on top (Next, Back, Ready). Absent ⇒ Enter
   *  falls through to whatever else is listening. */
  confirm?: () => void;
  /** Escape does not dismiss it (the disconnect overlay has no "cancel"). */
  sticky?: boolean;
}

export class ModalStack {
  private stack: ModalEntry[] = [];

  /** Push (or re-raise) a modal. Returns the depth after the push. */
  open(entry: ModalEntry): number {
    this.stack = this.stack.filter((e) => e.id !== entry.id);
    this.stack.push(entry);
    return this.stack.length;
  }

  /** Remove one modal by id WITHOUT calling its close — for an overlay that
   *  closed itself (a button, a click on the dim). Returns true if it was up. */
  notifyClosed(id: string): boolean {
    const before = this.stack.length;
    this.stack = this.stack.filter((e) => e.id !== id);
    return this.stack.length !== before;
  }

  /** Close one modal by id, running its close callback. */
  close(id: string): boolean {
    const entry = this.stack.find((e) => e.id === id);
    if (!entry) return false;
    this.stack = this.stack.filter((e) => e.id !== id);
    entry.close();
    return true;
  }

  /** Escape: close the top, unless it is sticky. */
  closeTop(): boolean {
    const top = this.stack[this.stack.length - 1];
    if (!top || top.sticky) return false;
    this.stack.pop();
    top.close();
    return true;
  }

  /** Enter: run the top's confirm, if it has one. */
  confirmTop(): boolean {
    const top = this.stack[this.stack.length - 1];
    if (!top?.confirm) return false;
    top.confirm();
    return true;
  }

  topId(): string | null {
    return this.stack[this.stack.length - 1]?.id ?? null;
  }

  isOpen(id?: string): boolean {
    return id === undefined ? this.stack.length > 0 : this.stack.some((e) => e.id === id);
  }

  depth(): number { return this.stack.length; }

  /** Drop everything without running any close callback — the DOM is going
   *  away under us (a match starting, a return to the menu). */
  reset(): void { this.stack.length = 0; }

  /**
   * THE ONLY KEY ROUTER. Returns true when the stack consumed the key, which
   * is the caller's signal to `preventDefault()` and stop propagation.
   *
   * It returns FALSE for every key when nothing is open. That is the whole
   * safety property: an in-match Escape must still reach the browser to release
   * the pointer lock, and an Enter typed into the pirate-name field must still
   * submit it. A router that swallowed keys on an empty stack would be a worse
   * bug than the one it fixes.
   */
  handleKey(key: string, opts: { inTextField?: boolean } = {}): boolean {
    if (this.stack.length === 0) return false;
    if (key === 'Escape') return this.closeTop();
    if (key === 'Enter') {
      if (opts.inTextField) return false;
      return this.confirmTop();
    }
    return false;
  }
}

/** The app's one stack. */
export const modalStack = new ModalStack();

let installed = false;

/** Bind the stack to the document, once. Capture phase, so it lands before the
 *  panel-local listeners it replaces. */
export function installModalStack(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape' && event.key !== 'Enter') return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    const inTextField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (!modalStack.handleKey(event.key, { inTextField })) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}
