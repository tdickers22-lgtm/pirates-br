/**
 * MOBILE SHELL (b1.5a; crossdevice-03, crossdevice-06, crossdevice-10).
 *
 * The page-level half of "play on a phone": the browser must never zoom, the
 * installed app must fill the glass, and a phone held upright in a match gets
 * a "turn your phone sideways" card instead of a squeezed desktop HUD.
 *
 *  - CSS (mobile.css) does most of it: html/body touch-action none (no pinch,
 *    no double-tap zoom), menu scroll panels pan-y, safe-area insets on every
 *    HUD region.
 *  - WebKit ignores touch-action for its own pinch in places and ignores
 *    user-scalable=no since iOS 10, so gesturestart/gesturechange and any
 *    multi-finger touchmove are prevented here: always on a touch device,
 *    only in a match on a desktop (menus keep ctrl-wheel / pinch zoom there
 *    for accessibility; Game.ts owns the in-match ctrl-wheel block).
 *  - Play on a touch device asks for fullscreen and a landscape lock (Android
 *    Chrome; iOS Safari has neither and keeps the PWA manifest route).
 *
 * Loaded by index.html as its own module, so it runs before the game bundle
 * and needs nothing from Game: "in a match" is read off the DOM (#hud.visible
 * with no menu over it). State is mirrored onto <html data-*> for the CSS.
 */

export type ShellState = {
  readonly inMatch: boolean;
  /** Primary input is a finger (pointer: coarse or touch points and no hover). */
  readonly coarse: boolean;
  /** Touch device whose short side is phone-sized (<= 600 CSS px). */
  readonly phone: boolean;
  readonly portrait: boolean;
};

export const PHONE_MAX_SHORT_SIDE = 600;

export function isPhone(width: number, height: number, coarse: boolean): boolean {
  return coarse && Math.min(width, height) <= PHONE_MAX_SHORT_SIDE;
}

/** Safari gesture events: page zoom on iOS and the macOS trackpad. */
export function blockGesture(s: ShellState): boolean {
  return s.coarse || s.inMatch;
}

/** Two or more fingers moving = a pinch the browser would read as zoom. One
 *  finger is menu scrolling or the move stick, never the shell's business. */
export function blockTouchMove(touches: number, s: ShellState): boolean {
  return touches > 1 && (s.coarse || s.inMatch);
}

/** ctrl+wheel = trackpad pinch (Chrome, Firefox). Page zoom stays on menus. */
export function blockCtrlWheel(s: ShellState): boolean {
  return s.inMatch;
}

export function showRotateCard(s: ShellState): boolean {
  return s.phone && s.portrait && s.inMatch;
}

export type FullscreenEnv = {
  readonly coarse: boolean;
  /** Already an installed app (display-mode fullscreen/standalone). */
  readonly standalone: boolean;
  readonly fullscreenEnabled: boolean;
  readonly isFullscreen: boolean;
};

export function wantsFullscreen(e: FullscreenEnv): boolean {
  return e.coarse && !e.standalone && e.fullscreenEnabled && !e.isFullscreen;
}

/** Buttons that start or rejoin a match: the user gesture fullscreen needs. */
export const PLAY_SELECTOR = [
  '#menu-play-btn', '#menu-solo-btn', '#menu-join-confirm-btn', '#menu-create-party-btn',
  '#endmatch-play-again-btn', '[data-starts-match]',
].join(', ');

type ShellDebug = { fullscreenRequests: number; state: () => ShellState };

function install(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const root = document.documentElement;
  const mq = (q: string): boolean => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);
  const coarseNow = (): boolean => mq('(pointer: coarse)') || (navigator.maxTouchPoints > 0 && !mq('(hover: hover)'));
  const standalone = (): boolean => mq('(display-mode: fullscreen)') || mq('(display-mode: standalone)')
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;

  let hud: HTMLElement | null = null;
  let menu: HTMLElement | null = null;
  let endmatch: HTMLElement | null = null;
  const inMatchNow = (): boolean => {
    hud ??= document.getElementById('hud');
    menu ??= document.getElementById('menu-screen');
    endmatch ??= document.getElementById('endmatch-screen');
    return !!hud?.classList.contains('visible')
      && !menu?.classList.contains('visible')
      && !endmatch?.classList.contains('visible');
  };
  const state = (): ShellState => {
    const coarse = coarseNow();
    const w = window.innerWidth;
    const h = window.innerHeight;
    return { inMatch: inMatchNow(), coarse, phone: isPhone(w, h, coarse), portrait: h > w };
  };

  let last = '';
  const sync = (): void => {
    const s = state();
    const key = `${+s.inMatch}${+s.coarse}${+s.phone}${+s.portrait}`;
    if (key === last) return;
    last = key;
    root.dataset.inMatch = s.inMatch ? '1' : '0';
    root.dataset.phone = s.phone ? '1' : '0';
    root.dataset.portrait = s.portrait ? '1' : '0';
    root.dataset.rotate = showRotateCard(s) ? '1' : '0';
  };

  const opts: AddEventListenerOptions = { passive: false };
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => { if (blockGesture(state())) e.preventDefault(); }, opts);
  }
  document.addEventListener('touchmove', (e) => {
    if (e.cancelable && blockTouchMove(e.touches.length, state())) e.preventDefault();
  }, opts);
  // A double-tap that WebKit still turns into a dblclick zoom in a match.
  document.addEventListener('dblclick', (e) => { if (inMatchNow()) e.preventDefault(); }, opts);

  const debug: ShellDebug = { fullscreenRequests: 0, state };
  (window as Window & { __mobileShell?: ShellDebug }).__mobileShell = debug;
  const onPlay = (e: Event): void => {
    const target = e.target as Element | null;
    if (!target?.closest?.(PLAY_SELECTOR)) return;
    const el = root as HTMLElement & { webkitRequestFullscreen?: () => void };
    const enabled = !!(document.fullscreenEnabled && el.requestFullscreen);
    if (!wantsFullscreen({ coarse: coarseNow(), standalone: standalone(), fullscreenEnabled: enabled, isFullscreen: !!document.fullscreenElement })) return;
    debug.fullscreenRequests += 1;
    try {
      const p = el.requestFullscreen({ navigationUI: 'hide' });
      void p?.then(() => {
        const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        return o?.lock?.('landscape');
      }).catch(() => { /* iOS, desktop emulation, or the user said no: play on */ });
    } catch { /* same */ }
  };
  // Capture phase: fullscreen must be asked inside the user gesture, before
  // the menu's own handler swaps panels.
  document.addEventListener('click', onPlay, true);

  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);
  const watch = (): void => {
    sync();
    const obs = new MutationObserver(sync);
    for (const id of ['hud', 'menu-screen', 'endmatch-screen']) {
      const node = document.getElementById(id);
      if (node) obs.observe(node, { attributes: true, attributeFilter: ['class'] });
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch, { once: true });
  else watch();
}

install();
