#!/usr/bin/env node
/**
 * WHAT THE HUD ACTUALLY LOOKS LIKE ON A LAPTOP — measured, not eyeballed.
 *
 * The HUD grew one panel per campaign and nothing ever counted the result. At
 * 1280x720 a liveplay reviewer read ~45 strings at idle and could not explain
 * four of the chips without the source (liveplay section 8). Worse things than
 * clutter followed from having no gate:
 *
 *  • hud-16 (P1): the [X] prompt is anchored at top:63% while the footer is
 *    anchored to the bottom and GROWS when the pocket strip wraps. At 960x540
 *    the prompt lands underneath the footer — the one line that tells a player
 *    what the button does is behind a panel.
 *  • hud-05/hud-14: panels overlap (body-level chips paint under the storm
 *    warning) and the right column silently clips whichever panel is last.
 *  • hud-07: gold is painted three times, the storm clock twice, and the two
 *    clocks disagree.
 *
 * Five graded questions, at the three window shapes people actually play in
 * (960x540 is the small-laptop case the fixes are for, 1366x650 the notch/short
 * case, 1280x720 the reviewer's):
 *
 *   1. no two visible HUD regions overlap;
 *   2. at idle the HUD shows at most MAX_TEXT visible strings;
 *   3. the objective line is visible at EVERY size (it used to display:none
 *      below 700 px tall and 720 px wide — exactly the windows that need it);
 *   4. the word Gold appears once;
 *   5. at most one storm clock is on screen;
 *   6. the interact prompt, when it has something to say, is inside the viewport
 *      and clear of the footer.
 *
 * One browser, one match, three viewport resizes.
 * PIRATES_BR_URL=http://127.0.0.1:3101 node scripts/hud-layout-probe.mjs [outDir]
 */
import { chromium } from 'playwright';
import { browserArgs } from './lib/browser-args.mjs';
import { mkdirSync } from 'node:fs';

const BASE_URL = (process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const OUT = process.argv[2] ?? 'test-results/hud-layout';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { w: 960, h: 540, note: 'small laptop window — where the prompt used to hide' },
  { w: 1280, h: 720, note: "the liveplay reviewer's window" },
  { w: 1366, h: 650, note: 'short/notched window' },
];
/** Twelve always-on elements (PLAN 2.6) plus their labels and numbers. */
const MAX_TEXT = 24;

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const browser = await chromium.launch({ args: browserArgs() });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.setDefaultTimeout(90_000);
await page.route('**/@vite/client*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/javascript',
  body: [
    `globalThis.__GAME_SERVER_PORT__ = ${JSON.stringify(process.env.PIRATES_BR_SERVER_PORT ?? '8090')};`,
    'export const createHotContext = () => ({ on(){}, off(){}, send(){}, accept(){}, acceptExports(){}, dispose(){}, prune(){}, invalidate(){}, data:{} });',
    'export const updateStyle = () => {};',
    'export const removeStyle = () => {};',
    'export const injectQuery = (u) => u;',
    'export default {};',
  ].join('\n'),
}));

/** Everything the probe grades, read in ONE evaluate per viewport. */
const readLayout = () => page.evaluate(() => {
  const hud = document.getElementById('hud');
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const shown = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const visibleUp = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) if (!shown(n)) return false;
    return true;
  };
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };

  // REGIONS: the five layout regions, the prompt, and every layer that has ever
  // been parked on top of them by hand.
  const regionIds = [
    'hud-top-left', 'hud-top-center', 'hud-top-right', 'hud-right-tactical',
    'hud-bottom-left', 'hud-bottom-mid', 'hud-bottom-right', 'hud-center-prompt',
    'water-gauge', 'objective-line', 'hud-alarms',
  ];
  const regions = [];
  for (const id of regionIds) {
    const el = document.getElementById(id);
    if (el && visibleUp(el)) regions.push({ id, el, ...rect(el) });
  }
  // Body-level chips: any fixed-position chip the HUD spawns outside #hud.
  for (const el of document.querySelectorAll('body > div[id$="-chip"], body > .hud-chip')) {
    if (visibleUp(el)) regions.push({ id: el.id || el.className, el, ...rect(el) });
  }

  // VISIBLE STRINGS inside the HUD, one entry per element that owns text.
  const strings = [];
  if (hud && visibleUp(hud)) {
    const walker = document.createTreeWalker(hud, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
      // A STRING IS SOMETHING A PLAYER READS. Icon glyphs (⛵ 🪵 ●), the "/"
      // between two ammo numbers and single-character chips are marks, not
      // sentences; counting them made the ceiling meaningless. This counts
      // words and numbers, which is what the audit counted when it found ~45 of
      // them at 1280x720 (PLAN row 35).
      if (t.length < 2 || !/[A-Za-z0-9]/.test(t)) continue;
      const el = n.parentElement;
      if (!el || !visibleUp(el)) continue;
      strings.push(t);
    }
  }

  const objective = document.getElementById('objective-line');
  // THE PROMPT IS REWRITTEN EVERY FRAME by updateHud, so it has to be given
  // something to say and measured in the SAME synchronous turn — set it from
  // outside and the next animation frame has already blanked it.
  const prompt = document.getElementById('interact-prompt');
  if (prompt && !(prompt.textContent ?? '').trim()) {
    prompt.textContent = '[E] Open Chest';
    prompt.style.display = 'block';
  }
  const footer = document.getElementById('hud-bottom-combat');
  // A region INSIDE another region is not a clash (the objective line lives in
  // the top-centre stack); only siblings are graded against each other.
  const pairs = [];
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i];
      const b = regions[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      pairs.push([{ id: a.id, x: a.x, y: a.y, w: a.w, h: a.h }, { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }]);
    }
  }
  return {
    vw, vh, regionCount: regions.length, pairs, strings,
    objectiveVisible: !!objective && visibleUp(objective),
    objectiveText: objective?.textContent?.trim() ?? '(no #objective-line in the document)',
    prompt: prompt && visibleUp(prompt) ? rect(prompt) : null,
    promptText: prompt?.textContent?.trim() ?? '',
    footer: footer && visibleUp(footer) ? rect(footer) : null,
    // Structure, not pixels: the three body-level chips must be children of the
    // top-centre stack, not fixed layers parked in its footprint (hud-14).
    strayFixedChips: [...document.querySelectorAll('body > div')]
      .filter((el) => el.id && /chip|coach/i.test(el.id) && getComputedStyle(el).position === 'fixed')
      .map((el) => el.id),
  };
});

const overlap = (a, b) => {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 1 && oy > 1 ? Math.round(ox * oy) : 0;
};

try {
  await page.goto(`${BASE_URL}/?debug&forceinput`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 30_000 });
  await page.evaluate(() => { localStorage.setItem('piratesBR.seenControls', '1'); });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 180_000 });
  await page.evaluate(() => window.__piratesBR.setDayNightOverride(854));
  // Let the start ceremony finish so "idle" means idle.
  await page.waitForTimeout(12_000);

  for (const { w, h, note } of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(1200);
    const L = await readLayout();
    await page.screenshot({ path: `${OUT}/hud-${w}x${h}.png`, timeout: 60_000 });
    console.log(`\n${w}x${h} — ${note}`);

    const clashes = [];
    for (const [a, b] of L.pairs) {
      const px = overlap(a, b);
      if (px > 0) clashes.push(`${a.id} x ${b.id} = ${px}px²`);
    }
    expect(`${L.regionCount} visible regions, none overlapping`, clashes.length === 0, clashes.join('; '));
    expect(`at most ${MAX_TEXT} strings at idle`, L.strings.length <= MAX_TEXT,
      `${L.strings.length}: ${L.strings.slice(0, 40).join(' | ')}`);
    expect('the objective line is visible', L.objectiveVisible, L.objectiveText);

    // The GOLD READOUT, not the adjective: the chip's label, or any string that
    // puts a number next to the word (that is the duplication hud-07 found —
    // the chip, the objective line and the leaderboard each printed the total).
    const golds = L.strings.filter((s) => /\bgold\b/i.test(s) && (/\d/.test(s) || /^gold$/i.test(s.trim())));
    expect('the word Gold is painted once', golds.length === 1, `${golds.length}: ${golds.join(' | ')}`);

    const clocks = L.strings.filter((s) => /(^|\s)\d{1,2}:\d\d(\s|$)/.test(s));
    expect('at most one storm clock on screen', clocks.length <= 1, `${clocks.length}: ${clocks.join(' | ')}`);

    expect('no HUD chip is a fixed layer outside #hud', L.strayFixedChips.length === 0,
      L.strayFixedChips.join(', '));

    if (L.prompt) {
      const inside = L.prompt.x >= 0 && L.prompt.y >= 0
        && L.prompt.x + L.prompt.w <= L.vw + 1 && L.prompt.y + L.prompt.h <= L.vh + 1;
      expect('the prompt is inside the window', inside, JSON.stringify(L.prompt));
      const clear = !L.footer || overlap(L.prompt, L.footer) === 0;
      expect('the prompt is clear of the footer', clear,
        `prompt ${JSON.stringify(L.prompt)} footer ${JSON.stringify(L.footer)}`);
    } else {
      expect('the prompt paints when it has text', false, `promptText=${JSON.stringify(L.promptText)}`);
    }
  }
} finally {
  await browser.close();
}

console.log(failures === 0 ? '\nPASS hud-layout-probe' : `\nFAIL hud-layout-probe: ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
