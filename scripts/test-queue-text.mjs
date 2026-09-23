#!/usr/bin/env node
// b1-ask-02: the queue panel reads the server's position / ETA / at-capacity /
// late-join fields and never parks on a raw "0s"; a late joiner gets the D10
// line on match_start. Pure strings (src/client/menu/queueText.ts) + wiring
// greps so the panel and the HUD cannot silently stop calling them.
//   npx tsx scripts/test-queue-text.mjs
import { readFileSync } from 'node:fs';
const failures = [];
let checks = 0;
const expect = (ok, label, got = '') => { checks += 1; console.log(`  ${ok ? '✓' : '✗ FAIL:'} ${label}${ok ? '' : `  (${got})`}`); if (!ok) failures.push(label); };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

let mod = null;
try { mod = await import('../src/client/menu/queueText.ts'); } catch (e) { expect(false, 'queueText module loads', String(e).slice(0, 120)); }
if (mod) {
  const { queueLines, lateJoinNotice } = mod;
  const full = queueLines({ inQueue: 1, needed: 1, secondsRemaining: 0, starting: false, atCapacity: true, position: 3, etaSeconds: null });
  expect(/#3 in line/.test(full.status), 'at capacity: the status names the place in line', full.status);
  expect(/free berth/.test(full.detail) && !/\b0s\b/.test(full.detail), 'at capacity, no ETA: "waiting for a free berth", never "0s"', full.detail);
  const eta = queueLines({ inQueue: 2, needed: 4, secondsRemaining: 0, starting: false, atCapacity: true, position: 1, etaSeconds: 42 });
  expect(/about 42s/.test(eta.detail), 'at capacity with an ETA: "about 42s"', eta.detail);
  const late = queueLines({ inQueue: 1, needed: 1, secondsRemaining: 0, starting: false, atCapacity: true, position: 1, etaSeconds: null, lateJoinWindowSec: 25 });
  expect(/in progress/.test(late.detail) && /25s/.test(late.detail), 'at capacity with a late-join window: says a voyage in progress takes crews', late.detail);
  const normal = queueLines({ inQueue: 1, needed: 4, secondsRemaining: 0, starting: false, etaSeconds: 12 });
  expect(/1 \/ 4 pirates/.test(normal.detail) && /12s/.test(normal.detail), 'normal queue: uses the server etaSeconds, not the stale clock', normal.detail);
  const zero = queueLines({ inQueue: 1, needed: 4, secondsRemaining: 0, starting: false });
  expect(!/\b0s\b/.test(zero.detail), 'normal queue at 0: never prints a raw "0s"', zero.detail);
  expect(![full, eta, late, normal, zero].some((l) => /[–—]/.test(l.status + l.detail)), 'no em/en dashes in queue copy');
  expect(lateJoinNotice({ stormPhase: 2, sinceHornSec: 40 }) === 'Joined a voyage in progress (storm phase 2)', 'late join: D10 line with the storm phase', lateJoinNotice({ stormPhase: 2, sinceHornSec: 40 }));
  expect(lateJoinNotice(null) === null && lateJoinNotice(undefined) === null, 'normal start: no late-join line');
}
const menu = read('src/client/menu/MenuController.ts');
const body = menu.slice(menu.indexOf('private renderQueue('), menu.indexOf('private applyStats('));
expect(/queueLines\(payload\)/.test(body) && !/secondsRemaining\}s/.test(body), 'MenuController.renderQueue paints queueLines(payload)');
const game = read('src/client/core/Game.ts');
const start = game.slice(game.indexOf('private onMatchStartFromMenu('), game.indexOf('private onMatchStartFromMenu(') + 1500);
expect(/lateJoinNotice\(payload\?\.lateJoin\)/.test(start), 'Game.onMatchStartFromMenu shows the late-join line');

console.log(`\ntest-queue-text: ${checks} checks, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
