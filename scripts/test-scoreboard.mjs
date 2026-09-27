#!/usr/bin/env node
/**
 * test-scoreboard (b3.5f; vm:mechanicshud:4, crossdevice-01, PLAN D13).
 *
 * Grades the in-match scoreboard and the connection pill as a pure model:
 *  1. Ordering: live crews first (afloat, then pirates in play, then kills,
 *     then name), out crews after with their FINAL place (first out = last).
 *  2. Input-scheme icons (D13 aim-assist transparency): bots BOT, mouse KB
 *     without assist, pad/touch with assist, the local row follows the live
 *     scheme, unknown before the first input.
 *  3. Header counts (ships afloat excludes sinking hulls, crews in play).
 *  4. CrewOutTracker keeps the drop-out order; ordinal() 1st..23rd.
 *  5. Hold: Tab and touch show at once, gamepad View only after 400 ms (a tap
 *     stays the chart), and the hold fires its "shown" edge once.
 *  6. Connection pill: hidden <= 150 ms, warn above, red above 300 ms,
 *     hysteresis down to 130 ms, loss (>= 500 ms without a snapshot) = red
 *     "Connection unstable" held 2.5 s after snapshots resume.
 *  7. Names are HTML-escaped (other players choose them).
 *  8. Wiring: the scheme rides PlayerInput and is whitelisted by the server
 *     (parseInputScheme), bots never get one, Game sends it and dispatches Tab,
 *     the touch Crews button exists, HudController paints the board.
 *
 * Run: node --import tsx scripts/test-scoreboard.mjs
 */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(`  FAIL ${msg}`); } };
const read = (p) => { try { return fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'); } catch { return ''; } };

let S = null;
try { S = await import('../src/client/ui/Scoreboard.ts'); } catch (e) { console.log(`  FAIL Scoreboard.ts does not load: ${e.message.split('\n')[0]}`); fail++; }
let C = null;
try { C = await import('../src/shared/constants/index.ts'); } catch { /* reported below */ }

const player = (id, name, kills, state = 'alive', extra = {}) => ({ id, name, kills, state, isBot: false, ...extra });
const ship = (id, sinking = false, sinkProgress = 0) => ({ id, sinking, sinkProgress });
const crew = (id, name, shipId, memberIds, color = 0x3366cc) => ({ id, name, color, shipId, memberIds, leaderId: memberIds[0] });

if (S) {
  // ── 1. ordering ──
  const crews = [
    crew('c1', 'Early Out', null, ['p1']),
    crew('c2', 'Swimmers', 's2', ['p2', 'p3']),
    crew('c3', 'Sloop', 's3', ['p4', 'p5']),
    crew('c4', 'Late Out', null, ['p6']),
    crew('c5', 'Brig', 's5', ['p7', 'p8']),
  ];
  const players = [
    player('p1', 'Anne', 0, 'eliminated'),
    player('p2', 'Bart', 4, 'swimming'), player('p3', 'Cora', 1, 'eliminated'),
    player('p4', 'Dirk', 1), player('p5', 'Edda', 0, 'downed'),
    player('p6', 'Finn', 3, 'eliminated'),
    player('p7', 'Gale', 0, 'alive', { isBot: true }), player('p8', 'Hugo', 2, 'alive', { inputScheme: 'gamepad' }),
  ];
  const ships = [ship('s2', true, 1), ship('s3'), ship('s5'), ship('sX', false, 0.4)];
  const tracker = new S.CrewOutTracker();
  tracker.observe(crews, players.map((p) => (p.id === 'p6' ? { ...p, state: 'alive' } : p)));
  tracker.observe(crews, players);
  tracker.observe(crews, players);
  ok(JSON.stringify(tracker.order) === '["c1","c4"]', `out order recorded once in drop-out order, got ${JSON.stringify(tracker.order)}`);
  const m = S.buildScoreboard({ crews, players, ships, localPlayerId: 'p4', localScheme: 'touch', outOrder: tracker.order });
  const order = m.rows.map((r) => `${r.placement}:${r.crewId}`).join(' ');
  ok(order === '1:c5 2:c3 3:c2 4:c4 5:c1', `ordering + placement, got ${order}`);
  // c3 and c5 are both afloat with 2 in play: kills break the tie (Brig 2 > Sloop 1).
  ok(m.rows[0].crewId === 'c5', 'tie on afloat + pirates in play is broken by kills (Brig 2 > Sloop 1)');
  ok(m.shipsAfloat === 3, `ships afloat excludes the sinking hull (3), got ${m.shipsAfloat}`);
  ok(m.crewsInPlay === 3 && m.crewsTotal === 5, `crews in play 3/5, got ${m.crewsInPlay}/${m.crewsTotal}`);
  const c2 = m.rows.find((r) => r.crewId === 'c2');
  ok(c2 && c2.inPlay && !c2.afloat && c2.membersInPlay === 1 && c2.kills === 5, 'sunk crew with a swimmer is in play, not afloat, kills summed over members incl. the dead');
  ok(c2 && c2.members[0].name === 'Bart', 'members sorted by kills');
  const c3 = m.rows.find((r) => r.crewId === 'c3');
  ok(c3 && c3.isLocal && c3.members.find((x) => x.id === 'p4').isLocal, 'local crew and local pirate flagged');
  // name breaks a full tie
  const tie = S.buildScoreboard({ crews: [crew('a', 'Zed', 'sa', ['z']), crew('b', 'Amy', 'sb', ['y'])], players: [player('z', 'Z', 1), player('y', 'Y', 1)], ships: [ship('sa'), ship('sb')], localPlayerId: null, localScheme: null, outOrder: [] });
  ok(tie.rows[0].name === 'Amy', 'a full tie is broken by crew name');
  // an out crew the tracker never saw takes the worst place
  const late = S.buildScoreboard({ crews, players, ships, localPlayerId: null, localScheme: null, outOrder: ['c4'] });
  ok(late.rows.map((r) => `${r.placement}:${r.crewId}`).slice(3).join(' ') === '4:c4 5:c1', 'unrecorded out crew placed after recorded ones');

  // ── 2. scheme icons ──
  const icon = (id) => m.rows.flatMap((r) => r.members).find((x) => x.id === id).scheme;
  ok(icon('p7') === 'bot', 'bot wears BOT');
  ok(icon('p8') === 'gamepad', 'remote gamepad echoed from the server');
  ok(icon('p4') === 'touch', 'local row follows the live local scheme');
  ok(icon('p1') === 'unknown', 'human with no reported scheme = unknown');
  ok(S.SCHEME_ICONS.gamepad.aimAssist && S.SCHEME_ICONS.touch.aimAssist, 'pad and touch disclose aim assist');
  ok(!S.SCHEME_ICONS.mouse.aimAssist && !S.SCHEME_ICONS.bot.aimAssist, 'mouse and bot carry no aim assist');
  ok(new Set(Object.values(S.SCHEME_ICONS).map((i) => i.badge)).size === 5, 'five distinct badges');
  ok(Object.values(S.SCHEME_ICONS).every((i) => !/[–—]/.test(i.label)), 'no dashes in labels');
  ok(S.schemeIconFor({ id: 'p9', isBot: false, inputScheme: 'mouse' }, 'p9', null) === 'mouse', 'local with no live scheme falls back to echoed');

  // ── 3/4. ordinal ──
  ok(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd'].join() === [1, 2, 3, 4, 11, 12, 13, 21, 22, 23].map(S.ordinal).join(), 'ordinals');

  // ── 5. hold ──
  const h = new S.ScoreboardHold();
  ok(!h.visible, 'hidden at rest');
  h.set('key', true); ok(h.visible, 'Tab shows at once'); h.set('key', false); ok(!h.visible, 'Tab release hides');
  ok(!h.pad(true, 1000) && !h.visible, 'View press does not show');
  ok(!h.pad(true, 1399) && !h.visible, 'View 399 ms: still the chart tap');
  ok(h.pad(true, 1400) && h.visible, 'View 400 ms: board shows, shown edge fires');
  ok(!h.pad(true, 1600) && h.visible, 'shown edge fires once');
  ok(!h.pad(false, 1700) && !h.visible, 'View release hides');
  ok(!h.pad(true, 2000) && !h.pad(false, 2200) && !h.visible, 'a short View tap never shows the board');
  h.set('touch', true); h.set('key', true); h.set('touch', false); ok(h.visible, 'sources are independent');
  h.clear(); ok(!h.visible, 'clear hides');
  ok(S.PAD_VIEW_HOLD_MS === 400 && S.PAD_VIEW_BUTTON === 8, 'View = standard button 8, 400 ms like GamepadSource.HOLD_MS');

  // ── 6. connection pill ──
  const p = new S.ConnectionPill();
  ok(p.update(null, 30, 0).level === 'hidden', 'no RTT yet: hidden');
  ok(p.update(90, 30, 100).level === 'hidden', '90 ms hidden');
  ok(p.update(150, 30, 200).level === 'hidden', '150 ms exactly: hidden (strictly above)');
  let v = p.update(151, 30, 300);
  ok(v.level === 'warn' && v.text === 'High ping 151 ms', `151 ms warn, got ${JSON.stringify(v)}`);
  ok(p.update(140, 30, 400).level === 'warn', 'hysteresis: 140 ms keeps the pill');
  ok(p.update(131, 30, 500).level === 'warn', 'hysteresis: 131 ms keeps the pill');
  ok(p.update(129, 30, 600).level === 'hidden', 'below 130 ms hides');
  ok(p.update(301, 30, 700).level === 'bad', 'above 300 ms turns red');
  ok(p.update(60, 30, 800).level === 'hidden', 'fast again: hidden');
  ok(p.update(60, 499, 900).level === 'hidden', '499 ms gap is not loss');
  v = p.update(60, 500, 1000);
  ok(v.level === 'bad' && v.text.startsWith('Connection unstable'), `500 ms gap = loss, got ${JSON.stringify(v)}`);
  ok(p.update(60, 20, 3000).level === 'bad', 'loss held 2.5 s after snapshots resume');
  ok(p.update(60, 20, 3501).level === 'hidden', 'then hides');
  ok(p.update(null, 800, 4000).text === 'Connection unstable', 'loss without an RTT still reports');
  ok(S.RTT_WARN_MS === 150 && S.RTT_CLEAR_MS < S.RTT_WARN_MS && S.LOSS_GAP_MS === 500, 'thresholds exported');

  // ── 7. escaping ──
  const evil = S.buildScoreboard({ crews: [crew('e', '<b>x</b>', 'se', ['q'])], players: [player('q', '<img src=x onerror=alert(1)>', 0)], ships: [ship('se')], localPlayerId: null, localScheme: null, outOrder: [] });
  const html = S.renderScoreboardHtml(evil);
  ok(!html.includes('<img') && !html.includes('<b>x'), 'crew and pirate names are escaped');
  ok(html.includes('Ships afloat 1') && html.includes('1st'), 'header + placement rendered');
  ok(S.renderScoreboardHtml(m).includes('class="sch aa"'), 'aim-assist badge styled apart');
}

// ── 8. wiring ──
ok(C && typeof C.parseInputScheme === 'function', 'shared parseInputScheme exported');
if (C?.parseInputScheme) {
  ok(['mouse', 'gamepad', 'touch'].every((x) => C.parseInputScheme(x) === x), 'valid schemes pass');
  ok([undefined, null, 'bot', 1, {}, 'MOUSE'].every((x) => C.parseInputScheme(x) === null), 'anything else is dropped');
}
const types = read('src/shared/types/index.ts');
ok((types.match(/inputScheme\?: 'mouse' \| 'gamepad' \| 'touch';/g) ?? []).length === 2, 'Player.inputScheme and PlayerInput.inputScheme typed');
const match = read('src/server/core/Match.ts');
const inputCase = match.slice(match.indexOf("case 'player_input':"), match.indexOf("case 'shop_buy':"));
ok(/parseInputScheme\(/.test(inputCase) && /!schemePlayer\.isBot/.test(inputCase), 'server whitelists the scheme and never stamps a bot');
const game = read('src/client/core/Game.ts');
ok(/input\.inputScheme = this\.input\.scheme\.current/.test(game), 'Game sends the live scheme with every input');
ok(/setScoreboardKey\(/.test(game) && /'Tab'/.test(game), 'Game dispatches Tab hold to the scoreboard');
ok(/getLatencyMs: \(\) => this\.network\.getLatencyMs\(\)/.test(game), 'Game hands the heartbeat RTT to the HUD');
ok(/onPadScoreboardShown/.test(game), 'Game closes the chart a View hold opened');
ok(/resetScoreboard\(\)/.test(game), 'Game hides board and pill when the round resets');
const touch = read('src/client/input/TouchControls.ts');
ok(/dataset\.touch = 'scoreboard'/.test(touch) && /export function touchScoreboardHeld/.test(touch), 'touch Crews hold button');
// b3-device-01: a phone-landscape board fits 12 Solo / 9 Duos crews (compact
// block: smaller font, members on one wrapped line) and keeps the local row in
// view when it still overflows (the held board takes no scroll input).
const sbSrc = read('src/client/ui/Scoreboard.ts');
const compact = sbSrc.match(/@media \(max-height:500px\)\{([^]*?)\n\}\n/);
ok(!!compact && /#scoreboard\{[^}]*font:calc\(11px/.test(compact[1]) && /#scoreboard td:last-child\{[^}]*flex-wrap:wrap/.test(compact[1]),
  'phone landscape: compact board (11 px, members on one wrapped line)');
ok(/keepLocalRowInView\(/.test(sbSrc) && /scrollTop\s*=/.test(sbSrc), 'an overflowing board scrolls the local crew row into view');
// b3-device-02: the pill lives in the HUD's top-right region (flows under the
// player count, left of the phone minimap), not a fixed box under #hud.
ok(/getElementById\('hud-top-right'\)/.test(sbSrc) && /#hud-top-right>#net-pill\{[^}]*position:static/.test(sbSrc),
  'connection pill mounts in #hud-top-right, clear of the minimap and above nothing');
const hud = read('src/client/ui/HudController.ts');
ok(/updateHud\(\) \{\s*this\.updateScoreboard\(\);/.test(hud), 'HudController paints the board every HUD repaint');

console.log(`\n${fail || !pass ? "FAIL" : "PASS"} test-scoreboard: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
