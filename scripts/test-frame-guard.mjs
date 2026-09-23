// FRAME GUARD + ERROR BEACON + CONTEXT-LOSS WIRING (logic tier, b1.1b).
//
// correctness-06: Game.frame() re-armed requestAnimationFrame as its LAST
// statement with no try/finally, so the first throw in any frame stopped the
// loop forever (frozen canvas, seat kept alive by the worker heartbeat).
// This suite drives src/client/core/frameGuard.ts with a fake scheduler and
// proves: a throwing body still schedules the next frame; 30 consecutive faults
// raise the wedged flag exactly once; a clean frame resets the streak;
// injectFault(n) throws exactly n frames. Then the error beacon's budget (dedupe,
// <= 5 per session, no identity fields) and three static wiring checks that are
// RED on f5fee97e: Game.frame() runs through the guard, Renderer listens for
// webglcontextlost AND webglcontextrestored, and the audition refuses to write
// a tier ceiling while graphics are held.
//
//   node --import tsx scripts/test-frame-guard.mjs
import { readFileSync } from 'node:fs';
import { FrameGuard, FRAME_FAULT_LIMIT, FRAME_FAULT_COPY } from '../src/client/core/frameGuard.ts';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// ── 1. a throwing frame still schedules the next one ─────────────────────────
{
  const queue = [];
  let wedgedCalls = 0;
  const faults = [];
  const guard = new FrameGuard({
    schedule: (cb) => queue.push(cb),
    onFault: (err) => faults.push(err),
    onWedged: () => { wedgedCalls += 1; },
    log: () => {},
  });
  let mode = 'throw';
  let bodies = 0;
  const body = () => { bodies += 1; if (mode === 'throw') throw new Error('boom'); };
  const loop = (now) => guard.run(now, body, loop);
  guard.run(0, body, loop);
  check('throwing body still schedules the next frame', queue.length === 1, `queued ${queue.length}`);
  // Drive 29 more faulting frames: streak = 30 -> wedged once.
  for (let i = 1; i < FRAME_FAULT_LIMIT; i++) queue.shift()(i * 16);
  check(`${FRAME_FAULT_LIMIT} consecutive faults raise the overlay flag`, guard.wedged && wedgedCalls === 1,
    `wedged=${guard.wedged} calls=${wedgedCalls} streak=${guard.consecutiveFaults}`);
  for (let i = 0; i < 40; i++) queue.shift()(1000 + i * 16);
  check('the overlay is raised ONCE however long the streak runs', wedgedCalls === 1, `calls=${wedgedCalls}`);
  check('each distinct message reported once, not per frame', faults.length === 1, `reported ${faults.length}`);
  check('loop never lost its next frame', queue.length === 1 && bodies === 70, `queue=${queue.length} bodies=${bodies}`);
  mode = 'ok';
  queue.shift()(5000);
  check('a clean frame resets the streak and counts a frame', guard.consecutiveFaults === 0 && guard.frames === 1,
    `streak=${guard.consecutiveFaults} frames=${guard.frames}`);
}

// ── 2. below the limit: no overlay; injectFault(n) throws exactly n frames ───
{
  const queue = [];
  let wedgedCalls = 0;
  const guard = new FrameGuard({ schedule: (cb) => queue.push(cb), onWedged: () => { wedgedCalls += 1; }, log: () => {} });
  let bodies = 0;
  const body = () => { bodies += 1; };
  const loop = (now) => guard.run(now, body, loop);
  guard.injectFault(1);
  guard.run(0, body, loop);
  for (let i = 0; i < 10; i++) queue.shift()(i);
  check('injectFault(1): one fault, frames keep advancing, no overlay',
    guard.totalFaults === 1 && guard.frames === 10 && wedgedCalls === 0, `faults=${guard.totalFaults} frames=${guard.frames}`);
  guard.injectFault(FRAME_FAULT_LIMIT - 1);
  for (let i = 0; i < FRAME_FAULT_LIMIT + 5; i++) queue.shift()(i);
  check(`${FRAME_FAULT_LIMIT - 1} faults in a row stay under the limit`, !guard.wedged && wedgedCalls === 0);
  guard.injectFault(60);
  for (let i = 0; i < 70; i++) queue.shift()(i);
  check('injectFault(60) wedges once and recovers the streak after', guard.wedged && wedgedCalls === 1 && guard.consecutiveFaults === 0,
    `wedged=${guard.wedged} calls=${wedgedCalls}`);
  check('the overlay copy is the spec copy', FRAME_FAULT_COPY === 'Something broke on our side. Reload to rejoin (your seat is held for a minute)');
}

// ── 3. error beacon: dedupe, 5 per session, no identity ──────────────────────
{
  const posts = [];
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1', maxTouchPoints: 5,
      sendBeacon: (url, blob) => { posts.push({ url, blob }); return true; } },
  });
  const { reportBeacon, uaClass, MAX_PER_SESSION } = await import('../src/client/network/errorBeacon.ts');
  reportBeacon('error', new Error('a'));
  reportBeacon('error', new Error('a'));
  for (let i = 0; i < 10; i++) reportBeacon('rejection', new Error(`r${i}`));
  check(`dedupe + at most ${MAX_PER_SESSION} per session`, posts.length === MAX_PER_SESSION, `posts=${posts.length}`);
  const body = JSON.parse(await posts[0].blob.text());
  const keys = Object.keys(body).sort().join(',');
  check('beacon body carries only the anonymous fields', keys === 'buildId,kind,message,stack,tier,ua', keys);
  check('ua is a coarse class, never the raw UA', body.ua === 'safari/ios/phone', body.ua);
  check('posts go to /beacon under 4 KB', posts.every((p) => p.url === '/beacon' && p.blob.size < 4096));
  check('iPad desktop-mode UA classed as tablet',
    uaClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15', 5) === 'safari/ipados/tablet');
}

// ── 4. static wiring (RED on f5fee97e) ───────────────────────────────────────
{
  const game = readFileSync(`${ROOT}src/client/core/Game.ts`, 'utf8');
  const m = game.match(/\n {2}private frame\(now: number\)[^{]*\{([\s\S]*?)\n {2}\}/);
  const body = m ? m[1] : '';
  check('Game.frame() runs its body through the frame guard',
    /frameGuard\.run\(/.test(body) && !/requestAnimationFrame\(/.test(body), m ? body.trim().slice(0, 120) : 'frame() not found');
  check('Game exposes injectFrameFault(n)', /\n {2}injectFrameFault\(n: number\)/.test(game));
  const r = readFileSync(`${ROOT}src/client/rendering/Renderer.ts`, 'utf8');
  check('Renderer handles webglcontextlost', /addEventListener\(\s*'webglcontextlost'/.test(r));
  check('Renderer handles webglcontextrestored', /addEventListener\(\s*'webglcontextrestored'/.test(r));
  const aud = r.match(/private auditionTier\(avgFps: number\) \{([\s\S]*?)\n {2}\}/);
  check('the audition writes no ceiling while graphics are held', !!aud && /graphicsHeld\(/.test(aud[1]));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
