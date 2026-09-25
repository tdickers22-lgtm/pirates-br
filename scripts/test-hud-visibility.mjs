#!/usr/bin/env node
// test-hud-visibility (b1.5f; mechanicshud-06/07/14, liveplay-13, vm:mechanicshud:6).
// Pure, sub-second. Grades src/client/ui/hudModel.ts against the HUD spec table
// (PLAN section 3, mechanics+HUD C) and checks that HudController actually paints
// through it:
//   1. 12 canonical contexts -> the visible set equals the spec table
//   2. <= 12 always-on elements on desktop, <= 8 on a phone, in every context
//   3. 10 contradiction rows on hudMessagePlan (priority dead > sinking >
//      flooding > outside ring > carrying loot > default; one alarm slot; no
//      banner over an emergency; the crosshair is a dot until aiming)
//   4. every UiRefs id has a writer outside UiRefs.ts (dead DOM sweep)
//   5. wiring: HudController imports the model; no "dead in the water"; the dead
//      #damage-vignette is gone; the notice, party chip and next-target exist.
// Run: node --import tsx scripts/test-hud-visibility.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
let passes = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passes++; console.log(`  ✓ ${name}`); }
  else { fails++; console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`); }
};

let M = null;
try {
  M = await import('../src/client/ui/hudModel.ts');
} catch (err) {
  check('import src/client/ui/hudModel.ts', false, String(err?.message ?? err).split('\n')[0]);
}

const base = {
  playerState: 'alive', device: 'desktop', inParty: false, nearOwnShip: false,
  atCannon: false, atHelm: false, atRepairPrompt: false, wheelHeld: false, mapOpen: false,
  aiming: false, holding: 'firearm', scopeShowing: false, alarmUp: false, bannerUp: false, serverNotice: false,
};
const ALWAYS = ['compass', 'stormLine', 'objective', 'gold', 'shipsAfloat', 'minimap', 'feed', 'health', 'weaponCard', 'crosshair', 'prompt'];
const minus = (arr, ...drop) => arr.filter((x) => !drop.includes(x));

// ── 1. the spec table ───────────────────────────────────────────────────────
const TABLE = [
  ['spawn ashore', {}, ALWAYS],
  ['on deck', { nearOwnShip: true }, [...ALWAYS, 'shipCard']],
  ['at the helm', { nearOwnShip: true, atHelm: true }, [...minus(ALWAYS, 'weaponCard', 'crosshair'), 'shipCard']],
  ['at a cannon', { nearOwnShip: true, atCannon: true }, [...minus(ALWAYS, 'weaponCard'), 'shipCard', 'stores', 'ammoDisplay']],
  ['hold flooding (repair prompt, alarm up)', { nearOwnShip: true, atRepairPrompt: true, alarmUp: true, holding: 'tool' },
    [...minus(ALWAYS, 'crosshair'), 'shipCard', 'stores', 'alarm']],
  ['swimming', { playerState: 'swimming' }, ALWAYS],
  ['outside the ring (banner wants in)', { alarmUp: true, bannerUp: true }, [...ALWAYS, 'alarm']],
  ['downed', { playerState: 'downed' }, [...minus(ALWAYS, 'crosshair'), 'downedCard']],
  ['respawn held', { playerState: 'respawning' }, [...minus(ALWAYS, 'crosshair', 'weaponCard'), 'respawnCard']],
  ['spectating', { playerState: 'eliminated' }, ['spectateBanner', 'deathBar', 'minimap', 'shipsAfloat', 'feed']],
  ['supply wheel held', { nearOwnShip: true, wheelHeld: true }, [...ALWAYS, 'shipCard', 'stores', 'supplyWheel']],
  ['map open (party)', { mapOpen: true, inParty: true }, [...minus(ALWAYS, 'crosshair'), 'crewStrip', 'partyChip', 'map']],
];
if (M) {
  for (const [name, patch, want] of TABLE) {
    const got = [...M.hudVisibility({ ...base, ...patch })].sort();
    const exp = [...new Set(want)].sort();
    check(`table: ${name}`, JSON.stringify(got) === JSON.stringify(exp), `got ${got.join(',')} want ${exp.join(',')}`);
  }
  // ── 2. budgets ────────────────────────────────────────────────────────────
  for (const [name, patch] of TABLE) {
    for (const party of [false, true]) {
      const d = M.alwaysOnCount(M.hudVisibility({ ...base, ...patch, inParty: party }));
      check(`desktop always-on <= 12: ${name}${party ? ' (party)' : ''}`, d <= 12, `${d}`);
      const p = M.alwaysOnCount(M.hudVisibility({ ...base, ...patch, inParty: party, device: 'phone' }));
      check(`phone always-on <= 8: ${name}${party ? ' (party)' : ''}`, p <= 8, `${p}`);
    }
  }
  check('stores never always-on', !M.hudVisibility(base).has('stores') && !M.hudVisibility({ ...base, nearOwnShip: true }).has('stores'));
  check('ammo once: no big ammo readout with a gun in hand', !M.hudVisibility(base).has('ammoDisplay'));

  // ── 3. contradiction rows ─────────────────────────────────────────────────
  const ms = {
    playerState: 'alive', shipSinking: false, shipLeaks: 0, shipWater: 0, shipOnFire: false,
    outsideRing: false, metresOutside: null, eyeCollapse: false, lootCarried: 0, lootSellAt: null,
    defaultObjective: 'Objective: dig a chest', sailAlarm: null, bannerRequested: null, wheelGlyph: '[1]',
  };
  const plan = (p) => M.hudMessagePlan({ ...ms, ...p });
  const rows = [
    ['dead + outside ring: no storm objective', plan({ playerState: 'eliminated', outsideRing: true, metresOutside: 80 }),
      (r) => r.tier === 'dead' && !/storm|ring/i.test(r.objective) && r.alarm === null],
    ['respawn held + sinking: dead tier, no ship alarm', plan({ playerState: 'respawning', respawnSeconds: 7, shipSinking: true }),
      (r) => r.tier === 'dead' && r.alarm === null && /7 s/.test(r.objective)],
    ['4 leaks: objective is the repair, not "dig a chest"', plan({ shipLeaks: 4, shipWater: 0.2 }),
      (r) => r.tier === 'flooding' && /patch/i.test(r.objective) && !/dig/i.test(r.objective)],
    ['4 leaks + outside ring: flooding outranks the ring', plan({ shipLeaks: 4, outsideRing: true, metresOutside: 40 }),
      (r) => r.tier === 'flooding' && /LEAK/.test(r.alarm ?? '')],
    ['sinking + 8 leaks: island banner suppressed', plan({ shipSinking: true, shipLeaks: 8, bannerRequested: 'PARLEY POINT' }),
      (r) => r.tier === 'sinking' && r.banner === null && r.alarm === 'SHIP IS SINKING'],
    ['flooding: banner suppressed', plan({ shipLeaks: 1, bannerRequested: 'PARLEY POINT' }), (r) => r.banner === null],
    ['calm: banner allowed', plan({ bannerRequested: 'PARLEY POINT' }), (r) => r.banner === 'PARLEY POINT' && r.alarm === null],
    ['outside ring: ONE alarm, objective does not repeat it', plan({ outsideRing: true, metresOutside: 120 }),
      (r) => r.tier === 'outside' && /120 m/.test(r.alarm ?? '') && !/OUTSIDE/i.test(r.objective)],
    ['carrying loot beats the default objective', plan({ lootCarried: 2, lootSellAt: 'Gull Rock' }),
      (r) => r.tier === 'loot' && /Gull Rock/.test(r.objective)],
    ['bucket hint names the wheel and the slot', plan({ shipWater: 0.3 }),
      (r) => /Hold \[1\] wheel, pick Bucket \(3\)/.test(r.objective)],
  ];
  for (const [name, r, ok] of rows) check(`contradiction: ${name}`, ok(r), JSON.stringify(r));
  check('Adrift replaces "Under way · dead in the water"', M.shipMotionWord(false, false, 0.05) === 'Adrift');
  check('crosshair: blunderbuss at rest is a dot', M.crosshairMode({ ...base, holding: 'blunderbuss' }) === 'dot');
  check('crosshair: blunderbuss aiming is the ring', M.crosshairMode({ ...base, holding: 'blunderbuss', aiming: true }) === 'ring');
}

// ── 4. dead DOM sweep: every UiRefs id has a writer ─────────────────────────
const uiRefs = readFileSync(join(ROOT, 'src/client/ui/UiRefs.ts'), 'utf8');
const keys = [...uiRefs.matchAll(/^\s{4}(\w+):\s*require/gm)].map((m) => m[1]);
const srcFiles = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts') && !p.endsWith('UiRefs.ts')) srcFiles.push(readFileSync(p, 'utf8')); } };
walk(join(ROOT, 'src/client'));
const all = srcFiles.join('\n');
check('UiRefs parsed', keys.length > 20, `${keys.length}`);
for (const k of keys) check(`UiRefs.${k} has a writer`, new RegExp(`\\bui\\.${k}\\b|\\bui\\[\\s*'${k}'`).test(all));

// ── 5. wiring ───────────────────────────────────────────────────────────────
const hud = readFileSync(join(ROOT, 'src/client/ui/HudController.ts'), 'utf8');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
check('HudController paints through hudMessagePlan', /hudMessagePlan\(/.test(hud));
check('HudController paints through hudVisibility', /hudVisibility\(/.test(hud));
check('HudController picks the crosshair via crosshairMode', /crosshairMode\(/.test(hud));
check('no "dead in the water" copy on the ship card', !/'dead in the water'/.test(hud));
check('dead #damage-vignette deleted', !/id="damage-vignette"/.test(html) && !/damageVignette/.test(uiRefs));
check('#server-notice banner exists', /id="server-notice"/.test(html));
check('#party-chip exists', /id="party-chip"/.test(html));
check('death bar has a next-target button', /id="death-next-btn"/.test(html));

// ── 6. the model drives the painters (b1.5f continuation) ────────────────────
// The ship card, the crew strip and the feed used to keep their own writers:
// the card followed any deck you stood on (an enemy's included), the strip
// showed on a phone that has no room for it. These rows fail until the model
// owns them.
if (M) {
  const near = M.shipCardNear;
  check('shipCardNear exported', typeof near === 'function');
  if (typeof near === 'function') {
    const own = { ownShipId: 's1', ownShipAlive: true, onShipId: null, metresToOwn: 500 };
    check('ship card: aboard own hull', near({ ...own, onShipId: 's1', metresToOwn: 3 }) === true);
    check('ship card: ashore 29 m from own hull', near({ ...own, metresToOwn: 29 }) === true);
    check('ship card: ashore 31 m from own hull hides it', near({ ...own, metresToOwn: 31 }) === false);
    check('ship card: on an enemy deck 500 m out hides it', near({ ...own, onShipId: 'enemy' }) === false);
    check('ship card: on an enemy deck 12 m from own hides it (it would describe their hull)', near({ ...own, onShipId: 'enemy', metresToOwn: 12 }) === false);
    check('ship card: own hull sunk hides it', near({ ...own, ownShipAlive: false, onShipId: 's1', metresToOwn: 0 }) === false);
    check('ship card: no ship of your own', near({ ...own, ownShipId: null, metresToOwn: 0 }) === false);
  }
  check('phone: feed hidden while empty', !M.hudVisibility({ ...base, device: 'phone', feedLines: 0 }).has('feed'));
  check('phone: feed shows while it has lines', M.hudVisibility({ ...base, device: 'phone', feedLines: 2 }).has('feed'));
  check('phone: crew strip stays off in a party', !M.hudVisibility({ ...base, device: 'phone', inParty: true }).has('crewStrip'));
  check('desktop: crew strip in a party', M.hudVisibility({ ...base, inParty: true }).has('crewStrip'));
  const desat = M.lowHealthDesaturation;
  check('lowHealthDesaturation exported', typeof desat === 'function');
  if (typeof desat === 'function') {
    check('desaturation: none at 100, 30 and 15 HP', desat(100) === 0 && desat(30) === 0 && desat(15) === 0, `${desat(100)},${desat(30)},${desat(15)}`);
    check('desaturation: starts below 15 HP', desat(14) > 0 && desat(14) < 0.15, `${desat(14)}`);
    check('desaturation: deep at 1 HP, never full grey', desat(1) >= 0.6 && desat(1) <= 0.85, `${desat(1)}`);
    let mono = true;
    for (let h = 15; h > 1; h -= 0.5) if (desat(h - 0.5) < desat(h)) mono = false;
    check('desaturation: monotonic as health falls', mono);
    check('desaturation: dead or unknown is 0', desat(0) === 0 && desat(NaN) === 0);
  }
}
{
  const hud6 = readFileSync(join(ROOT, 'src/client/ui/HudController.ts'), 'utf8');
  const html6 = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const fx6 = readFileSync(join(ROOT, 'src/client/rendering/CombatFx.ts'), 'utf8');
  check('HudController decides the ship card through shipCardNear', /shipCardNear\(/.test(hud6));
  for (const [id, ref] of [['shipCard', 'shipStatus'], ['crewStrip', 'crew-strip'], ['feed', 'killFeed']]) {
    check(`model paints ${id} (${ref})`, new RegExp(`\\[\\s*'${id}'\\s*,[^\\]]*${ref}`).test(hud6));
  }
  check('HudController toggles .hud-model-off', /classList\.toggle\(\s*'hud-model-off'/.test(hud6));
  check('index.html hides .hud-model-off', /\.hud-model-off\s*\{\s*display:\s*none\s*!important/.test(html6));
  check('CombatFx desaturates through the model below 15 % HP', /lowHealthDesaturation\(/.test(fx6) && /mix-blend-mode:\s*saturation/.test(fx6));
}

// ── 7. the flooding ship card (b2.2h; holes-12, mechanicshud-06, PLAN 3.6/3.9) ──
// Leaks split below the waterline / topside with a size glyph, a bilge bar with a
// trend arrow from floodingRate, "Taking water fast" at >= 50 %, a hideable
// gauge that follows the ship-card rule (own hull, aboard or within 30 m), and
// the one alarm slot keeping its priority with the fast-flood line in it.
if (M) {
  const fc = M.floodCard;
  check('floodCard exported', typeof fc === 'function');
  if (typeof fc === 'function') {
    const holes = [
      { id: 1, patched: false, size: 3, tier: 0, depth: 0.4 },   // big breach under water
      { id: 2, patched: false, size: 2, tier: 0 },               // no live depth: LOW tier = below
      { id: 3, patched: false, size: 1, tier: 2, depth: -1.2 },  // topside, dry
      { id: 4, patched: true, size: 3, tier: 0, depth: 0.5 },    // planked: not a leak
      { id: 5, patched: false, size: 1, tier: 1, depth: -0.1 },  // MID dragged into the wash margin: floods, so below
    ];
    const c = fc({ holes, waterLevel: 0.3, floodingRate: 0.004, sinking: false });
    check('flood card: below = open holes under the live surface (or LOW tier), largest first', JSON.stringify(c.below) === '[3,2,1]', JSON.stringify(c.below));
    check('flood card: topside = open holes above it', JSON.stringify(c.topside) === '[1]', JSON.stringify(c.topside));
    check('flood card: patched holes are not leaks', c.below.length + c.topside.length === 4);
    const g = M.HOLE_SIZE_GLYPH;
    check('size glyph: three distinct glyphs, small to large', Array.isArray(g) && new Set([g[1], g[2], g[3]]).size === 3 && g.slice(1).every((x) => typeof x === 'string' && x.length > 0), JSON.stringify(g));
    if (Array.isArray(g)) {
      check('flood card line: below first with its size glyphs', c.leaksLine.startsWith('BELOW') && c.leaksLine.includes(`${g[3]}${g[2]}${g[1]}`), c.leaksLine);
      check('flood card line: topside with its glyph', /TOPSIDE 1/.test(c.leaksLine) && c.leaksLine.endsWith(g[1]), c.leaksLine);
    }
    check('flood card: sound hull says so', fc({ holes: [holes[3]], waterLevel: 0, floodingRate: 0, sinking: false }).leaksLine === 'Hull sound');
    check('flood card: topside-only leaks say she is dry below', /^TOPSIDE/.test(fc({ holes: [holes[2]], waterLevel: 0, floodingRate: 0, sinking: false }).leaksLine));
    const tr = (r) => fc({ holes: [], waterLevel: 0.3, floodingRate: r, sinking: false });
    check('trend: floodingRate > 0 rises', tr(0.004).trend === 'rising' && tr(0.004).trendGlyph === '▲');
    check('trend: floodingRate < 0 falls', tr(-0.004).trend === 'falling' && tr(-0.004).trendGlyph === '▼');
    check('trend: ~0 is steady', tr(0.0001).trend === 'steady' && tr(undefined).trend === 'steady');
    check('bilge pct rounds the fill', fc({ holes: [], waterLevel: 0.456, floodingRate: 0, sinking: false }).bilgePct === 46);
    const fast = (w, r) => fc({ holes: [holes[0]], waterLevel: w, floodingRate: r, sinking: false }).fast;
    check('"Taking water fast" at 50 % rising', fast(0.5, 0.003) === true);
    check('"Taking water fast" also at 50 % steady (nobody is winning)', fast(0.62, 0) === true);
    check('not fast at 49 %', fast(0.49, 0.01) === false);
    check('not fast while the bailers are winning (no contradiction with the down arrow)', fast(0.7, -0.004) === false);
    check('FLOOD_FAST_FILL is 0.5', M.FLOOD_FAST_FILL === 0.5);
  }
  // Gauge visibility: the card rule, plus water, plus the player's option.
  const gv = (p) => M.hudVisibility({ ...base, ...p }).has('bilgeGauge');
  check('bilge gauge: aboard own hull with water', gv({ nearOwnShip: true, ownWater: 0.3 }) === true);
  check('bilge gauge: dry hull hides it', gv({ nearOwnShip: true, ownWater: 0.01 }) === false);
  check('bilge gauge: beyond 30 m / on an enemy deck hides it (nearOwnShip false)', gv({ nearOwnShip: false, ownWater: 0.6 }) === false);
  check('bilge gauge: swimming within 30 m of her keeps it (swimming back to a flooding ship)', gv({ playerState: 'swimming', nearOwnShip: true, ownWater: 0.4 }) === true);
  check('bilge gauge: the option hides it', gv({ nearOwnShip: true, ownWater: 0.6, bilgeGaugeHidden: true }) === false);
  check('bilge gauge: never for the dead', gv({ playerState: 'eliminated', nearOwnShip: true, ownWater: 0.6 }) === false && gv({ playerState: 'respawning', nearOwnShip: true, ownWater: 0.6 }) === false);
  check('bilge gauge does not count as always-on chrome', !M.ALWAYS_ON.includes('bilgeGauge'));
  check('bilge gauge pref: stored "0" hides, anything else shows', typeof M.bilgeGaugeHidden === 'function'
    && M.bilgeGaugeHidden({ getItem: () => '0' }) === true && M.bilgeGaugeHidden({ getItem: () => null }) === false
    && M.bilgeGaugeHidden({ getItem: () => { throw new Error('private mode'); } }) === false);
  // Alarm slot priority with the fast-flood line.
  const ms7 = {
    playerState: 'alive', shipSinking: false, shipLeaks: 0, shipWater: 0, shipOnFire: false,
    outsideRing: false, metresOutside: null, eyeCollapse: false, lootCarried: 0, lootSellAt: null,
    defaultObjective: 'Objective: dig a chest', sailAlarm: null, bannerRequested: null, wheelGlyph: '[1]',
  };
  const p7 = (p) => M.hudMessagePlan({ ...ms7, ...p });
  check('alarm: 2 leaks at 60 % rising says TAKING WATER FAST', /^TAKING WATER FAST/.test(p7({ shipLeaks: 2, shipWater: 0.6, shipFloodingRate: 0.003 }).alarm ?? ''), p7({ shipLeaks: 2, shipWater: 0.6, shipFloodingRate: 0.003 }).alarm);
  check('alarm: 60 % while bailing wins is not "fast"', !/FAST/.test(p7({ shipLeaks: 0, shipWater: 0.6, shipFloodingRate: -0.004 }).alarm ?? ''));
  check('alarm: 40 % rising is the plain flooding line', /^TAKING WATER ·/.test(p7({ shipLeaks: 1, shipWater: 0.4, shipFloodingRate: 0.003 }).alarm ?? ''));
  check('alarm priority: sinking outranks the fast flood', p7({ shipSinking: true, shipLeaks: 3, shipWater: 0.95, shipFloodingRate: 0.01 }).alarm === 'SHIP IS SINKING');
  check('alarm priority: fast flood outranks outside the ring', /FAST/.test(p7({ shipLeaks: 2, shipWater: 0.7, shipFloodingRate: 0.01, outsideRing: true, metresOutside: 50 }).alarm ?? ''));
  check('alarm priority: fast flood outranks fire aboard (one slot)', /FAST/.test(p7({ shipLeaks: 2, shipWater: 0.7, shipFloodingRate: 0.01, shipOnFire: true }).alarm ?? ''));
  check('alarm priority: dead shows no flood alarm', p7({ playerState: 'eliminated', shipLeaks: 2, shipWater: 0.7, shipFloodingRate: 0.01 }).alarm === null);
}
{
  const hud7 = readFileSync(join(ROOT, 'src/client/ui/HudController.ts'), 'utf8');
  check('HudController paints the leaks line through floodCard', /floodCard\(/.test(hud7));
  check('HudController gates the gauge on the model (bilgeGauge)', /has\('bilgeGauge'\)/.test(hud7));
  check('the old 80 m overboard gauge rule is gone', !/overboard[\s\S]{0,400}<\s*80\b/.test(hud7));
  check('HudController passes floodingRate to the message plan', /shipFloodingRate:/.test(hud7));
  check('Settings gets a "Show bilge gauge" option', /settings-bilge-gauge/.test(hud7) && /settings-controls-mount/.test(hud7));
  // Every flood gate runs in the quick tier (holes-12).
  const suites = readFileSync(join(ROOT, 'scripts/lib/suites.mjs'), 'utf8');
  for (const s of ['test-flooding.mjs', 'test-flood-model.mjs', 'test-flood-trim.mjs', 'test-hold-wading.mjs', 'test-hud-visibility.mjs']) {
    check(`quick tier runs ${s}`, new RegExp(`quick\\(\\s*tsx\\('${s.replace('.', '\\.')}'\\)`).test(suites));
  }
  const inv = readFileSync(join(ROOT, 'docs/TEST_SUITE_INVENTORY.md'), 'utf8');
  for (const s of ['test-flooding.mjs', 'test-flood-model.mjs', 'test-flood-trim.mjs', 'test-hold-wading.mjs']) {
    check(`inventory row for ${s} says quick`, new RegExp(`^\\|\\s*${s.replace('.', '\\.')}\\s*\\|\\s*quick`, 'm').test(inv));
  }
}

console.log(`test-hud-visibility: ${passes} pass, ${fails} fail`);
process.exit(fails ? 1 : 0);
