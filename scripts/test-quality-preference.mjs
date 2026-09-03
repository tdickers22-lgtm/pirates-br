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
// RED ON HEAD (2026-09-02): Safari M2 Air → balanced, iPhone → balanced,
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

function installEnv(row) {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const gl = row.renderer === null ? { getExtension: () => null, getParameter: () => null } : {
    getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : n === 'WEBGL_lose_context' ? { loseContext() {} } : null),
    getParameter: () => row.renderer,
  };
  globalThis.window = {
    location: { search: '' }, innerWidth: row.w, innerHeight: row.h, devicePixelRatio: row.dpr,
    localStorage: storage, navigator: undefined, matchMedia: () => ({ matches: row.touch > 0 }),
  };
  globalThis.navigator = { hardwareConcurrency: row.cores, deviceMemory: row.memory, maxTouchPoints: row.touch, userAgent: row.touch ? 'Mobile Safari' : 'Mozilla/5.0' };
  globalThis.window.navigator = globalThis.navigator;
  globalThis.localStorage = storage;
  globalThis.document = { createElement: () => ({ getContext: () => gl }) };
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

console.log(`\n${checks} checks, ${failures} failed`);
if (checks === 0) { console.error('VACUOUS'); process.exit(1); }
process.exit(failures > 0 ? 1 : 0);
