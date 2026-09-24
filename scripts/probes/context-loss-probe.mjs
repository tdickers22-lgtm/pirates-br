// GATE (browser, b1.1b / performance-03): WebGL context loss and restore mid-match.
//
// iOS drops the WebGL context when a tab is backgrounded or memory runs short.
// Before b1.1b nothing in the client listened: three skipped render() while
// lost, then recompiled every program at first draw mid-play, and the governor
// and audition read that stall as slowness. This probe joins a solo match,
// calls WEBGL_lose_context.loseContext(), waits 1 s, restoreContext(), and
// asserts:
//   - no pageerror;
//   - the "Restoring graphics" pill is visible while lost, and hidden again <= 6 s after restore;
//   - graphics are held (governor suspended, audition closed) while lost;
//   - draws resume <= 3 s after restore (hardware GL; on software GL within 3
//     rendered frames) and the guarded frame loop kept advancing;
//   - NO FRAME STALLS: the longest rAF gap from restore to settle is <= max(1.5 s,
//     3 x the pre-loss median frame, serial budget 400 ms + the worst single link
//     the warmer measured + two pre-loss frames). One link cannot be subdivided
//     (SwiftShader links some programs in 2.8 s), so the contract is "a restore
//     frame pays its budget plus ONE link", never the whole set: b1.1b2 found the
//     restore's entire cost in one frame (54 links, 16.2 s blocked, 19.3 s to a draw);
//   - renderer.info.programs is back to >= 95% of the pre-loss count within
//     RESTORE_FRAMES rendered frames, and the pill hides within them too. Frames,
//     not seconds, so the bar means the same on SwiftShader (~1.4 fps) as on a
//     GPU; on a hardware GL the old wall bars (programs <= 5 s, pill <= 6.5 s)
//     apply as well;
//   - the settle state was observed and held the governor;
//   - the saved settings (where the auto-tier ceiling lives) are byte-identical.
// --mutate drops the client's own webglcontextrestored listener (three's stays):
// the probe must FAIL (programs stay at 0, the pill never hides).
//
// --phone (b1-ask-04): the phone/iPad profile (?profile=mobile, 844x390 touch
// viewport, quality low), where CpuCopyRelease drops the island batches' CPU
// arrays after upload. The probe waits until the release has run and its eager
// queue has drained, picks the four biggest released island batches, and renders
// each ALONE (camera layer 30, magenta clear, framed on its bounding sphere) into
// the drawing buffer and counts the pixels it covers (gl.readPixels in the same
// task). After lose + restore the same batches must draw again: >= 1 draw call
// and >= 80% of the pre-loss coverage each. Red on e3e50b54 (a released batch
// re-uploads an empty buffer: 0 pixels for the rest of the match).
//
// usage: node scripts/probes/context-loss-probe.mjs [--url http://127.0.0.1:3101] [--quality balanced] [--mutate] [--phone]
// Needs a running stack (server 8091 with PIRATES_BR_DEV_HOOKS=1, vite 3101). Never 3000/8090/8080.
import { chromium } from 'playwright';
import { browserArgs, describeGl } from '../lib/browser-args.mjs';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL = (arg('url', process.env.PIRATES_BR_URL ?? 'http://127.0.0.1:3101')).replace(/\/$/, '');
const PHONE = argv.includes('--phone');
const QUALITY = arg('quality', PHONE ? 'low' : 'balanced');
const MUTATE = argv.includes('--mutate');
const SOFTWARE_GL = describeGl().startsWith('swiftshader');
/** Rendered frames the restore may take (Renderer.RESTORE_MAX_FRAMES is 360; this is tighter). */
const RESTORE_FRAMES = 200;
const WAIT_MS = SOFTWARE_GL ? 150_000 : 12_000;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const MUTATION = () => {
  // Keep three's own restore listener (added first, in the WebGLRenderer
  // constructor); drop every later one, i.e. the client's.
  const add = HTMLCanvasElement.prototype.addEventListener;
  HTMLCanvasElement.prototype.addEventListener = function (type, fn, opts) {
    if (type === 'webglcontextrestored') {
      this.__restoredSeen = (this.__restoredSeen ?? 0) + 1;
      if (this.__restoredSeen > 1) return undefined;
    }
    return add.call(this, type, fn, opts);
  };
};

const browser = await chromium.launch({ headless: true, args: browserArgs() });
const pageErrors = [];
try {
  const page = await browser.newPage(PHONE
    ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, hasTouch: true }
    : { viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0, 200)));
  if (MUTATE) await page.addInitScript(MUTATION);
  // rAF timestamps: a blocked main thread shows up as a gap, whatever blocked it.
  await page.addInitScript(() => {
    const stamps = window.__rafStamps = [];
    const tick = (t) => { stamps.push(t); if (stamps.length > 20000) stamps.splice(0, 10000); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  console.log(`[context-loss] ${URL} quality=${QUALITY} gl=${describeGl()}${MUTATE ? ' MUTATED' : ''}${PHONE ? ' PHONE' : ''}`);
  await page.goto(`${URL}/?debug&forceinput&quality=${QUALITY}${PHONE ? '&profile=mobile' : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#menu-solo-btn', { timeout: 60_000 });
  await page.click('#menu-solo-btn', { noWaitAfter: true });
  await page.waitForFunction(() => window.__piratesBR?.state?.phase === 'playing', null, { timeout: 150_000 });
  await page.waitForTimeout(8000);

  const read = () => page.evaluate(() => {
    const g = window.__piratesBR;
    const r = g.renderer;
    const s = r.getGraphicsStatus();
    return {
      ...s,
      frames: g.frameGuard.frames,
      calls: r.renderer.info.render.calls,
      govSuspended: r.governor.isSuspended(),
      settings: localStorage.getItem('piratesBR.settings'),
      now: performance.now(),
      warm: { serial: r.programWarmer.stats.serial, links: r.programWarmer.stats.serialLinks, ms: r.programWarmer.stats.serialMs, worstJoin: r.programWarmer.stats.worstJoinMs },
    };
  });
  const gaps = (from, to = Infinity) => page.evaluate(([a, b]) => {
    const s = window.__rafStamps.filter((t) => t >= a && t <= b);
    const d = []; for (let i = 1; i < s.length; i++) d.push(s[i] - s[i - 1]);
    d.sort((x, y) => x - y);
    return { n: d.length, median: d.length ? d[d.length >> 1] : 0, max: d.length ? d[d.length - 1] : 0 };
  }, [from, to]);
  // Phone: render each picked released island batch alone and count its pixels.
  const coverage = (pick) => page.evaluate((doPick) => {
    const g = window.__piratesBR; const R = g.renderer; const r = R.renderer; const scene = R.scene;
    if (doPick) {
      const c = [];
      scene.traverse((o) => {
        const p = o.isMesh && /-batch\d*$/.test(o.name) && o.geometry?.attributes?.position;
        if (p && p.__cpuReleasedBytes > 0 && o.geometry.boundingSphere) c.push(o);
      });
      c.sort((a, b) => b.geometry.attributes.position.__cpuReleasedBytes - a.geometry.attributes.position.__cpuReleasedBytes);
      window.__ctxReleased = c.length;
      window.__ctxTargets = c.slice(0, 4);
    }
    const gl = r.getContext();
    const W = gl.drawingBufferWidth; const H = gl.drawingBufferHeight;
    const buf = new Uint8Array(W * H * 4);
    const out = [];
    for (const mesh of window.__ctxTargets ?? []) {
      const pos = mesh.geometry.attributes.position;
      const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const ColorCtor = mat?.color?.constructor;
      const savedColor = ColorCtor ? r.getClearColor(new ColorCtor()) : null;
      const savedAlpha = r.getClearAlpha();
      const vis = [];
      for (let o = mesh; o; o = o.parent) { vis.push([o, o.visible]); o.visible = true; }
      const bg = scene.background; const autoClear = r.autoClear; const shadowAuto = r.shadowMap.autoUpdate;
      const sph = mesh.geometry.boundingSphere.clone().applyMatrix4(mesh.matrixWorld);
      const cam = R.camera.clone();
      cam.fov = 50; cam.aspect = W / H; cam.near = Math.max(0.1, sph.radius * 0.05); cam.far = sph.radius * 10;
      const dir = sph.center.clone().set(0.6, 0.7, 0.6).normalize();
      cam.position.copy(sph.center).addScaledVector(dir, sph.radius * 2.4);
      cam.up.set(0, 1, 0); cam.lookAt(sph.center); cam.updateProjectionMatrix(); cam.updateMatrixWorld(true);
      cam.layers.set(30); mesh.layers.enable(30);
      let px = -1; let calls = -1;
      try {
        scene.background = null; r.autoClear = true; r.shadowMap.autoUpdate = false;
        r.setRenderTarget(null); r.setClearColor(0xff00ff, 1);
        const callsBefore = r.info.render.calls; // the game resets info itself (autoReset off)
        r.render(scene, cam);
        calls = r.info.render.autoReset ? r.info.render.calls : r.info.render.calls - callsBefore;
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        px = 0;
        for (let i = 0; i < buf.length; i += 4) if (buf[i] < 247 || buf[i + 1] > 8 || buf[i + 2] < 247) px += 1;
      } finally {
        mesh.layers.disable(30);
        for (const [o, v] of vis) o.visible = v;
        scene.background = bg; r.autoClear = autoClear; r.shadowMap.autoUpdate = shadowAuto;
        if (savedColor) r.setClearColor(savedColor, savedAlpha);
      }
      out.push({ name: mesh.name, px, calls, cpuLen: pos.array.length, gpuBytes: pos.__cpuReleasedBytes ?? 0 });
    }
    return { released: window.__ctxReleased ?? 0, targets: out };
  }, pick);
  let preCov = null;
  if (PHONE) {
    const t0 = Date.now(); let cr = null;
    while (Date.now() - t0 < 150_000) {
      cr = await page.evaluate(() => window.__piratesBR.memoryCensus().cpuRelease);
      if (cr.releasedBytes > 0 && cr.pendingCount === 0) break;
      await page.waitForTimeout(2000);
    }
    check('phone: CpuCopyRelease ran and drained before the loss', cr.enabled && cr.releasedBytes > 0 && cr.pendingCount === 0,
      `released=${(cr.releasedBytes / 1e6).toFixed(1)} MB pending=${cr.pendingCount}`);
    preCov = await coverage(true);
    console.log(`  phone pre-loss: ${preCov.released} released batches; targets ${JSON.stringify(preCov.targets)}`);
    check('phone: picked released island batches draw before the loss (CPU copy gone, >= 200 px each)',
      preCov.targets.length >= 1 && preCov.targets.every((t) => t.cpuLen === 0 && t.px >= 200 && t.calls >= 1),
      `${preCov.targets.length} targets`);
  }
  const before = await read();
  const pre = await gaps(before.now - 8000, before.now);
  console.log(`  pre-loss frames: median ${Math.round(pre.median)} ms over ${pre.n}`);
  console.log(`  before: programs=${before.programs} frames=${before.frames} calls=${before.calls}`);
  check('pre-loss scene has programs', before.programs > 5, `programs=${before.programs}`);

  await page.evaluate(() => {
    const gl = window.__piratesBR.renderer.renderer.getContext();
    window.__loseExt = gl.getExtension('WEBGL_lose_context');
    window.__loseExt.loseContext();
  });
  await page.waitForTimeout(1000);
  const lost = await read();
  check('pill visible while lost', lost.pill && lost.lost, `pill=${lost.pill} lost=${lost.lost}`);
  check('graphics held + governor suspended while lost', lost.held && lost.govSuspended, `held=${lost.held} gov=${lost.govSuspended}`);
  check('frame loop kept running through the loss', lost.frames > before.frames, `${before.frames} -> ${lost.frames}`);

  const restoreAt = Date.now();
  const restorePerf = await page.evaluate(() => { window.__loseExt.restoreContext(); return performance.now(); });
  // Observe the settle state right after the event, before any frame can end it.
  const first = await read();
  let heldDuringSettle = first.settling ? first.held && first.govSuspended : null;
  const restoreFrame = first.frames;
  let drawsAt = null; let drawsFrames = null; let programsAt = null; let programsFrames = null; let pillHiddenAt = null; let pillFrames = null;
  let last = first;
  while (Date.now() - restoreAt < WAIT_MS) {
    await page.waitForTimeout(150);
    last = await read();
    const t = Date.now() - restoreAt;
    const f = last.frames - restoreFrame;
    if (heldDuringSettle === null && last.settling) heldDuringSettle = last.held && last.govSuspended;
    if (heldDuringSettle === true && last.settling && !(last.held && last.govSuspended)) heldDuringSettle = false;
    if (drawsAt === null && !last.lost && last.calls > 0) { drawsAt = t; drawsFrames = f; }
    if (programsAt === null && last.programs >= Math.floor(before.programs * 0.95)) { programsAt = t; programsFrames = f; }
    if (pillHiddenAt === null && !last.pill && !last.lost) { pillHiddenAt = t; pillFrames = f; }
    if (drawsAt !== null && programsAt !== null && pillHiddenAt !== null) break;
  }
  const stall = await gaps(restorePerf, last.now);
  // Budget + one link + two ordinary frames: the render itself, and the first
  // binds after a restore (texture re-uploads, the depth/shadow/PostFx programs
  // the scene walk cannot reach, ~13 draw-time links in the first frame).
  const stallBar = Math.max(1500, 3 * pre.median, 400 + last.warm.worstJoin + 2 * pre.median);
  console.log(`  after:  programs=${last.programs} calls=${last.calls} restores=${last.restores} drawsAt=${drawsAt}ms`
    + ` programsAt=${programsAt}ms/${programsFrames}f pillHiddenAt=${pillHiddenAt}ms/${pillFrames}f`
    + ` worstFrame=${Math.round(stall.max)}ms worstLink=${Math.round(last.warm.worstJoin)}ms serialLinks=${last.warm.links} (${Math.round(last.warm.ms)} ms)`);
  if (SOFTWARE_GL) {
    check('draws resume within 3 rendered frames of restore', drawsFrames !== null && drawsFrames <= 3, `${drawsFrames} frames / ${drawsAt} ms`);
  } else {
    check('draws resume <= 3 s after restore', drawsAt !== null && drawsAt <= 3000, `${drawsAt} ms`);
  }
  check(`no frame after restore longer than ${Math.round(stallBar)} ms`, stall.n > 0 && stall.max <= stallBar,
    `worst ${Math.round(stall.max)} ms over ${stall.n} frames`);
  check(`programs back to >= 95% of the pre-loss count within ${RESTORE_FRAMES} frames`,
    programsFrames !== null && programsFrames <= RESTORE_FRAMES,
    `${last.programs}/${before.programs} at ${programsFrames} frames / ${programsAt} ms`);
  check(`pill hidden within ${RESTORE_FRAMES} frames`, pillFrames !== null && pillFrames <= RESTORE_FRAMES,
    `${pillFrames} frames / ${pillHiddenAt} ms`);
  if (!SOFTWARE_GL) {
    check('programs back <= 5 s (hardware GL)', programsAt !== null && programsAt <= 5000, `${programsAt} ms`);
    check('pill hidden <= 6.5 s (hardware GL)', pillHiddenAt !== null && pillHiddenAt <= 6500, `${pillHiddenAt} ms`);
  }
  check('restore settle observed and held the governor', heldDuringSettle === true, `held=${heldDuringSettle}`);
  if (PHONE && preCov) {
    const t0 = Date.now(); let cr = null;
    while (Date.now() - t0 < 60_000) {
      cr = await page.evaluate(() => window.__piratesBR.memoryCensus().cpuRelease);
      if (!cr.restorePending) break;
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(2000);
    const post = await coverage(false);
    console.log(`  phone post-restore: targets ${JSON.stringify(post.targets)} restoredGeoms=${cr?.restoredGeoms} restoredMB=${((cr?.restoredBytes ?? 0) / 1e6).toFixed(1)}`);
    const pairs = preCov.targets.map((t, i) => [t, post.targets[i]]);
    check('phone: every released island batch issues a draw again after restore',
      pairs.every(([, b]) => b && b.calls >= 1), pairs.map(([, b]) => b?.calls).join(','));
    check('phone: released island batches cover >= 80% of their pre-loss pixels after restore',
      pairs.every(([a, b]) => b && b.px >= 0.8 * a.px), pairs.map(([a, b]) => `${a.name} ${a.px}->${b?.px}`).join(' | '));
  }
  const endFrames = last.frames;
  await page.waitForTimeout(1000);
  const tail = await read();
  check('frames still advancing after restore', tail.frames > endFrames, `${endFrames} -> ${tail.frames}`);
  check('saved settings (auto-tier ceiling) unchanged', tail.settings === before.settings,
    `${String(before.settings).slice(0, 80)} vs ${String(tail.settings).slice(0, 80)}`);
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  failures += 1;
  console.log(`  FAIL  probe aborted: ${err.message.slice(0, 300)}`);
} finally {
  await browser.close();
}
if (failures) { console.log(`FAIL (${failures})`); process.exit(1); }
console.log('PASS');
