/**
 * THE FIRST VOYAGE, IN THREE CARDS.
 *
 * What a new pirate used to be told was the entire SHIP'S ORDERS legend — a
 * fourteen-line card of keys, stations, streak tables and win conditions —
 * dumped on screen once per browser, forever, in the same second the starting
 * horn went off. Nobody reads that. Worse, nothing in the game could bring it
 * back: the single teaching moment was spent, and a player who blinked never
 * learned there were two ways to win.
 *
 * This is the replacement: three short cards — SAIL, FIGHT, WIN — one idea
 * each, with Next and Skip. They open themselves on a first-ever voyage, and
 * they are re-openable forever from two places a lost player will actually
 * look: How to Play in the menu, and the 'How to Play' button in the footer of
 * the [L] card.
 *
 * The DOM lives in index.html (#onboard-cards); this module owns its behaviour
 * so the menu and the HUD drive exactly one implementation.
 */

type Card = { kicker: string; glyph: string; title: string; lines: string[] };

/** Three cards, three verbs. Each is what a pirate must do NEXT, not a list of
 *  everything the key does — the legend is still there for the full table. */
const CARDS: readonly Card[] = [
  {
    kicker: 'One of three',
    glyph: '⛵',
    title: 'Sail',
    lines: [
      'Your ship is the one ringed in gold on the map ([M]) and on the minimap. Walk aboard.',
      'TAKE THE WHEEL FIRST: hold <b>X</b> at it, steer with <b>A</b>/<b>D</b>, and let the sails out and in with <b>W</b>/<b>S</b>.',
      'Weigh anchor FROM the wheel — hold <b>W</b> there. The bow capstan does it too, but she sails herself off the berth with nobody steering.',
      'No crew may fire for the first <b>2:30</b> (the TRUCE clock, beside the storm timer). Get under way before it runs out.',
    ],
  },
  {
    kicker: 'Two of three',
    glyph: '⚔',
    title: 'Fight',
    lines: [
      '<b>1</b>–<b>4</b> pick a weapon, <b>left mouse</b> fires, <b>Shift</b> aims, <b>R</b> reloads.',
      'Cannons are stations: stand at one, hold <b>X</b> to aim and fire it. <b>5</b>/<b>6</b>/<b>7</b> choose the shot.',
      'Holes let the sea in. Hold <b>X</b> at a hole to plank it, and keep planks in the hold.',
    ],
  },
  {
    kicker: 'Three of three',
    glyph: '☠',
    title: 'Win',
    lines: [
      'Two ways to take the seas: <b>bank 9,000 gold</b>, or be the <b>last crew afloat</b>.',
      'Gold comes out of the sand. Dig chests with the shovel, carry them aboard, and sell them to a <b>Tallyman</b> — the gold coin on your chart.',
      'The storm ring shrinks all match. Outside it your hull opens up and your crew bleeds. Stay inside the circle.',
    ],
  },
];

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
  if (next) next.textContent = index === CARDS.length - 1 ? 'Set sail' : 'Next';
  if (dots) {
    dots.innerHTML = CARDS.map((_, i) => `<span class="oc-dot${i === index ? ' on' : ''}"></span>`).join('');
  }
}

/** Open (or re-open) the card tour at card one. */
export function openOnboardingCards(): void {
  wireOnboardingCards();
  const root = el('onboard-cards');
  if (!root) return;
  index = 0;
  paint();
  root.classList.add('visible');
}

export function closeOnboardingCards(): void {
  el('onboard-cards')?.classList.remove('visible');
}

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
  el('legend-howto-btn')?.addEventListener('click', openOnboardingCards);
  // Clicking the dim outside the card is a skip; clicking the card is not.
  root.addEventListener('click', (event) => {
    if (event.target === root) closeOnboardingCards();
  });
}
