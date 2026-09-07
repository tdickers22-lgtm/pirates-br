#!/usr/bin/env node
/**
 * THE HUD FINALLY SAYS "CREW" (CREWHUD-01: hud-21, netcode-13, liveplay-16).
 *
 * Menu, lobby and end board all speak of crews. The HUD did not have the word
 * in it. A pirate in Duos or Squads could not answer "where is my mate, is she
 * alive, is she at the wheel" other than by turning round and looking for her,
 * and every nameplate in the match was the same white — so on a crowded deck
 * your crewmate looked exactly like the boarder standing next to her.
 *
 * Graded here, all pure, no browser:
 *   • who counts as a crewmate (crewId when the wire has one, the shared hull
 *     when it does not — and NOT every shipwrecked pirate in the match, which
 *     is what a naive `a.shipId === b.shipId` does when both are null);
 *   • the station each hand is at, and the order the strip is read in (a
 *     downed mate before a mate at the wheel);
 *   • the strip's DOM contract and its 2 Hz / signature throttle, because the
 *     strip is on screen for the whole match and an innerHTML rewrite every
 *     frame is a per-frame allocation in the hottest loop the client has.
 *
 * node --import tsx scripts/test-crew-ui.mjs   (~0.3 s, no stack)
 */
import { readFileSync } from 'node:fs';
import { crewStation, crewStripRows, isCrewmate } from '../src/client/ui/crewStrip.ts';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const pirate = (over = {}) => ({
  id: 'p', name: 'Pirate', crewId: null, shipId: null, onShipId: null,
  position: { x: 0, y: 0, z: 0 }, health: 100, state: 'alive',
  atHelm: false, atCannon: false, reviveProgress: 0, ...over,
});

console.log('\nWho is on my crew');
{
  const me = pirate({ id: 'me', crewId: 'crew-a', shipId: 's1' });
  expect('a crewmate shares the crew record',
    isCrewmate(me, pirate({ id: 'b', crewId: 'crew-a', shipId: 's1' })) === true);
  expect('another crew on the same seas is not',
    isCrewmate(me, pirate({ id: 'c', crewId: 'crew-b', shipId: 's2' })) === false);
  expect('and neither is a boarder standing on MY deck',
    isCrewmate(me, pirate({ id: 'd', crewId: 'crew-b', shipId: 's1' })) === false);
  expect('I am never in my own strip', isCrewmate(me, me) === false);

  const noCrewRecord = pirate({ id: 'me', crewId: null, shipId: 's1' });
  expect('with no crew record the shared hull is the crew',
    isCrewmate(noCrewRecord, pirate({ id: 'b', crewId: null, shipId: 's1' })) === true);
  expect('TWO SHIPWRECKED PIRATES ARE NOT CREWMATES (both shipId null)',
    isCrewmate(pirate({ id: 'me' }), pirate({ id: 'b' })) === false);
}

console.log('\nWhat each hand is doing');
{
  expect('at the wheel', crewStation(pirate({ atHelm: true })) === 'helm');
  expect('at a gun', crewStation(pirate({ atCannon: true })) === 'gun');
  expect('in the water', crewStation(pirate({ state: 'swimming' })) === 'swim');
  expect('on the deck', crewStation(pirate({ onShipId: 's1' })) === 'deck');
  expect('ashore', crewStation(pirate({})) === 'ashore');
  expect('a downed mate is DOWNED even if she was at the wheel',
    crewStation(pirate({ state: 'downed', atHelm: true })) === 'downed');
  expect('out of the match', crewStation(pirate({ state: 'eliminated' })) === 'out');
}

console.log('\nThe strip is read top-down: help first, then nearest');
{
  const me = pirate({ id: 'me', crewId: 'k', shipId: 's1' });
  const rows = crewStripRows([
    me,
    pirate({ id: 'far', name: 'Far', crewId: 'k', shipId: 's1', onShipId: 's1', position: { x: 60, y: 0, z: 0 } }),
    pirate({ id: 'near', name: 'Near', crewId: 'k', shipId: 's1', onShipId: 's1', position: { x: 4, y: 0, z: 0 } }),
    pirate({ id: 'down', name: 'Down', crewId: 'k', shipId: 's1', state: 'downed', position: { x: 90, y: 0, z: 0 }, reviveProgress: 0.4 }),
    pirate({ id: 'enemy', name: 'Enemy', crewId: 'other', shipId: 's2', position: { x: 1, y: 0, z: 0 } }),
  ], me, { camera: { x: 0, z: 0 }, maxHealth: 100 });

  expect('the enemy is not in the strip', !rows.some((r) => r.id === 'enemy'),
    `ids: ${rows.map((r) => r.id).join(',')}`);
  expect('nor am I', !rows.some((r) => r.id === 'me'));
  expect('three crewmates listed', rows.length === 3, `got ${rows.length}`);
  expect('the downed mate is first even though she is furthest away',
    rows[0].id === 'down', `order: ${rows.map((r) => r.id).join(',')}`);
  expect('then the nearest', rows[1].id === 'near', `order: ${rows.map((r) => r.id).join(',')}`);
  expect('distance is metres from the camera', rows[1].distance === 4, `got ${rows[1].distance}`);
  expect('bearing is a compass angle', rows[1].bearing === 90, `got ${rows[1].bearing}`);
  expect('a revive in progress is shown', rows[0].reviving === 0.4, `got ${rows[0].reviving}`);
  expect('health is a fraction of maximum', rows[1].health === 1, `got ${rows[1].health}`);
  expect('every row carries a station glyph', rows.every((r) => r.glyph.length > 0));

  const solo = crewStripRows([pirate({ id: 'me', shipId: 's1' })], pirate({ id: 'me', shipId: 's1' }),
    { camera: { x: 0, z: 0 }, maxHealth: 100 });
  expect('Solo has an empty strip, not a fleet list', solo.length === 0, `got ${solo.length}`);
}

console.log('\nThe strip on screen, and what it costs');
{
  const html = readFileSync(`${ROOT}index.html`, 'utf8');
  expect('the strip is in the HUD\'s TOP-LEFT region (PLAN 2.6)',
    /id="hud-top-left"[\s\S]{0,900}id="crew-strip"/.test(html));
  expect('it starts hidden, so Solo pays nothing for it',
    /id="crew-strip"[^>]*display:\s*none/.test(html));
  const hud = readFileSync(`${ROOT}src/client/ui/HudController.ts`, 'utf8');
  expect('it is painted at 2 Hz, not every frame',
    /crewStripAt < 500/.test(hud));
  expect('and only when something a player can see changed (signature guard)',
    /sig === this\.crewStripSig\) return/.test(hud));
  expect('player names are escaped before they reach innerHTML',
    /escapeCrewName\(r\.name\)/.test(hud));
  const game = readFileSync(`${ROOT}src/client/core/Game.ts`, 'utf8');
  expect('a crewmate\'s nameplate is tinted in the crew colour',
    /isCrewmate\(me, player\)/.test(game) && /color\.setHex\(tint\)/.test(game));
  expect('and the tint is written only when it CHANGES, never per frame',
    /userData\.plateTint !== tint/.test(game));
}

console.log(failures === 0
  ? '\nPASS — the HUD knows who your crew is'
  : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
