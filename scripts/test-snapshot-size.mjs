#!/usr/bin/env node
// Wire-size guard: the split/quantized snapshot protocol exists because full
// 83-210KB JSON at 31Hz starved clients (~1s snapshot age). Keep the quantized
// full under 35KB and the 31Hz hot payload under 8KB for a 10-ship match so a
// regression here is caught before it ships.
import { Match } from '../src/server/core/Match.ts';
import { buildHotSnapshot, buildWireSnapshot } from '../src/server/core/snapshot.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const match = new Match({ matchId: 'wire-size-test', botCount: 9 });
// Let the sim genuinely run so projectiles/wakes/attitudes populate.
for (let i = 0; i < 250; i++) match.tick(1 / 62.5);

const full = JSON.stringify(buildWireSnapshot(match.buildSnapshot(false), false));
const fullWithWorld = JSON.stringify(buildWireSnapshot(match.buildSnapshot(true), true));
const hot = JSON.stringify(buildHotSnapshot(match.state, match.t));

console.log(`  sizes: hot=${(hot.length / 1024).toFixed(1)}KB full=${(full.length / 1024).toFixed(1)}KB full+world=${(fullWithWorld.length / 1024).toFixed(1)}KB`);
expect('31Hz hot payload stays tiny (<8KB)', hot.length < 8 * 1024, `${hot.length}B`);
expect('10Hz quantized full stays lean (<35KB)', full.length < 35 * 1024, `${full.length}B`);
expect('static-world full stays sane (<250KB, rides ~1/20s + join)', fullWithWorld.length < 250 * 1024, `${fullWithWorld.length}B`);
expect('statics stripped from ordinary fulls', !full.includes('"caves"'), 'islands leaked into a non-world snapshot');

// HEADROOM, said out loud. The static-world payload is the one budget in this
// suite that is nearly spent, and a pass/fail line hides that: it reads exactly
// the same at 180KB and at 249KB. Whoever adds the next island, cave system or
// prop registry field should see the wall coming in the same output that tells
// them they cleared it.
const WORLD_CEILING = 250 * 1024;
const headroom = WORLD_CEILING - fullWithWorld.length;
console.log(
  `  headroom: static-world full has ${(headroom / 1024).toFixed(1)}KB left under the 250KB ceiling `
  + `(${(100 - (fullWithWorld.length / WORLD_CEILING) * 100).toFixed(1)}% free)`
  + `${headroom < 20 * 1024 ? '  ⚠ under 20KB — the next world addition will need the protocol widened, not the ceiling raised' : ''}`,
);

if (failures > 0) { console.error(`\n${failures} wire-size assertion(s) failed.`); process.exit(1); }
console.log('\nAll wire-size assertions passed.');
