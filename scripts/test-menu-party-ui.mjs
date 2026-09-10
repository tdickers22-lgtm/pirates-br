#!/usr/bin/env node
/**
 * THE FRONT DOOR OF THE GAME — the party panel, graded (PARTY-01 client half).
 *
 * The bug this gate exists for is not cosmetic. Lane 2.3 moved party codes to
 * SIX characters (netcode-23: 1.07e9 codes, which is what makes the join
 * lockout a defence instead of theatre). The client was never moved with it, so
 * every path that carries a code truncated it to four:
 *
 *   • `#menu-join-code-input` had `maxlength="4"` and the input handler did
 *     `.slice(0, 4)` — a friend pasting the code off the party panel got the
 *     first four characters and "Code must be 4 characters." if they pasted
 *     six.
 *   • the `?party=CODE` deep link did `.slice(0, 4)` and then required
 *     `raw.length === 4`, so a six-character invite link was silently DROPPED —
 *     no status line, no join, nothing.
 *
 * Result: with the shipped server, nobody could join a private crew at all.
 * That is the whole Among-Us affordance the owner asked for, dark.
 *
 * The rest of PLAN §2.2 is graded here too, because each of these is a thing a
 * player looks for and does not find: ONE always-visible join field (not behind
 * a "Join With Code" toggle), a mode segmented control, a "fill with bots /
 * real players only" toggle, ready ticks + host crown + kick on roster rows,
 * and the roster grouped by the hull each member sails.
 *
 * Two halves, both cheap:
 *   1. PURE MODEL — `partyRosterModel`/`normalisePartyCode`/`isPartyCode` are
 *      exported from MenuController and driven directly (no DOM, no browser).
 *   2. DOM CONTRACT — index.html is read as text and the ids/attributes the
 *      controller binds to are asserted. `must()` throws on a missing id, so a
 *      renamed element is a black menu screen; this catches it in 0.1 s.
 *
 * node --import tsx scripts/test-menu-party-ui.mjs   (~0.3 s, no stack)
 */
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

// ── 1. The pure model ────────────────────────────────────────────────────
let menu = null;
try {
  menu = await import('../src/client/menu/MenuController.ts');
} catch (err) {
  console.error(`  (MenuController did not import: ${err.message.split('\n')[0]})`);
}
const has = (name) => !!menu && typeof menu[name] === 'function';

console.log('\nA six-character code survives every path that carries it');
expect('normalisePartyCode is exported from MenuController', has('normalisePartyCode'));
if (has('normalisePartyCode')) {
  const n = menu.normalisePartyCode;
  expect('a pasted six-character code is kept whole', n('k7m2qx') === 'K7M2QX',
    `got ${JSON.stringify(n('k7m2qx'))}`);
  expect('an invite link\'s code is not truncated to four', n('K7M2QX') === 'K7M2QX',
    `got ${JSON.stringify(n('K7M2QX'))}`);
  expect('punctuation and spaces are stripped', n(' k7-m2 qx ') === 'K7M2QX',
    `got ${JSON.stringify(n(' k7-m2 qx '))}`);
  expect('anything past six characters is dropped', n('K7M2QXZZZZ') === 'K7M2QX',
    `got ${JSON.stringify(n('K7M2QXZZZZ'))}`);
}
expect('isPartyCode is exported from MenuController', has('isPartyCode'));
if (has('isPartyCode')) {
  const ok = menu.isPartyCode;
  expect('six characters are joinable', ok('K7M2QX') === true);
  expect('four-character codes stay valid for one release (PLAN §7)', ok('K7M2') === true);
  expect('five characters are refused', ok('K7M2Q') === false);
  expect('an empty field is refused', ok('') === false);
}

console.log('\nThe roster is grouped by the hull each member sails');
expect('partyRosterModel is exported from MenuController', has('partyRosterModel'));
if (has('partyRosterModel')) {
  const model = menu.partyRosterModel;
  const members = (n) => Array.from({ length: n }, (_, i) => ({
    clientId: `c${i}`, name: `Pirate_${i}`, isHost: i === 0, ready: i % 2 === 0, atSea: false,
  }));

  const duos = model({ mode: 'duos', hostId: 'c0', members: members(2), membersAtSea: [] }, 'c0');
  expect('duos puts both hands on ONE hull', duos.groups.length === 1,
    `got ${duos.groups.length} groups`);
  expect('the hull is named from the mode ladder', duos.groups[0].hull === 'brigantine',
    `got ${duos.groups[0]?.hull}`);
  expect('the group knows it is full', duos.groups[0].label.includes('2 / 2'),
    `got ${JSON.stringify(duos.groups[0]?.label)}`);

  const overflow = model({ mode: 'duos', hostId: 'c0', members: members(3), membersAtSea: [] }, 'c0');
  expect('a third hand in Duos is flagged, not silently split',
    overflow.rows.filter((r) => r.overflow).length === 1,
    `overflow rows: ${overflow.rows.filter((r) => r.overflow).length}`);
  // The refusal must be the SERVER'S refusal, word for word: a panel that
  // says "switch to Squads" over a server that refuses Squads (available:false
  // until WIRE-01) is a client/server disagreement the player pays for at the
  // dock. LobbyServer.handleQueueJoin builds it as
  //   `${spec.label} takes ${spec.crewSize}` + `; switch to ${fits.label}`
  // with `fits` = the first AVAILABLE mode whose crewSize covers the roster.
  const pair = model({ mode: 'solo', hostId: 'c0', members: members(2), membersAtSea: [] }, 'c0');
  expect('two hands in Solo are told which mode fits, in the server\'s words',
    pair.refusal === 'Solo takes 1; switch to Duos', `got ${JSON.stringify(pair.refusal)}`);
  expect('a mode that is not open yet is never suggested (Squads, available:false)',
    !/squads/i.test(overflow.refusal ?? ''), `got ${JSON.stringify(overflow.refusal)}`);
  expect('and the overflow still says so out loud',
    (overflow.refusal ?? '').startsWith('Duos takes 2'), `got ${JSON.stringify(overflow.refusal)}`);
  expect('a fitting roster carries no refusal', duos.refusal === null,
    `got ${JSON.stringify(duos.refusal)}`);

  console.log('\nCrown, tick and kick land on the right rows');
  const squad = model({ mode: 'squads', hostId: 'c0', members: members(3), membersAtSea: ['c2'] }, 'c1');
  const byId = Object.fromEntries(squad.rows.map((r) => [r.clientId, r]));
  expect('the host wears the crown', byId.c0.isHost === true);
  expect('a crewmate does not', byId.c1.isHost === false);
  expect('ready is per member, not per party', byId.c0.ready === true && byId.c1.ready === false);
  expect('a member still at sea is marked', byId.c2.atSea === true);
  expect('a non-host may kick nobody', squad.rows.every((r) => !r.kickable),
    `kickable: ${squad.rows.filter((r) => r.kickable).map((r) => r.clientId).join(',')}`);
  const asHost = model({ mode: 'squads', hostId: 'c0', members: members(3), membersAtSea: [] }, 'c0');
  const hostRows = Object.fromEntries(asHost.rows.map((r) => [r.clientId, r]));
  expect('the host may kick a crewmate', hostRows.c1.kickable === true);
  expect('the host may not kick herself', hostRows.c0.kickable === false);
  expect('the crown may be passed to a crewmate but not to the wearer',
    hostRows.c1.crownable === true && hostRows.c0.crownable === false);
  expect('you is set on exactly one row', asHost.rows.filter((r) => r.you).length === 1);
}

// ── 2. The DOM contract ──────────────────────────────────────────────────
const html = readFileSync(`${ROOT}index.html`, 'utf8');
const hasId = (id) => new RegExp(`id="${id}"`).test(html);
/** The tag that carries `id="x"`, so attributes on it can be graded. */
function tagWithId(id) {
  const m = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
  return m ? m[0] : '';
}

console.log('\nOne visible join field, sized for the code the server issues');
expect('the join field exists', hasId('menu-join-code-input'));
expect('it takes six characters', /maxlength="6"/.test(tagWithId('menu-join-code-input')),
  `tag: ${tagWithId('menu-join-code-input')}`);
expect('the join row is not hidden behind a toggle',
  hasId('menu-join-party-row') && !/display:\s*none/.test(tagWithId('menu-join-party-row')),
  `tag: ${tagWithId('menu-join-party-row')}`);

console.log('\nThe mode picker and the bot toggle are on screen');
// The options themselves are generated from MODE_IDS at boot rather than typed
// into the markup — hardcoding a roster in index.html is exactly how the bot
// slider came to offer nine hulls against a twelve-hull fleet (netcode-17).
const ctrl = readFileSync(`${ROOT}src/client/menu/MenuController.ts`, 'utf8');
expect('the mode options are generated from MODE_IDS, not typed into the markup',
  /for \(const id of MODE_IDS\)/.test(ctrl));
expect('each option carries its mode id for the picker to read back',
  /dataset\.mode = id/.test(ctrl));
expect('an unavailable mode renders disabled instead of failing at the dock',
  /spec\.available/.test(ctrl) && /btn\.disabled = true/.test(ctrl));
expect('the picker travels with the queue request',
  /queueJoin\(this\.selectedMode\)/.test(ctrl));
expect('and with the party, so the crew agrees with the server',
  /updatePartySettings\(\{ mode: id \}\)/.test(ctrl));
expect('the main menu carries a mode control', hasId('menu-mode-control'));
expect('so does the party panel (PLAN §2.2)', hasId('lobby-mode-control'));
expect('"fill with bots / real players only" is a toggle, not a mystery slider',
  hasId('lobby-botfill-toggle'));

console.log('\nThe crew survives the match');
expect('the code chip is copyable from the party panel', hasId('lobby-copy-btn'));
expect('PLAY AGAIN WITH CREW is on the end screen', hasId('endmatch-play-again-btn'));
expect('the party panel has a ready button', hasId('lobby-ready-btn'));

// ── 3. The graphics note says when the PART, not the tier, set the ceiling ──
// (airsafe). A manual High on the owner's fanless M2 Air used to be honoured
// verbatim and locked the GPU firmware up. The tier is now a LOOK and the GPU
// class a FILL CEILING (FrameGovernor.fillCeilingForGpu); when that ceiling
// binds on a pinned or URL tier the settings note must say so, in words, so a
// player who pinned High and sees native resolution and 1536 shadows was told
// rather than left to discover it. RED on HEAD 8d5cc8db: no such note, no such
// function.
console.log('\nThe graphics note says when the Mac, not the tier, set the ceiling');
{
  const gov = await import('../src/client/rendering/FrameGovernor.ts');
  const has = (n) => typeof gov[n] === 'function';
  expect('describeFillCap and fillCapReport are exported from FrameGovernor', has('describeFillCap') && has('fillCapReport'));
  if (has('describeFillCap') && has('fillCapReport')) {
    const m2 = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';
    const air = gov.fillCapReport('high', 1470, 956, 2, 'apple-base', 2048);
    const note = gov.describeFillCap(air, m2) ?? '';
    expect(`High on the Air: "${note}"`,
      /^High look, capped for this Mac/.test(note) && /Apple M2 Air has no fan to spare/.test(note)
      && /resolution is held at native/.test(note) && /shadows at 1536/.test(note) && /locking up/.test(note));
    const max = gov.fillCapReport('high', 1470, 956, 2, 'apple-pro', 2048);
    expect('High on an M2 Max: no note at all', gov.describeFillCap(max, m2.replace('Apple M2', 'Apple M2 Max')) === null);
    const medium = gov.fillCapReport('balanced', 1470, 956, 2, 'apple-base', 1536);
    expect('Medium on the Air: no note (nothing is held; it is the tier the owner plays)', gov.describeFillCap(medium, m2) === null);
    const uhd = gov.fillCapReport('high', 1536, 864, 1.25, 'integrated', 2048);
    const uhdNote = gov.describeFillCap(uhd, 'ANGLE (Intel, Intel(R) UHD Graphics 620, D3D11)') ?? '';
    expect(`High on an Intel UHD 620: "${uhdNote}"`,
      /^High look, capped/.test(uhdNote) && /shadows at 1024/.test(uhdNote) && /multisampling is off/.test(uhdNote));
    const opq = gov.fillCapReport('high', 1470, 956, 2, 'apple-opaque', 2048);
    const opqNote = gov.describeFillCap(opq, 'Apple GPU') ?? '';
    expect(`High in Safari (opaque "Apple GPU"): "${opqNote}"`, /^High look, capped for this Mac/.test(opqNote) && /Safari/.test(opqNote));
  }
  // The panel actually prints it, and the renderer actually hands it over.
  const rendererSrc = readFileSync(`${ROOT}src/client/rendering/Renderer.ts`, 'utf8');
  expect('Renderer.getGovernorStatus exposes the fill-cap report', /fillCap:\s*this\.fillCap/.test(rendererSrc));
  expect('renderQualityNote prints describeFillCap when the ceiling binds', /describeFillCap\(/.test(ctrl) && /fillCap/.test(ctrl));
  expect('the tier options say "capped" on a machine where the class ceiling binds', /capped for this/.test(ctrl));
}

console.log(failures === 0
  ? `\nPASS — the party panel opens the door it advertises`
  : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
