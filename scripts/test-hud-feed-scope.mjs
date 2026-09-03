#!/usr/bin/env node
// THE FEED IS YOUR CREW'S, NOT THE FLEET'S.
//
// Nine bot crews dig and stow continuously, and every one of those events was
// broadcast and printed as if it were the player's own: "Chest stowed aboard:
// base 2600 gold" while she stood alone in a cave with nothing aboard
// (hud-23, liveplay-06). Any [T] press anywhere on the map put "Parley
// signaled" in all sixteen feeds (hud-29). And one sinking printed two lines
// that said the same thing back to back, pushing the line that mattered off a
// three-row panel (liveplay-23). Meanwhile the pointer-lock hint said "WASD to
// move" at the wheel, where W/S are sails (hud-26).
//
// The four rules are pure functions on Game's module surface: no DOM, no stack.
import {
  isOwnCrewActorIn, parleyConcernsMe, isDuplicateSinkLine, pointerLockHintFor,
} from '../src/client/core/Game.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const players = [
  { id: 'me', shipId: 'ship-mine' },
  { id: 'mate', shipId: 'ship-mine' },
  { id: 'bot-a', shipId: 'ship-bot' },
  { id: 'bot-b', shipId: 'ship-bot' },
  { id: 'castaway', shipId: null },
];

console.log('\nChest lines: the local crew only');
expect('my own pickup prints', isOwnCrewActorIn(players, 'me', 'ship-mine', 'me'));
expect('my crewmate stowing prints', isOwnCrewActorIn(players, 'me', 'ship-mine', 'mate'));
for (const stranger of ['bot-a', 'bot-b', 'castaway']) {
  expect(`${stranger}'s chest is silent`, !isOwnCrewActorIn(players, 'me', 'ship-mine', stranger));
}
expect('an event with no actor is silent', !isOwnCrewActorIn(players, 'me', 'ship-mine', undefined));
expect('a shipless player hears only herself',
  isOwnCrewActorIn(players, 'castaway', null, 'castaway') && !isOwnCrewActorIn(players, 'castaway', null, 'mate'));

console.log('\nParley: the two crews in it');
expect('a parley I started prints', parleyConcernsMe({ initiatorShipId: 'ship-mine', targetShipId: 'ship-bot' }, 'ship-mine'));
expect('a parley aimed at me prints', parleyConcernsMe({ initiatorShipId: 'ship-bot', targetShipId: 'ship-mine' }, 'ship-mine'));
expect('two strangers parleying is silent', !parleyConcernsMe({ initiatorShipId: 'ship-a', targetShipId: 'ship-b' }, 'ship-mine'));
expect('a bare broadcast with no session is silent', !parleyConcernsMe(null, 'ship-mine'));

console.log('\nOne sinking, one line');
const now = 10_000;
expect('the kill line for a sinking already announced is dropped',
  isDuplicateSinkLine(true, 'teal', now - 400, now));
expect('…but a second sinking by the same killer 3 s later still prints',
  !isDuplicateSinkLine(true, 'teal', now - 3000, now));
expect('a plain kill (no sinking) always prints', !isDuplicateSinkLine(false, 'teal', now - 400, now));
expect('an uncredited sinking always prints', !isDuplicateSinkLine(true, undefined, now - 400, now));
expect('a sinking nobody announced always prints', !isDuplicateSinkLine(true, 'teal', undefined, now));

console.log('\nThe pointer-lock hint names the keys of the station you are at');
expect('at the wheel it says steer, not WASD',
  pointerLockHintFor('helm').includes('steer') && !pointerLockHintFor('helm').includes('WASD'));
expect('at a gun it says aim, not move',
  pointerLockHintFor('cannon').includes('aim') && !pointerLockHintFor('cannon').includes('WASD'));
expect('on foot it still says WASD', pointerLockHintFor('foot').includes('WASD'));

console.log(failures === 0 ? '\nPASS feed scope + hint' : `\nFAIL feed scope + hint (${failures})`);
process.exit(failures === 0 ? 0 : 1);
