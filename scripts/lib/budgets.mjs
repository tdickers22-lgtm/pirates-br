// scripts/lib/budgets.mjs — EVERY CEILING IN ONE FILE (PLAN 2026-09-22 rule 13, b1.7a, critique gap 5b).
//
// The perf, fill, first-draw, frame-governor, ocean-tier and wire-size gates import their numbers from
// here; none of them carries a literal ceiling of its own any more. scripts/test-budget-ratchet.mjs
// (quick tier) fails the build when any value here is LOOSER than
//   - the same value on origin/release (once release carries this file),
//   - the f5fee97e baseline (scripts/fixtures/budget-baseline-f5fee97e.json), or
//   - the PLAN section 3.4 / 3.14 / D27 tables,
// where "looser" means a ceiling went UP or a floor went DOWN (see directionOf below), and it fails
// when the last commit that touched this file also touched src/ or public/: a tightening is its own
// commit, and a regression never gets to move its own goalposts.
//
// `measured` fields are readings kept next to their ceilings for the reader; the ratchet ignores them.
// Scene inputs (viewport w/h/dpr) are not budgets either. Everything else numeric is graded.

// ═══ test-perf-budget: draw / triangle / program ceilings per tier and scene ═══════════════════════
/**
 * THE TRIPWIRES.
 *
 * `measured` is the HIGHEST this scene read across consecutive runs of this
 * suite on the pinned map (2026-08-02, SwiftShader, quality pinned, pixel ratio
 * 1). `draws`/`tris` are ceilings a modest margin above that — roughly 1.12x,
 * not the 1.3x the July table used, because a 30% allowance is a whole content
 * wave of silent drift.
 *
 * RE-DERIVED 2026-08-02 AFTER THE GEOMETRY PASS, over four consecutive runs.
 * Every triangle ceiling in this table came down, some of them a long way: the
 * pebble scatter, the cave portal frames and the ocean's outer ring together
 * took 74k to 198k triangles a frame out of these views, and a ceiling left
 * where it was is a blind spot the exact width of the saving. Open water was the
 * worst of them — 1,150k against a reality of 828k, a 39% gap, which is the same
 * mistake this table's previous note was written about.
 *
 * AND WHAT THIS TABLE STILL CANNOT SEE, said plainly so nobody trusts it for
 * more than it does. A ceiling at 1.12x of a whole frame cannot catch the loss
 * of ONE geometry lever: reverting all three of the above at once puts ~104k
 * triangles back on a dock vista that measures 1,784k, which is 5.8% and well
 * inside the margin — and tightening the margin to 1.06 would put it inside this
 * scene's own run-to-run spread (1,646-1,727 draws over four runs) and start
 * failing honest builds. Those levers are guarded one at a time, on themselves,
 * in scripts/test-geometry-lod.mjs. This table guards the SUM.
 *
 * WHY EVERY NUMBER HERE MOVED ONCE. The first version of this table was written
 * before the map was pinned, so every `measured` in it was a reading from a
 * world these scenes will never see again, and the ceilings inherited that
 * world's luck. On the pinned map the errors ran both ways and neither was
 * harmless: open water was set at 1600 against a reality of 1110 (a 44% blind
 * spot — the batcher could be deleted outright and open water would not
 * notice), while the wide vista was set at 1900 against readings that reached
 * 1827, four percent of headroom on a scene whose own run-to-run spread is six.
 * A ceiling is only worth what the reading under it is worth, and a reading from
 * a different world is worth nothing. These are re-derived from the pinned one.
 *
 * RAISING A NUMBER HERE IS A DECISION, NOT A FIX. If a change is worth the
 * draws, say so in the commit that raises it; if it is not, the change is what
 * needs adjusting. Widening the ceiling to fit a regression is how the July
 * table came to be 30% above a reality nobody had measured in a month.
 */
// DEVICE ROWS (b1.5d). Measured 2026-09-23 at d8097e14 on the pinned map,
// SwiftShader, device profile from lib/perf-scenes.mjs, resolution held at the
// pixel profile's open ratio (phone 1060x490 = 0.519 Mpx, iPad 1032x774 =
// 0.799 Mpx). Ceilings are the SMALLER of the section-3 device table (phone
// 450 draws / 400k tris, iPad 550 / 500k) and ~1.12x the reading, so a row
// that sits far under the table still has a tripwire at its own cost. The
// deck-aft phone row is the tight one: 433 against 450, the scene whose camera
// rides a drifting hull; b4.4a's phone levers are what buy it headroom.
//
// PROGRAMS: the table says <= 66 per match and the phone reads 66 through three
// scenes and 68 once open water adds its materials (iPad 68-69 over two runs;
// renderer.info.programs is cumulative, so the last scene carries the total).
// The ceiling is 70 (the table's desktop-low figure) until the programs owner
// (b3.1, ProgramWarmup / programCensus) brings phones to 66: a DECLARED spec
// deviation, handed off in the b1.5 report, never a silent one.
export const DEVICE_PROGRAMS = 70;
export const DEVICE_ROWS_PHONE = [
  { scene: 'dock-vista', label: 'wide island vista (phone)', measured: 328, draws: 370, tris: 400_000, programs: DEVICE_PROGRAMS },
  { scene: 'island-interior', label: 'island interior (phone)', measured: 410, draws: 450, tris: 295_000, programs: DEVICE_PROGRAMS },
  { scene: 'deck-aft', label: 'on-deck aft look (phone)', measured: 433, draws: 450, tris: 380_000, programs: DEVICE_PROGRAMS },
  { scene: 'open-sea', label: 'open water (phone)', measured: 235, draws: 265, tris: 76_000, programs: DEVICE_PROGRAMS },
];
export const DEVICE_ROWS_IPAD = [
  { scene: 'dock-vista', label: 'wide island vista (iPad)', measured: 250, draws: 290, tris: 380_000, programs: DEVICE_PROGRAMS },
  { scene: 'island-interior', label: 'island interior (iPad)', measured: 295, draws: 330, tris: 265_000, programs: DEVICE_PROGRAMS },
  { scene: 'deck-aft', label: 'on-deck aft look (iPad)', measured: 383, draws: 430, tris: 300_000, programs: DEVICE_PROGRAMS },
  { scene: 'open-sea', label: 'open water (iPad)', measured: 237, draws: 265, tris: 76_000, programs: DEVICE_PROGRAMS },
];
export const PERF_BUDGETS = {
  high: [
    // Four pinned runs after the geometry pass: 1646-1727 draws, 1694-1784k
    // tris. The draw ceiling STAYS at 1950 and is the one number here that was
    // not re-derived downward — it is set by a different failure. 1950 is the
    // smallest value that clears this scene's own ~5% spread and still fails a
    // return to per-plank drawing, which reads 2043 here (measured, batcher
    // removed); taking it to 1934 to honour the 1.12x rule would buy nothing and
    // put the batcher's tripwire inside the noise. The triangle ceiling did come
    // down, 2,250k -> 2,000k, against a reading that fell 1,885k -> 1,784k.
    { scene: 'dock-vista', label: 'wide island vista', measured: 1727, draws: 1950, tris: 2_000_000 },
    // THE ONE SCENE WHOSE FRAME MOVES, and the widest ceiling in the table
    // because of it. The camera rides the hull, so which islands are behind it
    // is a fact about where the ship is lying when the measurement lands — and
    // the ship is still drifting an hour into a run. Read 1165, 1581, 2742 and
    // 2660 across unpinned worlds; pinning removed most of that spread and the
    // rest is the hull's own position: 2455-2653 over five pinned runs.
    //
    // No before/after is claimed here: the pre-diet 2766/2481k was taken in a
    // DIFFERENT world, so the two numbers are not comparable and pretending
    // otherwise would credit the diet with a scene it barely touched. What the
    // ceiling is for is a return to per-plank drawing, which would clear it.
    { scene: 'deck-aft', label: 'on-deck aft look', measured: 2329, draws: 2650, tris: 2_900_000 },
    // 983-996 draws / 826-828k tris across four pinned runs — still the
    // steadiest scene in the table, and still the one its ceiling is blindest
    // at. It was 1,600 draws against 1,115 in July; the pass before this one cut
    // it to 1,250/1,150k; the sea's outer ring, the pebbles and the portal
    // frames then took the reading to 828k, at which point a 1,150k ceiling was
    // a 39% blind spot — wide enough to hide the whole of this pass twice.
    { scene: 'open-sea', label: 'open water', measured: 996, draws: 1120, tris: 930_000 },
    // 2337-2360 / 2435-2438k over four pinned runs, down from 2,395/2,576k
    // before the geometry pass. The waterfall wave's own view, which the July
    // table never had.
    { scene: 'waterfall-deck', label: 'deck view of a waterfall island', measured: 2360, draws: 2650, tris: 2_750_000 },
    // 2762-2911 / 2744-2769k over FIVE pinned runs, down from 2,803/2,944k. The
    // dearest view in the game, and still the proof that standing in a hole in
    // the ground pays for every island on the map: the cave frame carries twelve
    // portal frames, which is why it gained the most triangles from thinning
    // them (216k -> 195k) and still costs more than any view above it.
    //
    // The first cut of this row said 2777/3120/3100k off four runs. A fifth run
    // read 2911 draws — inside the same build, the same seed and the same
    // camera, so it is this scene's spread and not a regression — and a 3120
    // ceiling over a 2911 reading is 7%, not the 12% this table claims for
    // itself. Widened to the rule, with the sample that moved it named: five
    // samples of a 5% spread is not many, and a ceiling that quietly means half
    // what its header says is the thing this table keeps being rewritten about.
    { scene: 'cave-interior', label: 'cave interior', measured: 2911, draws: 3250, tris: 3_150_000 },
  ],
  // 'low' came in far under the targets it was written against (~1800 dock,
  // ~1400 open sea), so these are its MEASURED cost plus a margin rather than
  // the aspiration — a ceiling nothing has ever approached grades nothing. The
  // ratio checks below are the other half of the assertion.
  //
  // AND 'low' BARELY MOVED IN THE GEOMETRY PASS: 528k -> 515k at the dock vista
  // and 156k -> 156k at sea. That is not the pass underperforming, it is where
  // the pass landed — the pebble scatter is never built at 'low' (lowDetail
  // skips it), the ocean's outer ring at 'low' was already the coarse one the
  // other tiers were moved onto, and a 'low' portal frame is half the stones to
  // begin with. The only thing 'low' gained is the group cull, which is CPU and
  // shows up in no column here. A tier whose ceiling does not move when the
  // frame gets cheaper is a tier that was not made cheaper, and this table
  // should say so rather than let the high-tier numbers speak for both.
  low: [
    // 591-601 draws / 515k tris over five pinned runs; 601 came from the fifth.
    { scene: 'dock-vista', label: 'wide island vista (low tier)', measured: 601, draws: 680, tris: 580_000 },
    { scene: 'open-sea', label: 'open water (low tier)', measured: 283, draws: 320, tris: 180_000 },
    // The same device must afford the places a pirate actually walks into.
    // Audit r1: inland/cave 731-754k tris, respawn deck 725 draws. Pinned
    // AFTER the fixes (P.1 a+b: lightweight instance meshes on low, cave
    // rubble on the far mesh, remote pirates culled under 6 px) at the
    // measured value plus ~12% for the bot fleet's drift: cave 578 / 494k,
    // inland 428 / 392k, deck 402 / 349k. Tighten, never widen.
    { scene: 'cave-interior', label: 'cave interior (low tier)', measured: 578, draws: 650, tris: 560_000 },
    { scene: 'island-interior', label: 'island interior (low tier)', measured: 428, draws: 520, tris: 470_000 },
    { scene: 'deck-aft', label: 'on-deck aft look (low tier)', measured: 402, draws: 500, tris: 440_000 },
  ],
  // 'balanced' IS THE DEFAULT VERDICT FOR MOST MACHINES — every Intel laptop,
  // every phone, every Safari Air and every 8-thread desktop lands here — and
  // until wave 0.4 it was the one tier no row graded and no census had ever
  // read (perf-09). A regression that touched only balanced (its 1536² shadow
  // map, its FXAA path, its 300 m full-detail radius) passed this suite.
  //
  // PROVISIONAL CEILINGS: ONE pinned SwiftShader run (2026-09-02, HEAD
  // 62f29387, seed 20260801) at the +12% rule, not the four runs the high
  // table earned. Same run read high at 1212/1783k dock, 652/825k sea,
  // 1837/2777k cave, so balanced sits at 71/72%, 68/43% and 75/59% of high.
  // Lane 2.6 (PERF-01) re-pins these off four runs when it lands the tier
  // rules; until then a red row here is a reading to check, not a verdict.
  // Mutation proof (run 2026-09-02): InstanceLod PROP_DENSITY_RAMP.balanced
  // never thinning + MIN_INSTANCE_PIXELS.balanced 0.1 → open-sea 396k and
  // cave-interior 1944k triangles, both rows FAIL; dock-vista only rose 6%
  // (its props sit inside the 300 m full-detail radius), so it is the two
  // far-prop scenes that guard the ramp, not the vista.
  balanced: [
    { scene: 'dock-vista', label: 'wide island vista (balanced tier)', measured: 864, draws: 970, tris: 1_430_000 },
    { scene: 'open-sea', label: 'open water (balanced tier)', measured: 442, draws: 495, tris: 395_000 },
    { scene: 'cave-interior', label: 'cave interior (balanced tier)', measured: 1374, draws: 1540, tris: 1_835_000 },
  ],
  // DEVICE ROWS (b1.5d, performance-12). An emulated iPhone 14 (844x390 @3) and
  // iPad (1024x768 @2), tier left to the detector (low, reason 'mobile'), the
  // resolution held where the b1.5c pixel profile opens it. Ceilings are the
  // section-3 device table: phone <= 450 draws / 400k tris / 66 programs, iPad
  // <= 550 / 500k / 66 (programs: see DEVICE_PROGRAMS).
  phone: DEVICE_ROWS_PHONE,
  ipad: DEVICE_ROWS_IPAD,
};

/** THE GILDED WRECK gets her OWN ceiling, and it is not the dock's.
 *
 *  She only exists for one storm phase in the middle of a match, so she never
 *  showed up in either scene above — and near-wreck frames were measured at
 *  2888-2971 draws against a 2900 ceiling that was never meant to cover her.
 *  Re-derived after the geometry pass over four pinned runs: 1576-1845 draws,
 *  1627-1688k tris. Hers is the widest DRAW spread left in the suite (17%) and
 *  the reason is hers alone — she rises at a ring centre that moves, so what is
 *  behind her is a different set of islands each run.
 *  Grading her by the dock's number is grading two different views with one
 *  ruler: nobody looking at the wreck is also looking at a dock, a tavern and
 *  a full island of props.
 *
 *  Needs a wreck up: the runner hands PIRATES_WRECK_SEC to any server it starts
 *  itself, and SKIPS this one scene (never fails) against a server that was
 *  already running without it. */
export const WRECK_BUDGET = { label: 'the Gilded Wreck alongside', measured: 1845, draws: 2100, tris: 1_900_000 };

/** The low tier exists to be CHEAPER. These are the ratios it must beat against
 *  the same scene at 'high' — a 'low' that saves nothing is a menu entry that
 *  lies to the player about what it will do for their frame rate.
 *
 *  Measured on the pinned map, low comes in at 30-34% of high's draws and
 *  18-30% of its triangles, so the 0.72/0.68 these started at could have been
 *  met by a 'low' twice as expensive as the one that ships. */
export const LOW_TIER_MAX_RATIO = { draws: 0.50, tris: 0.45 };
/** And 'balanced' exists to be cheaper than 'high' by a margin a player can
 *  feel: at most 80% of high's draws and triangles at the same placement. */
export const MID_TIER_MAX_RATIO = { draws: 0.80, tris: 0.80 };
/** PER-ROW EXCEPTION, and the reason it exists is written down so lane 2.6
 *  can retire it. The dock vista at HIGH is the one row whose reading moves
 *  from run to run: 1006-1212 draws over the wave-0 gate runs, on the same
 *  seed, the same camera and a settled LOD — while balanced held 850-879.
 *  What moves is the far field: bot hulls beyond balanced's 300 m full-detail
 *  radius are drawn in full at high and thinned at balanced, and WHICH hulls
 *  lie in that frustum is a fact about where the bots have sailed by the time
 *  the reading lands (match ids are fresh uuids, so the bots' RNG is too).
 *  A 0.80 cap against that spread failed 1 run in 3 with balanced unchanged
 *  ('balanced 850 vs high 1006, 84.5%'), and test-perf-budget is on the
 *  do-not-regress list, so a 33% flake there blocks every wave's closing run.
 *  A median of three passes inside ONE run cannot help: the variance is
 *  between runs, not between frames. Open-sea and cave-interior stay at 0.80
 *  (they are the two rows the InstanceLod mutation proof actually moves; the
 *  vista only rose 6% under it, so 0.90 costs this gate nothing it had).
 *  Lane 2.6 (PERF-01) re-pins from four runs and deletes this map. */
export const MID_TIER_MAX_RATIO_BY_SCENE = { 'dock-vista': { draws: 0.90, tris: 0.90 } };
export const midRatioFor = (scene) => MID_TIER_MAX_RATIO_BY_SCENE[scene] ?? MID_TIER_MAX_RATIO;

/** SHADOW PASS SHARE (b3.1h, performance-11). The sun's depth pass may cost at
 *  most this fraction of the MAIN pass's triangles, per graded scene, per tier
 *  that has a shadow map. Casters render one LOD coarser than the mesh they
 *  shadow (ShadowProxy.ts): a prop batch drawing its near mesh casts its far
 *  sibling, a batch drawing far casts nothing, and only the hull you stand on
 *  keeps LOD0 casting. Without that policy every LOD0 triangle is paid twice;
 *  the rebuild's 3-6x hero LOD0s would land in the depth map at full cost.
 *  Balanced shares the rule through its 1536 map; high is the graded row.
 *
 *  0.30, not the spec's 0.45: measured (SwiftShader, seed 20260801, high) the
 *  policy reads 13.7-14.9% dock-vista / 10.3-21.6% deck-aft (its main pass
 *  swings 924k-1751k with the drifting hull's framing) / 0% open-sea /
 *  15.3-16.1% waterfall-deck / 9.3-9.5% cave-interior over two runs, and the
 *  pre-policy build 33.1 / 18.2 / 0 / 35.5 / 18.9%. 0.45 would pass the build
 *  without the policy on every row; 0.30 fails it at the vista and the
 *  waterfall and leaves 1.4x over the worst policy reading. */
export const SHADOW_PASS_MAX_SHARE = { high: 0.30 };
/** The policy's own saving, summed over the tier's graded scenes: depth-pass
 *  triangles as shipped <= this fraction of the same frames with the policy
 *  off. Measured 861k / 1795k = 0.48 at high (b3.1h). */
export const SHADOW_POLICY_MAX_KEEP = { high: 0.70 };
// ═══ test-fill-budget: stencil census at the low tier (layers of overdraw per pixel) ═══════════════
// sky <= 0.55 of a layer, whole frame and blended-only ceilings per scene (desktop, phone, iPad).
export const FILL_BUDGET = {
  'dock-vista': { sky: 0.55, whole: 1.9, blended: 0.9 },
  'deck-aft': { sky: 0.55, whole: 2.2, blended: 0.9 },
  'open-sea': { sky: 0.55, whole: 1.9, blended: 0.9 },
};

// ═══ test-first-draw-budget: meshes that may appear for the first time in one frame ════════════════
// The test also asserts src/client's firstDrawRemaining() starts at this value, so the runtime cap
// and the graded cap cannot drift apart.
export const FIRST_DRAW_ALLOWANCE = 48;

// ═══ test-ocean-tier: ocean fragment-shader op count per tier (OCEANTIER-01) ═══════════════════════
export const OCEAN_FRAG_OPS = { low: 950, balanced: 1400, high: 1750 };

// ═══ test-snapshot-size: wire bytes ═════════════════════════════════════════════════════════════════
export const SNAPSHOT_BYTES = {
  hot: 8 * 1024, // 31 Hz hot payload
  full: 35 * 1024, // 10 Hz quantised full
  worldFull: 250 * 1024, // full + static world (rides ~1/20 s and the join)
  egressPerSecond: 120 * 1024, // per client, every roster config
  joinCompressed: 60 * 1024, // compressed join message (printed until WIRE-01 c lands, then asserted)
};

// ═══ test-frame-governor: framebuffer pixel ceilings and governor stability ════════════════════════
export const FRAME_GOVERNOR = {
  // A High pin on the owner's M2 Air (1470x956 @2) opens at <= 1.45 Mpx; an Intel UHD 620
  // ultrabook (1536x864 @1.25) at <= 1.2 Mpx (+ one row and one column of rounding, never more);
  // an Adreno phone (412x915 @2.625) at <= 0.9 Mpx (+2%), never narrower than the legibility floor.
  airHighMaxPixels: 1_450_000,
  integratedHighMaxPixels: 1_200_000,
  phoneHighMaxPixels: 900_000,
  legibilityFloorWidthPx: 640,
  // No tier on an iPhone 14 landscape may exceed the phone pixel budget (Mpx).
  phoneTierMaxMpx: 0.52,
  // Stability of the settled scalar: total variation over the last minute, under jitter, and band.
  settledTotalVariation: 0.15,
  jitterTotalVariation: 0.25,
  settledSpread: 0.12,
  // Low tier + mobile pixel profile: open band and floor per device (section 3.4 C/D columns).
  mobileRows: [
    { name: 'iPhone 14 landscape', w: 844, h: 390, dpr: 3, openMin: 0.45, openMax: 0.60, floorMin: 0.30 },
    { name: 'iPhone SE landscape', w: 667, h: 375, dpr: 2, openMin: 0.45, openMax: 0.60, floorMin: 0.30 },
    { name: 'Pixel 7 landscape', w: 915, h: 412, dpr: 2.625, openMin: 0.45, openMax: 0.60, floorMin: 0.30 },
    { name: 'iPhone 15 Pro Max landscape', w: 932, h: 430, dpr: 3, openMin: 0.45, openMax: 0.60, floorMin: 0.30 },
    { name: 'iPad Air 11 landscape', w: 1180, h: 820, dpr: 2, openMin: 0.70, openMax: 0.816, floorMin: 0.44 },
    { name: 'iPad Pro 12.9 landscape', w: 1366, h: 1024, dpr: 2, openMin: 0.70, openMax: 0.816, floorMin: 0.44 },
  ],
};

// ═══ resident memory (b1.7b, critique gap 9; PLAN 3.4 device table) ═════════════════════════════════
// memoryCensus() after a scripted 60 s tour on the emulated device (scripts/test-memory-budget.mjs):
// gpuMB = geometry + textures + render targets + drawing buffer, texturesMB = unique texture sources,
// heapMB = performance.memory.usedJSHeapSize (Chromium) or the census estimate elsewhere. MB = 2^20.
// The desktop rows land in b3.1b and the per-family rows in b3.1g; both only ever tighten these.
export const MEMORY_BUDGETS = {
  phone: { gpuMB: 140, texturesMB: 64, heapMB: 120 },
  ipad: { gpuMB: 220, texturesMB: 96, heapMB: 150 },
  // b3.1b: the desktop low row (section 3 column 1: Air-class laptop on the low tier, 960x540 @1).
  desktopLow: { gpuMB: 256, texturesMB: 96, heapMB: 150 },
};

// ═══ test-tick-budget: server ms per tick (b2.1h) ═══════════════════════════════════════════════════
// 12 hulls in combat at storm sea state, measured on this Air (quiet host: p50 1.07 / p99 1.96 ms).
export const TICK_BUDGET = { p99Ms: 4.0, p50Ms: 2.0 };

// ═══ test-bundle-budget: JavaScript on the wire, KB of brotli q11 (b3.1f, performance-10) ════════════
// entryBr = the entry chunk; toMenuBr = entry + its static import closure (the menu shell); totalBr =
// every chunk + workers; chunkBr = any single chunk. Decoders (meshopt/basis/zstd, KTX2Loader) are
// excluded from every row: they are paid in the world stage (test-model-transport). PLAN section 4 b3.1f.
// measured 2026-09-25 at fefa9f47 (one entry, no split): entry 375.0, toMenu 491.8, total 497.0.
export const BUNDLE_BUDGETS_KB = { entryBr: 180, toMenuBr: 330, totalBr: 520, chunkBr: 300 };

// ═══ test-model-transport + test-memory-budget: bytes and residency PER ASSET FAMILY (b3.1g, D27) ══════
// Brotli MB on the wire per download set (moved here from test-model-transport, b3.1a): boot = the 11
// files the hull and the player's hands need; world = everything fetched before the countdown ends
// (world GLBs, far siblings, story proxies); lazy = story LOD0 streamed by distance; far = *_far only.
export const MODEL_SET_BUDGETS_MB = { boot: 0.6, world: 6, lazy: 12, far: 1 };

/** Every GLB key belongs to exactly one family (src/client/assets/modelManifest.ts MODEL_FAMILY_OF). */
export const MODEL_FAMILIES = ['shared', 'characters', 'weapons-tools', 'ship-hardware-kit', 'rocks-cliffs',
  'flora-canopy', 'props-poi', 'buildings-story', 'creatures-kraken', 'instruments'];

/** D27 allocation, wire (brotli MB). world* gate the countdown, streamed* never do. The per-family rows
 *  are NOT in ALL_BUDGETS on purpose: a [realloc] commit may move bytes between rows (rule 13). What the
 *  ratchet grades is the column sums below, and test-model-transport fails unless every column of this
 *  table sums to its FAMILY_WIRE_TOTALS_MB value exactly (so raising a row means lowering another). */
export const FAMILY_WIRE_MB = {
  shared: { worldDesktop: 0.6, worldMobile: 0.5, streamedDesktop: 0, streamedMobile: 0 },
  characters: { worldDesktop: 1.3, worldMobile: 1.1, streamedDesktop: 2.0, streamedMobile: 0.8 },
  'weapons-tools': { worldDesktop: 0.9, worldMobile: 0.7, streamedDesktop: 0, streamedMobile: 0 },
  'ship-hardware-kit': { worldDesktop: 0.5, worldMobile: 0.4, streamedDesktop: 1.2, streamedMobile: 0.5 },
  'rocks-cliffs': { worldDesktop: 0.8, worldMobile: 0.6, streamedDesktop: 1.8, streamedMobile: 0.9 },
  'flora-canopy': { worldDesktop: 0.5, worldMobile: 0.3, streamedDesktop: 1.0, streamedMobile: 0.4 },
  'props-poi': { worldDesktop: 0.4, worldMobile: 0.3, streamedDesktop: 1.0, streamedMobile: 0.5 },
  'buildings-story': { worldDesktop: 0.7, worldMobile: 0.35, streamedDesktop: 4.4, streamedMobile: 2.4 },
  'creatures-kraken': { worldDesktop: 0.25, worldMobile: 0.2, streamedDesktop: 0.6, streamedMobile: 0.5 },
  instruments: { worldDesktop: 0.05, worldMobile: 0.05, streamedDesktop: 0, streamedMobile: 0 },
};
export const FAMILY_WIRE_TOTALS_MB = { worldDesktop: 6.0, worldMobile: 4.5, streamedDesktop: 12.0, streamedMobile: 6.0 };

/** D27 allocation, GPU texture MB resident per tier (iPad grades the low column). The D27 table has nine
 *  rows: instruments share the creatures-kraken row (FAMILY_TEXTURE_ROW_OF). Same realloc rule. */
export const FAMILY_TEXTURE_MB = {
  shared: { high: 48, balanced: 28, low: 22, phone: 14 },
  characters: { high: 24, balanced: 12, low: 8, phone: 6 },
  'weapons-tools': { high: 16, balanced: 12, low: 10, phone: 8 },
  'ship-hardware-kit': { high: 32, balanced: 16, low: 12, phone: 8 },
  'rocks-cliffs': { high: 40, balanced: 16, low: 12, phone: 8 },
  'flora-canopy': { high: 32, balanced: 14, low: 10, phone: 6 },
  'props-poi': { high: 24, balanced: 10, low: 8, phone: 5 },
  'buildings-story': { high: 28, balanced: 12, low: 8, phone: 5 },
  'creatures-kraken': { high: 12, balanced: 8, low: 6, phone: 4 },
};
export const FAMILY_TEXTURE_ROW_OF = { instruments: 'creatures-kraken' };
export const FAMILY_TEXTURE_TOTALS_MB = { high: 256, balanced: 128, low: 96, phone: 64 };
/** DECLARED texture deviations (same contract as the wire list: only shrink, the ratchet holds upTo).
 *  Measured at b3.1g on the dev server after the tour (iPhone 14 profile): shared 20.5-20.8 MB against the
 *  14 MB phone row, because every procedural canvas texture (ocean bathymetry 1 MB, the ~40 512x192 ship
 *  and HUD canvases at 0.5 MB each) is untagged and so charged to `shared`. */
export const FAMILY_TEXTURE_DEVIATIONS_MB = {
  'shared.phone': { upTo: 21, owner: 'b3.4 / b4.4 (tag procedural ship/island canvases to their family, halve them on phones)', measured: 20.8 },
};

/** DECLARED deviations: family rows today's (unrebuilt) GLBs overflow, measured at b3.1g (HEAD cd33720b,
 *  brotli q9). `upTo` is the reading rounded up to 10 KB; a reading above it FAILS, and so does an entry
 *  whose family is back inside its D27 row (delete it: this list may only shrink, the ratchet holds each
 *  upTo). The owner lane's rebuild (LOD chains, KTX2, weld-then-decimate) brings the row inside. */
export const FAMILY_WIRE_DEVIATIONS_MB = {
  'weapons-tools.worldDesktop': { upTo: 1.02, owner: 'b3.4 (hero weapons/tools)', measured: 1.011 },
  'weapons-tools.worldMobile': { upTo: 1.02, owner: 'b3.4 (hero weapons/tools)', measured: 1.011 },
  'ship-hardware-kit.worldDesktop': { upTo: 0.61, owner: 'b3.4 (ship hardware kit)', measured: 0.606 },
  'ship-hardware-kit.worldMobile': { upTo: 0.61, owner: 'b3.4 (ship hardware kit)', measured: 0.606 },
  'rocks-cliffs.worldDesktop': { upTo: 1.03, owner: 'b4 (islands: rocks/cliffs LOD chains)', measured: 1.026 },
  'rocks-cliffs.worldMobile': { upTo: 1.03, owner: 'b4 (islands: rocks/cliffs LOD chains)', measured: 1.026 },
  'flora-canopy.worldMobile': { upTo: 0.46, owner: 'b4 (islands: flora LOD chains, phone set)', measured: 0.457 },
  'buildings-story.worldDesktop': { upTo: 1.22, owner: 'b4 (buildings/fort/docks LOD chains)', measured: 1.217 },
  'buildings-story.worldMobile': { upTo: 1.22, owner: 'b4 (buildings/fort/docks LOD chains)', measured: 1.217 },
  'buildings-story.streamedMobile': { upTo: 3.75, owner: 'b4 (phones stream story LOD1, never LOD0: D27)', measured: 3.748 },
  'total.worldMobile': { upTo: 4.91, owner: 'the rows above (phones fetch the desktop world set today)', measured: 4.905 },
};

// ═══ the ratchet's view ═════════════════════════════════════════════════════════════════════════════
/** Every graded family, by the name the ratchet and the baseline fixture use. */
export const ALL_BUDGETS = {
  perf: PERF_BUDGETS,
  perfWreck: WRECK_BUDGET,
  perfDevicePrograms: DEVICE_PROGRAMS,
  perfLowTierMaxRatio: LOW_TIER_MAX_RATIO,
  perfMidTierMaxRatio: MID_TIER_MAX_RATIO,
  perfMidTierMaxRatioByScene: MID_TIER_MAX_RATIO_BY_SCENE,
  perfShadowPassMaxShare: SHADOW_PASS_MAX_SHARE,
  perfShadowPolicyMaxKeep: SHADOW_POLICY_MAX_KEEP,
  fill: FILL_BUDGET,
  firstDrawAllowance: FIRST_DRAW_ALLOWANCE,
  oceanFragOps: OCEAN_FRAG_OPS,
  snapshotBytes: SNAPSHOT_BYTES,
  frameGovernor: FRAME_GOVERNOR,
  memory: MEMORY_BUDGETS,
  tick: TICK_BUDGET,
  bundle: BUNDLE_BUDGETS_KB,
  modelSets: MODEL_SET_BUDGETS_MB,
  modelFamilyWireTotals: FAMILY_WIRE_TOTALS_MB,
  modelFamilyTextureTotals: FAMILY_TEXTURE_TOTALS_MB,
  modelFamilyWireDeviations: FAMILY_WIRE_DEVIATIONS_MB,
  modelFamilyTextureDeviations: FAMILY_TEXTURE_DEVIATIONS_MB,
};

/** Keys that are readings or scene inputs, never budgets. */
export const NOT_A_BUDGET = new Set(['measured', 'w', 'h', 'dpr']);
/** Keys where BIGGER is stricter. Everything else numeric is a ceiling (smaller is stricter). */
export const FLOOR_KEYS = new Set(['openMin', 'floorMin', 'legibilityFloorWidthPx']);

/** 'ceiling' | 'floor' | null for the last key of a dotted path. */
export function directionOf(path) {
  const key = String(path).split('.').pop();
  if (NOT_A_BUDGET.has(key)) return null;
  return FLOOR_KEYS.has(key) ? 'floor' : 'ceiling';
}

/** Flatten a budget tree to { 'perf.high.dock-vista.draws': 1950, ... }. Array rows are keyed by
 *  their scene/name so a reorder is not a diff; numbers only. */
export function flattenBudgets(tree = ALL_BUDGETS, prefix = '') {
  const out = {};
  const walk = (v, p) => {
    if (typeof v === 'number') { if (directionOf(p)) out[p] = v; return; }
    if (Array.isArray(v)) { v.forEach((row, i) => walk(row, `${p}.${row?.scene ?? row?.name ?? i}`)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(tree, prefix);
  return out;
}
