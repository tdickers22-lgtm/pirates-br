/**
 * ONE CARD: HOW TO WIN (b1.5g, mechanicshud-11).
 *
 * This used to be a three-card tour (SAIL, FIGHT, WIN) that opened itself over
 * the horn on a first voyage. On a phone it ran off the glass, and it taught
 * keys the phone does not have, minutes before the player met a wheel, a hole
 * or a gun. The verbs now arrive as first-time tips at the moment they are
 * needed (firstTimeTips.ts). What is left here is the one thing no station can
 * teach: how the match is won. It shows during the countdown of a first voyage
 * (the player cannot move yet, so it costs nothing), closes itself at the horn,
 * and stays re-openable from How to Play in the menu and from the [L] card.
 *
 * The DOM lives in index.html (#onboard-cards); this module owns its behaviour
 * so the menu and the HUD drive exactly one implementation.
 */

import { modalStack } from './ModalStack.js';
import { glyph, winGoldText } from './InputGlyphs.js';
import { BROKER_NAME } from '../../shared/DisplayNames.js';

type Card = { kicker: string; glyph: string; title: string; lines: string[] };

/** Built at open time so the win target and the map glyph follow the rule and the device. */
const winCard = (): Card => ({
  kicker: 'How to win',
  glyph: '☠',
  title: 'Two ways to win',
  lines: [
    `<b>Bank ${winGoldText()}</b>, or be the <b>last crew afloat</b>.`,
    `Dig chests on the islands, carry them aboard and sell them to a <b>${BROKER_NAME}</b> (the gold coin on your map ${glyph('map')}).`,
    'The storm ring shrinks all match. Stay inside it.',
    'Tips show up the first time you take the wheel, find a hole or man a cannon.',
  ],
});

let CARDS: readonly Card[] = [winCard()];
/** 'countdown' = opened by the start sequence; the horn closes it. */
let openedFor: 'countdown' | 'user' | null = null;

let index = 0;
let wired = false;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;

function paint(): void {
  const card = CARDS[index];
  const kicker = el('oc-kicker');
  const glyph = el('oc-glyph');
  const title = el('oc-title');
  const body = el('oc-body');
  const next = el<HTMLButtonElement>('oc-next');
  const dots = el('oc-dots');
  if (kicker) kicker.textContent = card.kicker;
  if (glyph) glyph.textContent = card.glyph;
  if (title) title.textContent = card.title;
  // Authored copy only — no player-supplied text ever reaches this innerHTML.
  if (body) body.innerHTML = card.lines.map((line) => `<p>${line}</p>`).join('');
  if (next) next.textContent = index === CARDS.length - 1 ? 'Got it' : 'Next';
  // One card: no page dots, and no Skip beside a button that already closes it.
  if (dots) dots.innerHTML = CARDS.length > 1 ? CARDS.map((_, i) => `<span class="oc-dot${i === index ? ' on' : ''}"></span>`).join('') : '';
  const skip = el('oc-skip');
  if (skip) skip.style.display = CARDS.length > 1 ? '' : 'none';
}

/** Open (or re-open) the How to win card. */
export function openOnboardingCards(reason: 'countdown' | 'user' = 'user'): void {
  wireOnboardingCards();
  const root = el('onboard-cards');
  if (!root) return;
  CARDS = [winCard()];
  index = 0;
  openedFor = reason;
  paint();
  root.classList.add('visible');
  // hud-22: the tour was mouse-only. Escape skips it, Enter is Next / Set sail
  // — the same two keys every other overlay answers to (ModalStack).
  modalStack.open({ id: 'onboarding-cards', close: closeOnboardingCards, confirm: advance });
}

export function closeOnboardingCards(): void {
  openedFor = null;
  el('onboard-cards')?.classList.remove('visible');
  modalStack.notifyClosed('onboarding-cards');
}

/** The horn: a card the countdown opened goes with it (one the player opened stays). */
export function closeCountdownCard(): void {
  if (openedFor === 'countdown' && areOnboardingCardsOpen()) closeOnboardingCards();
}

const SEEN_KEY = 'piratesBR.seenControls';

/**
 * The countdown is <body class="match-ceremony"> (Game.showStartSequence adds
 * it, the horn removes it). The card follows that class directly: the HUD's
 * frame needs the join snapshot, which on a slow machine lands after the horn,
 * so a HUD-driven open missed the whole countdown. First voyage only (the
 * persisted flag); the horn closes it.
 */
export function syncCountdownCard(): void {
  const counting = !!globalThis.document?.body?.classList.contains('match-ceremony');
  if (!counting) {
    closeCountdownCard();
    return;
  }
  if (areOnboardingCardsOpen()) return;
  let seen = false;
  try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch { /* private mode */ }
  if (seen) return;
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* private mode */ }
  openOnboardingCards('countdown');
}

let countdownWatch: MutationObserver | null = null;
export function installCountdownCard(): void {
  const body = globalThis.document?.body;
  if (countdownWatch || !body || typeof MutationObserver === 'undefined') return;
  countdownWatch = new MutationObserver(syncCountdownCard);
  countdownWatch.observe(body, { attributes: true, attributeFilter: ['class'] });
}
installCountdownCard();

export function areOnboardingCardsOpen(): boolean {
  return !!el('onboard-cards')?.classList.contains('visible');
}

function advance(): void {
  if (index >= CARDS.length - 1) {
    closeOnboardingCards();
    return;
  }
  index += 1;
  paint();
}

/**
 * Bind the buttons once. Called from every entry point (open, and the HUD's
 * first pass) so the legend footer's 'How to Play' works even for a pirate who
 * never sees the cards open themselves.
 */
export function wireOnboardingCards(): void {
  if (wired) return;
  const root = el('onboard-cards');
  if (!root) return;
  wired = true;
  el('oc-next')?.addEventListener('click', advance);
  el('oc-skip')?.addEventListener('click', closeOnboardingCards);
  el('legend-howto-btn')?.addEventListener('click', () => openOnboardingCards());
  // Clicking the dim outside the card is a skip; clicking the card is not.
  root.addEventListener('click', (event) => {
    if (event.target === root) closeOnboardingCards();
  });
}
