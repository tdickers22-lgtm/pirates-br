// QUALITY PREFERENCE ROWS — what tier does the auto-detector hand each device
// class? Pure node: the browser environment is a stub per row.
//
// WHY. The default verdict for most machines is wrong on three of four device
// classes (perf-01/02/03, PERF-01): Safari on an Apple-silicon Air reports the
// opaque 'Apple GPU', so the air-class rule (which wants 'Apple M2') misses and
// the Air opens on 'balanced' with a 1536² shadow map and FXAA; every phone is
// balanced too (no touch/UA signal, deviceMemory undefined → memoryStrong);
// an Intel UHD 620 laptop is balanced because eight cores read as headroom.
// Nothing graded the detector, so the fanless class ran the wrong tier since
// the day 'balanced' was added.
//
// WHAT. Each row is a device as the browser presents it (renderer string or
// null when masked, cores, deviceMemory, CSS viewport, devicePixelRatio, touch
// points) and the tier PERF-01 (PLAN §3 row 21, §5 lane 2.6) says it must get.
// detectRenderQuality() is imported fresh per row (query-string import: the
// renderer string is cached at module level) under a stubbed window/navigator/
// canvas. The URL and stored-preference short-circuits are NOT exercised here —
// `decideRenderQuality` keeps them and the pinned suites depend on `?quality=`.
//
// RED ON HEAD (2026-09-02, re-witnessed 2026-09-07): Safari M2 Air → balanced, iPhone → balanced,
// UHD 620 → balanced, Adreno phone → balanced, masked unknown → balanced.
// Green is lane 2.6's job (RENDERER_RULES + mobile/integrated/opaque-Apple rules).
//
//   node --import tsx scripts/test-quality-preference.mjs
import { pathToFileURL } from 'node:url';
import path from 'node:path';

let failures = 0, checks = 0;
function expect(label, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ✓ ${label}`);
  else { failures += 1; console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); }
}

/** One row = one machine. `renderer: null` means WEBGL_debug_renderer_info is masked. */
const ROWS = [
  { name: 'Safari on an M2 Air (opaque "Apple GPU", 8 cores, no deviceMemory, 1470x956 @2)', renderer: 'Apple GPU', cores: 8, memory: undefined, w: 1470, h: 956, dpr: 2, touch: 0, want: 'low' },
  { name: 'Chrome on an M2 Air (ANGLE Metal "Apple M2", 8 cores, 8 GB)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', cores: 8, memory: 8, w: 1470, h: 956, dpr: 2, touch: 0, want: 'low' },
  { name: 'iPhone 15 Safari (opaque "Apple GPU", 6 cores, 390x844 @3, 5 touch points)', renderer: 'Apple GPU', cores: 6, memory: undefined, w: 390, h: 844, dpr: 3, touch: 5, want: 'low' },
  { name: 'Android phone (Adreno 650, 8 cores, 8 GB, 412x915 @2.6, touch)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 650, OpenGL ES 3.2 V@0502.0 (GIT@...))', cores: 8, memory: 8, w: 412, h: 915, dpr: 2.625, touch: 5, want: 'low' },
  { name: 'Intel UHD 620 laptop, Chrome (8 cores, 8 GB, 1536x864 @1.25)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 8, memory: 8, w: 1536, h: 864, dpr: 1.25, touch: 0, want: 'low' },
  { name: 'masked renderer, 8 cores, dPR 2 (thin laptop under a privacy extension)', renderer: null, cores: 8, memory: 8, w: 1440, h: 900, dpr: 2, touch: 0, want: 'low' },
  { name: 'masked renderer, 8 cores, dPR 1 (unknown desktop: low is the unknown default)', renderer: null, cores: 8, memory: 8, w: 1920, h: 1080, dpr: 1, touch: 0, want: 'low' },
  { name: 'RTX 3060 desktop, 6 cores (detection-time verdict; promotion proof comes later)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 6, memory: 8, w: 1920, h: 1080, dpr: 1, touch: 0, want: 'balanced' },
  { name: 'RTX 3060 desktop, 12 cores, 16 GB, 1920x1080', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)', cores: 12, memory: 8, w: 1920, h: 1080, dpr: 1, touch: 0, want: 'high' },
  { name: 'M2 Pro MacBook Pro, Chrome (12 cores, 1728x1117 @2)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', cores: 12, memory: 8, w: 1728, h: 1117, dpr: 2, touch: 0, want: 'high' },
  { name: 'four-core anything', renderer: 'ANGLE (Intel, Intel(R) HD Graphics 4000, OpenGL 4.1)', cores: 4, memory: 8, w: 1440, h: 900, dpr: 2, touch: 0, want: 'low' },
];

function installEnv(row, seed = null) {
  const store = new Map();
  if (seed) store.set('piratesBR.settings', JSON.stringify(seed));
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const gl = row.renderer === null ? { getExtension: () => null, getParameter: () => null } : {
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : n === 'WEBGL_lose_context' ? { loseContext() {} } : null),
    getParameter: () => row.renderer,
  };
  globalThis.window = {
    location: { search: '' }, innerWidth: row.w, innerHeight: row.h, devicePixelRatio: row.dpr,
    screen: { width: row.w, height: row.h },
    localStorage: storage, navigator: undefined, matchMedia: () => ({ matches: row.touch > 0 }),
  };
  globalThis.navigator = { hardwareConcurrency: row.cores, deviceMemory: row.memory, maxTouchPoints: row.touch, userAgent: row.touch ? 'Mobile Safari' : 'Mozilla/5.0' };
  globalThis.window.navigator = globalThis.navigator;
  globalThis.localStorage = storage;
  globalThis.document = { createElement: () => ({ getContext: () => gl }) };
  return store;
}

const modPath = path.resolve('src/client/rendering/QualityPreference.ts');
console.log('Quality preference rows (detectRenderQuality per stubbed device)');
let i = 0;
for (const row of ROWS) {
  installEnv(row);
  const mod = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  let verdict;
  try { verdict = mod.detectRenderQuality(); }
  catch (e) { expect(`${row.name}: detector runs under the stub`, false, String(e?.message ?? e)); continue; }
  expect(`${row.name} → ${row.want} (got ${verdict.quality}, reason ${verdict.reason})`, verdict.quality === row.want);
}


// ─────────────────────────────────────────────────────────────────────────────
// THE WAY BACK UP, AND THE WAY IT MUST NOT GO (perf-04, perf-v-04)
// ─────────────────────────────────────────────────────────────────────────────
// The audition ceiling was one-way, and after RENDERER_RULES every machine the
// detector cannot identify opens on 'low' — which would be a trap without a
// promotion path. A proof is a minute of unsuspended play at scalar 1.0 with
// half the frame budget unspent, written by Renderer.updateTierProof for the
// NEXT launch. It may only ever overrule a reason that was a GUESS.
console.log('\nPromotion proof (a machine that proved it has headroom, and one that never can)');
const PROOF_ROWS = [
  { row: ROWS[6], proof: 'balanced', want: 'balanced', why: "an unknown desktop that held 'low' with headroom is offered 'balanced'" },
  { row: ROWS[0], proof: 'balanced', want: 'balanced', why: "Safari's opaque 'Apple GPU' is unknown, not a verdict — a proven Mac Studio is promoted" },
  { row: ROWS[1], proof: 'balanced', want: 'low', why: "a NAMED Apple base chip is a fact about the part: no proof promotes the Air" },
  { row: ROWS[2], proof: 'high', want: 'low', why: 'no proof promotes a phone' },
  { row: ROWS[4], proof: 'balanced', want: 'low', why: 'no proof promotes an Intel UHD 620' },
  { row: ROWS[7], proof: 'low', want: 'balanced', why: 'a proof never LOWERS a tier' },
];
for (const { row, proof, want, why } of PROOF_ROWS) {
  const sig = `${row.renderer ?? 'masked'}|${row.w}x${row.h}`;
  installEnv(row, { autoQualityProof: { tier: proof, sig } });
  const mod = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  const verdict = mod.detectRenderQuality();
  expect(`${why} (got ${verdict.quality}, reason ${verdict.reason})`, verdict.quality === want);
}
{
  // A proof taken on a different machine (or a laptop now on a 4K monitor) is
  // about a machine that is not here.
  const row = ROWS[6];
  installEnv(row, { autoQualityProof: { tier: 'high', sig: 'someone-elses-gpu|3840x2160' } });
  const mod = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  const verdict = mod.detectRenderQuality();
  expect(`a proof whose machine signature does not match is ignored (got ${verdict.quality})`, verdict.quality === 'low');
}
{
  // The downward ceiling still wins over a proof: a machine that failed its
  // audition does not get promoted by an older proof.
  const row = ROWS[7];
  installEnv(row, { autoQuality: 'low', autoQualityProof: { tier: 'high', sig: `${row.renderer}|${row.w}x${row.h}` } });
  const mod = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  const verdict = mod.detectRenderQuality();
  expect(`a failed audition still clamps a promoted tier (got ${verdict.quality}, reason ${verdict.reason})`,
    verdict.quality === 'low' && verdict.reason === 'audition');
}


// ─────────────────────────────────────────────────────────────────────────────
// THE FILL BENCH (perf-20 phase 2, perf-v-04)
// ─────────────────────────────────────────────────────────────────────────────
// A rule table cannot fix Safari: the string, the core count and deviceMemory
// are opaque at once, so only a MEASUREMENT separates an M2 Air from an M2
// Ultra. A stored score decides where the verdict was a guess — and nowhere
// else, so a 900 Mpx/s reading on a phone's menu still leaves it on 'low'.
console.log('\nFill bench (a measured machine beats a guessed one)');
const BENCH_ROWS = [
  { row: ROWS[0], score: 900, want: 'high', why: "Safari on a Mac Studio: 900 Mpx/s takes the opaque 'Apple GPU' to high" },
  { row: ROWS[0], score: 420, want: 'balanced', why: 'the same opaque string at 420 Mpx/s is a middling Mac' },
  { row: ROWS[0], score: 90, want: 'low', why: 'and at 90 Mpx/s it is the Air the game was tuned for' },
  { row: ROWS[2], score: 900, want: 'low', why: 'no score promotes a phone off the mobile branch' },
  { row: ROWS[4], score: 900, want: 'low', why: 'no score promotes an Intel UHD 620' },
  { row: ROWS[1], score: 900, want: 'low', why: 'no score promotes a NAMED Apple base chip' },
];
for (const { row, score, want, why } of BENCH_ROWS) {
  const sig = `${row.renderer ?? 'masked'}|${row.w}x${row.h}`;
  installEnv(row, { bench: { score, sig, at: Date.now() } });
  const mod = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  const verdict = mod.detectRenderQuality();
  expect(`${why} (got ${verdict.quality}, reason ${verdict.reason})`, verdict.quality === want);
}
{
  const row = ROWS[0];
  installEnv(row, { bench: { score: 900, sig: 'a-different-gpu|3840x2160', at: Date.now() } });
  const mod = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  const verdict = mod.detectRenderQuality();
  expect(`a score taken on another machine is ignored (got ${verdict.quality}, reason ${verdict.reason})`,
    verdict.quality === 'low' && verdict.reason === 'unknown-default');
}
{
  // The safe default, stated as a row: opaque inputs AND no bench is 'low',
  // never 'balanced' by fallthrough (perf-v-04).
  installEnv(ROWS[0]);
  const mod = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  const verdict = mod.detectRenderQuality();
  expect(`bench-unavailable opaque Safari is 'low', not 'balanced' (got ${verdict.quality})`, verdict.quality === 'low');
}
{
  // The thresholds themselves, so a change to them is a visible change.
  installEnv(ROWS[0]);
  const bench = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  expect('bench thresholds: 249/250 straddles low|balanced and 699/700 straddles balanced|high',
    bench.tierForBenchScore(249) === 'low' && bench.tierForBenchScore(250) === 'balanced'
    && bench.tierForBenchScore(699) === 'balanced' && bench.tierForBenchScore(700) === 'high');
  expect('a bench that could not be measured is low, never a guess upward',
    bench.tierForBenchScore(0) === 'low' && bench.tierForBenchScore(NaN) === 'low');
}

// ────────────────────────────────────────────────────────────────────────────
// DEFAULT-FRAMEBUFFER MSAA IS A TILE-BASED PRIVILEGE (AA-01, review-2 P1).
//
// `low` builds no PostFx, so `antialias: true` on the context is the only AA it
// can have — but `low` is also where every Intel/AMD integrated part and every
// masked unknown lands, and there 4x samples + resolve are main-memory traffic
// per frame on the weakest hardware in the roster, for a staircase gain the
// edge-shimmer probe measured at ~0 through the 0.62 upscale. It was asked of
// all of them unconditionally. This grades WHO is asked, per device row, with
// no browser.
{
  const mod = await import(`${pathToFileURL(modPath).href}?row=${i++}`);
  const TILE_BASED = new Set(['Safari on an M2 Air', 'Chrome on an M2 Air', 'iPhone 15 Safari', 'Android phone']);
  let wrong = 0;
  const seen = { yes: 0, no: 0 };
  for (const row of ROWS) {
    const tile = [...TILE_BASED].some((n) => row.name.startsWith(n));
    const got = mod.wantsDefaultFramebufferMsaa(row.want, row.renderer);
    const want = row.want === 'low' && tile;
    if (want) seen.yes += 1; else seen.no += 1;
    if (got !== want) {
      wrong += 1;
      console.error(`     ${row.name}: tier=${row.want} tile=${tile} wants MSAA=${got}, expected ${want}`);
    }
  }
  expect('default-framebuffer MSAA is asked of the tile-based low machines and nobody else',
    wrong === 0, `${wrong}/${ROWS.length} rows disagree`);
  expect('the row set actually exercises both answers (not vacuously all-false)',
    seen.yes >= 3 && seen.no >= 5, `yes=${seen.yes} no=${seen.no}`);
  expect('an immediate-mode part on the low tier is NOT asked for it',
    mod.wantsDefaultFramebufferMsaa('low', ROWS[4].renderer) === false
    && mod.wantsDefaultFramebufferMsaa('low', null) === false);
  expect('and no tier above low asks for it at all (they resolve in the composer target)',
    mod.wantsDefaultFramebufferMsaa('balanced', 'Apple GPU') === false
    && mod.wantsDefaultFramebufferMsaa('high', 'Apple GPU') === false);
  expect('SwiftShader is not tile-based (the browser gates must not pay for samples)',
    mod.isTileBasedGpu('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))') === false);
}

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
