#!/usr/bin/env node
// CLIMB VERBS — [X] at a ladder must actually grant the climb.
//
// Three verbs move a pirate vertically and each one runs the full client→server
// contract: the HUD picks a kind, it rides player_input.interactIntent, the
// server RE-VALIDATES it in sanitizeInput and dispatches in tryInteractIntent.
// A verb that falls out of VALID_INTERACT_INTENTS is silently nulled on the
// wire — the prompt still shows and the press does nothing. So this drives the
// real applyInput path and asserts the grant, and it asserts the wire whitelist
// covers EVERY intent the dispatcher handles.
import { readFileSync } from 'node:fs';
import { Match } from '../src/server/core/Match.ts';
import { SHIP_STATS } from '../src/shared/constants/index.ts';
import { getNearestShipBoardingLadder, getIslandDockSwimLadderPoint, getMainMastLocalZ } from '../src/shared/utils/index.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

console.log('Climb verbs ([X] → interactIntent → server grant)');

// ── The wire whitelist must cover every intent the dispatcher answers ───────
{
  const types = readFileSync(new URL('../src/shared/types/index.ts', import.meta.url), 'utf8');
  const declared = new Set(
    (types.match(/export type InteractIntent =([\s\S]*?);/)?.[1] ?? '')
      .split('|').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
  );
  const match = readFileSync(new URL('../src/server/core/Match.ts', import.meta.url), 'utf8');
  const whitelisted = new Set(
    (match.match(/VALID_INTERACT_INTENTS[^=]*=\s*new Set<InteractIntent>\(\[([\s\S]*?)\]\)/)?.[1] ?? '')
      .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
  );
  expect('the InteractIntent union is non-empty (parser still matches)', declared.size > 5, `${declared.size}`);
  const missing = [...declared].filter((intent) => !whitelisted.has(intent));
  expect('every declared InteractIntent survives sanitizeInput', missing.length === 0,
    `dropped on the wire: ${missing.join(', ')}`);
  const stray = [...whitelisted].filter((intent) => !declared.has(intent));
  expect('the whitelist has no intents the type does not declare', stray.length === 0, stray.join(', '));
}

// ── The three climbs, through the real applyInput ───────────────────────────
const ws = { readyState: 1, bufferedAmount: 0, send() {}, close() {} };
const match = new Match({ matchId: 'climb-verbs', botCount: 0 });
const { playerId, shipId } = match.addHumanClient(ws, 'Climber');
const state = match['state'];
const client = match['clients'].get(playerId);
const player = match['playersById'].get(playerId);
const ship = state.ships.find((s) => s.id === shipId);

let seq = 0;
function press(intent) {
  return {
    seq: (seq += 1), ts: 0,
    forward: false, back: false, left: false, right: false, jump: false, jumpPressed: false,
    fire: false, useItem: false, crouch: false, aim: false, interact: true, interactHeld: true,
    anchor: false, sailRaise: false, sailLower: false, sailLeft: false, sailRight: false,
    trade: false, reload: false, placeKeg: false, dropChest: false, specialAttack: false,
    slot: null, cannonAmmo: null, yaw: 0, pitch: 0, wheelIndex: null, useWheelItem: false,
    barrelTakeAll: false, interactIntent: intent,
  };
}

// [X] Climb Ladder — from the water/shore beside a hull's side ladder.
{
  const ladder = getNearestShipBoardingLadder(ship, player.position);
  player.state = 'swimming';
  player.onShipId = null;
  player.nearShipId = ship.id;
  player.mastClimb = null;
  player.position = { x: ladder.x, y: 0, z: ladder.z };
  match['t'] = 100;
  match['applyInput'](client, press('board'), 1 / 30);
  const deckY = ship.position.y + SHIP_STATS[ship.type].height;
  expect('[X] at a ship side ladder boards the deck',
    player.onShipId === ship.id && player.state === 'alive' && player.position.y > deckY,
    `onShipId=${player.onShipId} state=${player.state} y=${player.position.y.toFixed(2)} deckY=${deckY.toFixed(2)}`);
}

// [X] Climb the Mast — standing at the mainmast foot on your own deck.
{
  const stats = SHIP_STATS[ship.type];
  const mastZ = getMainMastLocalZ(stats);
  const cos = Math.cos(ship.rotation);
  const sin = Math.sin(ship.rotation);
  player.state = 'alive';
  player.onShipId = ship.id;
  player.mastClimb = null;
  player.atCrowNest = false;
  player.position = {
    x: ship.position.x + mastZ * sin,
    y: ship.position.y + stats.height + 0.4,
    z: ship.position.z + mastZ * cos,
  };
  match['t'] = 200;
  match['applyInput'](client, press('crow'), 1 / 30);
  expect('[X] at the mainmast starts the mast climb', player.mastClimb === 0, `mastClimb=${player.mastClimb}`);
}

// [X] Climb Dock Ladder — treading water at every dock's swim-up point.
{
  let refused = 0;
  const detail = [];
  for (const island of state.islands) {
    if (!island.dock) continue;
    const point = getIslandDockSwimLadderPoint(island.dock);
    player.state = 'swimming';
    player.onShipId = null;
    player.mastClimb = null;
    player.atCrowNest = false;
    player.position = { x: point.x, y: 0, z: point.z };
    match['t'] += 10;
    match['applyInput'](client, press('dock'), 1 / 30);
    const onDeck = player.state === 'alive'
      && Math.abs(player.position.y - (island.dock.position.y + 0.52)) < 0.01;
    if (!onDeck) { refused += 1; detail.push(`${island.name}: state=${player.state} y=${player.position.y.toFixed(2)}`); }
  }
  expect('[X] at every dock swim-ladder climbs onto the deck', refused === 0, detail.join('\n     '));
}

if (failures > 0) {
  console.error(`\n${failures} climb-verb assertion(s) failed.`);
  process.exit(1);
}
console.log('\nEvery ladder answers the [X].');
