# The test suite, one line at a time

*Audited 2026-08-04 on the fanless Air, SwiftShader, map seed 20260801, against
a stack the audit owned (vite :3101, server :8091). Harness revised 2026-09-02
(HARNESS-01): server tier, per-tier timeouts, summary.json, quick tier, the
scripts/ sweep.*

This file exists because this repo keeps shipping gates that cannot fail. Not
gates that are wrong — gates that are **vacuous**: they run, print something
encouraging, exit 0, and grade nothing. Four distinct ways of doing it have been
found here, each more than once:

| failure mode | the instance that cost the most |
|---|---|
| exits 0 without asserting | `test-perf-budget` hit an unpinned world, printed a skip and `return`ed — `npm run test:perf` reported success in two seconds for a week |
| grades the machine, not the client | `test-gameplay-smoke`'s `fps > 0`; three assertions in `test-hud-death-and-feed` graded this Air's frame rate against reads the game integrates on a clamped clock |
| not wired into any npm script | eight test-shaped files, including **both** gates for the remote-motion wave |
| ignores `PIRATES_BR_URL` | a graded run moved the page and the suite went to `:3000` anyway — `ERR_CONNECTION_REFUSED` in half a second, an exit code identical to a real failure |

**A fifth was found by this audit and is the reason for the first commit in it:**
`PIRATES_BR_URL` moved the *page* and nothing moved the *socket*. Every browser
suite pointed at a runner-owned Vite still opened its WebSocket against
`:8090` — the developer's live server — so it graded an unpinned world and put a
headless bot in a human's match. `vite.config.ts` now bakes
`PIRATES_BR_SERVER_PORT` into the bundle.

## How to run it

```
npm test              # everything: 62 logic, 2 server, then 24 browser suites
npm run test:quick    # typecheck + the 52 sub-second logic suites (~15 s; 60 s soft ceiling)
npm run test:logic    # logic only — no stack, no ports
npm run test:server   # the LobbyServer suites — each boots its own server on port 0
npm run test:browser  # browser only
npm run test:audit    # is every top-level scripts/*.mjs a wired suite or a declared non-gate?
npm run test:perf     # = run-all-tests --only perf-budget (through the runner, pinned stack)
node scripts/run-all-tests.mjs --only hud,minimap
```

Every run writes `test-results/summary.json` (HEAD, argv, wall time, and per
suite: tier, verdict, ms, bytes, exit code) and prints the slowest five. Pick a
subset from that file, not from memory.

`npm test` stands up **its own** server and Vite on 8091/3101 pinned to map seed
20260801, runs every suite in its own process (never in parallel — this machine's
window server has been taken down by concurrent headless GL), and prints a
verdict per suite. It never touches 3000/8090, where a human plays.

The manifest is `scripts/lib/suites.mjs`. It is the only list; `package.json` no
longer contains one.

## The five verdicts

| verdict | meaning |
|---|---|
| `PASS` | exit 0 **and** it printed at least one graded line (`✓` / `PASS` / `OK:`) |
| `FAIL` | non-zero exit |
| `VACUOUS` | **exit 0 with nothing graded.** Counted as a failure. This is the verdict `test-perf-budget` would have got for a week |
| `TIMEOUT` | killed by the tier's watchdog rather than hung on forever: logic and server 120 s, browser 15 min, or the suite's own `timeoutMs` (net-resilience 120 s). `PIRATES_SUITE_TIMEOUT_MS` overrides all |
| `SKIPPED` | declared in the manifest with a written reason. Printed as `NOT GRADED`, counted as a pass by nobody |

`VACUOUS` is the point of the whole exercise. A suite cannot get a green tick
here by declining to measure.

---

## Browser suites (26)

All read `PIRATES_BR_URL`; all reach the pinned server through the Vite that
bakes its port. `slow` ones run last so a cheap failure is reported in the first
minute rather than the twentieth.

| suite | what it can actually fail on | can it fail? | notes |
|---|---|---|---|
| `test-gameplay-smoke` | joins, HUD reads BR state, canvas present, frames produced, no page errors | yes | **fixed previously**: its `fps > 0` check graded machine load. Frame pacing is now asserted only on the GPU path and the software path asserts frames *produced*, in frames, not in a rate |
| `test-lod-reveal` | detail tiers fade in over a band instead of popping in one frame | yes | refuses to grade a built bundle — insists on the Vite that serves the working tree |
| `test-minimap` | minimap renders, orients, and tracks | yes | |
| `test-chart-and-feed` | four contracts that "rot silently because nothing throws" | yes | |
| `test-music-render` | the live-synthesised score actually produces audio buffers | yes | |
| `test-onboarding-ux` | every line a first-time pirate is told | yes | |
| `test-geometry-lod` | per-source triangle ceilings the total-draws budget cannot see | yes | needs the pinned map |
| `test-shadow-gate` | the depth pass is skipped exactly when there are no casters | yes | |
| `test-decor-batch` | which named meshes are safe to merge away | yes | **fixed in this audit**: read only `PIRATES_BR_TEST_URL`, a name nothing else uses, defaulting to `:3101` — a port that exists only when an agent has a Vite up. Now reads `PIRATES_BR_URL` |
| `test-frame-allocation` | bytes a steady-state CPU frame throws away | yes | reads one frame at a time; a heap delta across frames measures allocation minus GC |
| `test-frame-governor-live` | the governor in a real GL context | yes | **has `--mutate`** |
| `test-join-stall-survival` | a pinned main thread must not read as a dead player | yes | induces the stall on purpose |
| `test-frame-pacer` | the frame cap holds on 90/120/144 Hz rAF (60 +-1, 30 +-1), per-form defaults (desktop display rate, tablet 60, phone 30 + 60 opt-in, Battery saver 30), the governor targets the cap and grades RENDERED intervals, a paced phone climbs to what it holds without pumping (b1.5c) | yes | **has `--mutate=noskip|governor`** |
| `test-sim-lag-honesty` | a slow client must never be reported as a slow server | yes | **has `--mutate`** |
| `test-motion-continuity` | moving things keep moving between snapshots; deck passengers hold station | yes | reports **ungraded** rather than passed when it sampled too little — the right pattern, and the model for `VACUOUS` |
| `test-remote-smoothness` | remote bodies are drawn along a continuous path | yes | **wired for the first time in this audit** — shipped with the remote-motion wave and run by nothing |
| `test-viewmodel-poses` | first-person pose invariants | **not here** | `if (IS_SOFTWARE_GL) { console.log('skipped'); process.exit(0) }` — exit 0 is what a pass looks like, so every graded run on this machine has reported a green suite that measured nothing since it was written. The reason is real; it is now a declared `SKIPPED`, not a silent zero |
| `fixwave4-smoke` | seven features are one game, not seven lanes | yes | **eight failures fixed in this audit — see below.** Went 18/26 → 29/31 |
| `audit-live-floaters` | every seated prop touches the ground it is drawn on, as seen | yes | slow |
| `test-program-warm` | no shader links in a frame the player moves through when the backend exposes non-blocking readiness; zero proactive warm work otherwise | yes | **has `--mutate`** on capable backends; tours nine islands and dies. A backend without `KHR_parallel_shader_compile` is explicitly the pre-warmer path, because forcing a join there freezes the tab |
| `test-load-responsiveness` | the longest task of a cold load, plus the invariant that warm-up never synchronously joins an unready program | yes | **rebuilt in this audit — see below**; unsupported backends grade zero proactive compiles/joins rather than manufacturing a multi-second “warm” slice |
| `test-perf-budget` | draw-call and triangle ceilings per scene | yes | fails rather than skips on an unpinned world, which is what it used to do |
| `test-hud-death-and-feed` | the whole death/respawn/feed HUD | yes | **four failing assertions fixed in this audit — see below** |
| `test-fill-budget` | stencil census: sky layers ≤ 0.55, whole/blended overdraw ceilings | yes | wave 0.4; **has `--mutate`** (sky `depthTest=false` must FAIL); slow |
| `test-storm-wall` | the old storm-wall-probe as a gate: night sea ≤ sky luma, noon sea chroma ≤ 1.3× sky | yes | wave 0.4; **red by design**; its noon-chroma half is the SEA's body colour (storm-12), not STORMVIS-01, so lane 5.4 does not close it; slow |
| `test-storm-visuals` | STORMVIS-01: the one weather anchor, the leak gate's sea-state, thunder delay, the deleted halo/ring/rain-canvas, and the storm-front + sky storm terms read back out of the shipped GLSL | yes | lane 5.4; logic tier, quick (0.2 s), no stack |
| `test-viewmodel-envelope` | the five authored weapon GLBs land in the primitive envelope the viewmodel constants were measured in; nothing reaches back toward the eye | yes | fixup wave 4; logic tier, quick (0.3 s), no stack; **has `PIRATES_BR_MUTATE_VIEWMODEL=nofit`** (the unfitted hero must FAIL: flintknock overhangs 382 mm) |
| `test-prediction` | PRED-01: the shared `stepPirate` against a transcription of the pre-extraction `Match.applyInput` block (600-tick land tape + 600-tick swim tape, bit-identical), the grounded/jump gate on generated terrain, the `input_ack` receipt (shape, mm quantisation, 183 B, the hot-tick call site), and reconciliation under a 6-tick ack delay | yes | lane 6.4; logic tier, quick (~2 s), no stack; section 6 carries its own CONTROL (dead reckoning alone diverges 0.558 m) so it cannot pass vacuously |
| `test-wan-netcode` | b1.3e real-internet bar: a real bot Match replayed both ways through `scripts/net-shim.mjs` (TCP model: 150 ms RTT, 30 ms jitter, 1% loss, in-order head-of-line stalls), the real `ClientState` + `RemoteInterpolator` on a virtual clock, the shared `PredictionRing`/`stepPirate` reconciliation on real `input_ack`s, per-client downstream through the lobby's deflate. Seeded (`PIRATES_BR_MAP_SEED`, virtual `Date.now`, reseeded `Math.random`: same seed, same numbers). Remote pirates graded in VECTOR form and split: ashore at the launch bar (p99 <= 0.02 m, <= 1.0 disc/body-s, met on seeds 1-7), aboard at its measured bound (p99 <= 0.3 m; shipped 0.169-0.187, buffer-0 mutant 0.489-0.641 over seeds 1-7), held <= 3%, downstream <= 120 KB/s; `--strict` grades the launch bar on both populations + recon < 0.3 m and is RED until b2.0d | yes | lane b1.3e; logic tier (~45 s, timeout 240 s), no stack, not quick; same-run mutants (buffer forced 0 ms, no-replay snap) must FAIL on both populations, VACUOUS counts as FAIL; `--buffer-ms 0` is the red run; `WAN_STATS=1` prints per-population quantiles |
| `net-shim --self-test` | the WAN link model under test-wan-netcode: one-way mean ~75 ms, ~1% segment loss, in-order delivery, loss surfacing as head-of-line stalls, message p50 about one way and p99 above the RTT, the LAN profile never stalling | yes | lane b1.3e; logic tier, quick (0.05 s), no stack |
| `fly-launch --self-test` | the soft-launch program's graders on fixtures: 1-machine status, check colours, lag < 0.1 s, 30% MAX_MATCHES headroom, humans-per-machine lookup, the fly.toml + DEPLOY.md capacity stamp | yes | lane b1.3c; logic tier, quick (0.06 s), no network |
| `ci-rollback-dryrun` | deploy.yml's own step scripts run offline with fake flyctl/node: the dry run never deploys, a forced-red smoke rolls back to the previous non-destroyed image, HEALTH_KEY reaches the smoke; `--run <id>` grades a live GitHub run | yes | lane b1.3d; logic tier (~3 s), offline; 20 clauses |
| `test-run-batch-gate` | the cumulative batch-gate runner `scripts/run-batch-gate.mjs` (`--sync` from the campaign plan into `scripts/fixtures/batch-gates.json`, `--batch bN [--dry-run|--suites-only|--deploy] [--fresh]`): fixture == fresh sync, dry-run b1..b5 lists every suite and gate(bN) ⊇ gate(bN-1), an unregistered un-planned name / a shrinking gate / an unimplemented live item FAIL the sync; on a fake registry one FAIL exits 1, a re-run skips the saved PASS and re-runs the FAIL, `--fresh` and a PASS older than a scripts/ change re-run, VACUOUS / TIMEOUT / MISSING / failed review each fail, a deploy gate without `--deploy` exits 4 | yes | lane b1.3f; logic tier (~3 s), no ports; RED on a mutant runner (no resume, no VACUOUS, no superset check): 7 clauses FAIL |
| `test-client-prediction-parity` | PRED-01/physics-09: the client's mirror of a server pushout stands where the server's does — the swim-hull section with the hull's own draft and the depth taper | yes | lane 6.4; logic tier, quick (~1 s), no stack; sections 1-2 carry CONTROLS (the pre-fix client arguments disagree by 2.880 m). The prop / tavern / cave-wall / slope half of physics-09 is NOT graded yet — w6.4 slice d2, deferred, lands here |
| `test-shadow-bias` | SHADOW-01: cascade split/bias table, peter-panning and acne bounds | yes | lane 4.3; logic tier, quick, no stack |
| `test-ship-geometry-hash` | the drawn hull geometry is byte-identical to a pinned baseline per class | yes | lane 4.2; logic tier; re-pin deliberately, never silently |
| `test-static-serving` | the built client is served with the headers and precompressed siblings it ships | yes | lane 5.1; logic tier |
| `test-hero-assets` | HERO GLB census: triangle band, one textured material, white COLOR_0, node names, pivots, no skins, draw split, far LOD | yes | lane 5.3; logic tier, plain node; **has `PIRATES_BR_MUTATE_HERO`** |
| `test-wildlife-flee` | WILD-01: an animal that is shot at leaves, and the flee state is the server's | yes | lane 4.5; logic tier |
| `test-cave-audio` | CAVE-01: the drip bed and the cave reverb send are driven by the shipped cave state | yes | lane 5.5; logic tier; **has `PIRATES_BR_MUTATE_DRIP=grid`** |

## Server suites (3)

Both gained cases in wave 0: `test-http-hardening` now proves a throw in a single
placement, in a whole cohort, and in `spawnMatch` itself (new Match / setupWorld /
start) strands nobody — each member gets `lobby_error` + `lobby_left` and can
queue again — and that `/bugsnap` is 404 without `PIRATES_BR_DEV=1` or a key.

A real `LobbyServer` on a real socket, no browser. Both sat in the logic tier
("no ports") while binding fixed ports (8791, 8792); a stale listener on 8791
held `test-net-resilience` until the 900 s kill and a two-minute logic run took
seventeen, with nothing recording why. Now each calls `init(0)`, reads
`server.boundPort`, and carries a timeout sized off a real run
(net-resilience needs 47 s of heartbeat windows). `PIRATES_BR_TEST_PORT` pins
a port for a human watching.

- `test-net-resilience.mjs` (timeout 120 s)
- `test-http-hardening.mjs` (timeout 60 s)
- `test-lobby-flow.mjs` (timeout 180 s) — wave 2.3 (PARTY-01): the lobby state
  machine end to end (create / join / ready / kick / crown / start / horn /
  play again / auto-detach / reap / queue cohort), 35 assertions, 27 of them
  red at `f4cbb078`. It turns the 25 s auto-detach, 60 s match reap, 15 s queue
  and 30 s join lockout down through `LobbyServer.tunables` rather than
  sleeping through production clocks; measured 46 s.

## Logic suites (70)

No browser, no server, no ports: they import the real simulation out of `src/`
and drive it. Every one of them prints `✓` per assertion and exits non-zero on
failure — the house pattern, and it holds throughout. Two notes:

- `test-remote-interpolation` — **wired for the first time in this audit.** The
  companion to `test-remote-smoothness`; both shipped with the wave that produced
  `docs/REMOTE_MOTION.md` and neither was run by any npm script.
- `audit-floating-props` and `test-swim-shore` print `OK:` rather than `✓` on
  success and `FAIL:`/`✗` on failure. Gradeable, so `EVIDENCE` accepts all three
  dialects.

The full list is `LOGIC` in `scripts/lib/suites.mjs`.

### Wave 0 additions (2026-09-02)

Logic tier, all node, no stack:

- `test-match-determinism` — two seeded Matches ticked 90 s side by side, state hashed each second, plus a different-matchId control (RNG-01). ~11 s, not quick.
- `test-dev-hooks` — `dev_grant_gold` / `dev_bot_peace` refused without `PIRATES_BR_DEV_HOOKS=1` (or `MatchOptions.devHooks`); a match that used one is `devAssisted` and StatsStore skips it (DEV-01). Quick.
- `test-pacing-curve` — the seeded pacing sim graded against `PACING_TARGETS.BANDS`. **Opt-in**: the manifest field `optIn: 'PACING'` means the runner reports it `SKIPPED` unless `PACING=1` is set, never a silent pass. Two 13-minute matches, so its timeout is 1,500 s. Mutation: `BOT_EARLY_PEACE_SECONDS=0` must go red.
- `test-quality-preference` — `detectRenderQuality()` per device row (Safari M2 Air, iPhone 15, Adreno 650, UHD 620, masked desktop).
- `test-bot-ghost-helm` — a bot whose lone pirate is on the respawn clock is an unmanned hull: 0 cannon shots, rudder decays to 0, while the live crew alongside still fires (BOT-02, w1.1). RED on HEAD: shotsA=2, rudder=0.6.
- `test-bot-ammo` — a bot never queues a shot for a piece with ammo 0 + reserve 0 (all 18 rounds go downrange) and tops up at the crate in a deck lull (bots-v03, w1.1). RED on HEAD: 6 of 18 fired, 72 dry shots queued, reserve stays 0.
- `test-bot-berth-truce` — a hull ANCHORED within 60 m of a dock berth is neither shot at nor sought before 270 s unless she fires first; fair game after (liveplay-19, w1.1). RED by mutation (isMooredAtBerth → false): 29 shots inside the truce, first at 159 s. `test-bot-peace-window` gained the pistol half (12 m off at t=10 s → 0 shots; aboard → shots; 7 rad/s body turn) and the retaliation case (A answers the shooter, not the nearer bystander).
- `test-projectile-hull-parity` — cannonball-vs-hull truth (HULL-01, w1.2): the tick segment is swept against the shared swim-hull skin (200 wale points per class, 0.1 m outboard clear / inboard hit; 100 stem crossings at 60 m/s), impacts classify band / topside / deck (a plunging arc opens NO hole and splinters crew within 1.5 m; a ball over the deck meets the pirate standing there), the drawn face follows the ball, and environmental damage keeps the attacker (CREDIT-01 physics half). RED on HEAD: galleon 82/200 inboard misses (skin 6.10 m), 0/100 stem crossings, deck arc → dry hole at 1.32 m, drowning nulls lastDamagedById. `test-flooding` gained the saturation block (8 open dry holes: a wetter shot evicts the driest; 20 s at the cap → 0.02/s forced ingress).

- `test-skeleton-crowd` — the island garrisons have a GLOBAL ceiling (`SKELETON_LIVE_CAP`), not just one wave per island: since bots-09 let any crew wake a garrison, bot crews ashore can arm most of the map at once, and every skeleton is both a Player in the full snapshot and (uniquely) a 22-26-draw procedural body on the client. Grades the cap over 900 s, that the budget goes to the garrison a crew is standing in, that an island which missed out rises on the next opening, and (by source assertion, since Game.ts needs a GL context) that `syncPlayers` builds no skeleton body past `SKELETON_DRAW_RANGE_SQ`. RED on HEAD: peak 31 live skeletons, 12 islands armed together, no client range gate.

**Red by design (GATES-01).** Six gates were written first and fail on HEAD on
purpose; each grades a defect the 2026-09-01 audit found unguarded and stays
red until its fix lane lands. `npm run test:logic` exits 1 for the whole
campaign because of them, so read the FAIL lines, not the exit code, until the
runner grows an `expectRed` vocabulary. They are not in the quick tier.

| suite | red on HEAD because | goes green with |
|---|---|---|
| `test-avatar-pose-invariants` | boots at -0.19, head 1.92 vs 1.68 | AVATAR-01 (wave 2) |
| `test-avatar-rig` | pirate_base.glb: 23 bones, head bone at PLAYER.HEAD_Y, 33 clips, dressed 2.8k tris / 7 draws / 6 materials | RIG-01 (wave 7.1) |
| `test-avatar-rig-drive` | PlayerRigFactory: own skeleton per pirate, dressed set, crew tint, disjoint clip masks, state→clip, soles ≥ −0.02, mixer distance LOD, low tier keeps makePlayerMesh | RIG-01 (wave 7.1) |
| `test-ship-attitude-frame` | XYZ root Euler: bow dips E/W | SHIP-01 (lane 1.3) |
| `test-ship-hole-vis` | fire burn-down / recycled slot leave the decal behind; `ship-dark-timber` bars the breach at 0.178 m | SHIP-01 (lane 1.3, landed) |
| `test-ship-helm-anchor` | wheel span on yaw rate (−12.32 rad from a ram, 0 at the helm); galleon anchor stock at +1.09 m; 7 hoist heights draw both canvases | SHIP-01 (lane 1.3, landed) |
| `test-ship-geometry` | hold floor 24/24 verts outside the loft, stern 0.85 m aft | HULLGEO-01 |
| `test-ship-plank-shader` | SHIPVIS-01 phase A: the caulking/timber/grime block reaches the drawn colour on hull and deck, the breach discard still runs after chaining, and the wet line rides the waterline foam height | SHIPVIS-01 (lane 9.6); **has `--mutate`** (renames the chunk the colour block hooks: 19/23) |
| `perf-cost-model` | perf-15 resident-geometry census: a full-match fleet built the way the client builds it stays under 8 MB of ship geometry, and `clear()` releases every shared buffer exactly once | perf-15 (lane 9.6); **has `--no-cache`** (rebuilds per hull like HEAD did: 25.37 MB) |
| `test-ship-rigging` | ships-16: every yard-attached rope still ends on its yard after a 60° brace (≤0.05 m, all three classes), and the rig is instanced cylinders rebuilt in place, not per frame | ships-16 (lane 9.6); **has `--mutate`** (restores the baked rest matrices: 19/22) |
| `test-ship-wake` | SHIPVIS-01 phase B: the Kelvin arms leave the track at arcsin(1/3) = 19.47° at four yaws and two speeds, the low tier builds none, they cost no second draw, and the fade is sub-millimetre before the draw range drops it | SHIPVIS-01 (lane 9.6); **has `--mutate`** (collapses the arms onto the track: 22/29) |
| `test-hold-lanterns` | ships-23: the hold's two lanterns are served by exactly ONE registered budget light (unmoved in position, intensity, range), hung symmetrically about it, both emissive, sharing two materials so they merge into the hull bake | ships-23 (lane 9.6); **has `--mutate`** (gives the after lantern its own light: 29/32) |
| `test-tick-order` | MATCHSPLIT-01: the tick spine — which of 30 subsystems runs when, and how many draws each takes off the seeded match rng, per tick over 400 ticks against a recorded baseline. Labels resolve to Match.prototype OR a system instance, so an extraction keeps its identity and an unregistered one fails as "no home" | MATCHSPLIT-01 (lane 7.5); red proof: swap any two `update*` calls in `Match.tick` (names the tick, the expected order and the actual) |
| `test-aim-wire` | POSE-01 wire half: `aiming`/`atCapstan` cross the wire, are momentary (cleared at the top of every tick so a dropped client cannot freeze mid-aim), refuse full hands (chest/cannon/swimming/reload), a cutlass aim stays a GUARD, and a bot raises hers from the turn not the shot | POSE-01 avatar-06/11 (lane 7.5); red proof: comment out `updateAimStance` (2 fail) or the `player.atCapstan = true` line (1 fail) |
| `test-asset-bounds` | boulder_b r 2.6 vs reach 2.3, log sphere 0.38x (world-space TRS applied) | ASSETS lane |
| `glb-census --check` | the models README's counts vs disk + `ASSET_NAMES`/`FAR_ASSET_NAMES` (78 = 63 + 15, 0 unwired) | PROPCOL-01 assets-20 (lane 2.5) |
| `test-far-lod-integrity` | every `<name>_far.glb` parsed and welded at 1e-4 against its source: rocks 0 boundary loops, every decimated far file ≥ 92% of the source's surface area and ≤ 40% of its triangles; the shark puppet on triangles only | [rocks] 2026-09-09; red proof: the 2026-09-06 far files (27 failures — boulder_a 76 loops / 42% area, searock_a 93 / 51%, bush 123 / 59%), Collapse on split vertices deleted faces |
| `test-quality-preference` | Safari M2 Air (opaque "Apple GPU") and four other rows grade `balanced` | PERF-01 (lane 2.6) |
| `test-storm-wall` (browser) | noon sea chroma 6.67× sky | STORMVIS-01 (lane 5.4) |
| `test-frame-guard` | a throwing frame body still schedules the next frame; 30 consecutive faults raise the reload overlay flag once; beacon <= 5/session, anonymous fields only; static: Game.frame() runs through FrameGuard, Renderer listens for webglcontextlost + webglcontextrestored, the audition returns while graphics are held | correctness-06 / performance-03 / online-12 (b1.1b); red on f5fee97e: 5 static checks FAIL (frame() re-arms rAF last, no context handlers) |
| `test-sound-finite` | every public SoundEngine play*/set*/start*/update*/stop* (read from the source) with NaN/undefined/+-Infinity in every numeric slot and every position/object field, against AudioParams that throw like Chromium/WebKit: 0 exceptions escape, 0 non-finite writes reach a param or start/stop, 0 faults the engine backstop had to swallow; static: every Net dispatcher callback runs inside the per-event guard | liveplay-05 (b1.1c); red on 96441ac0: 340 escapes, 334 non-finite writes; mutation (safeSet passes non-finite through): 122 writes + 122 backstop faults FAIL; Net static FAIL (47 bare callbacks) |
| `test-audio-lifecycle` | WebKit-like fake AudioContext (starts suspended, resume refused outside a gesture): 100 setAmbience + setters + one-shots before a gesture construct 0 contexts; pointerdown/touchstart do not unlock, touchend does with a 1-sample silent buffer started inside the gesture; listeners on pointerup/touchend/click/keydown disarm once running; audioSession.type 'playback' ('ambient' with mix); hidden -> suspend exactly once; refused resume re-arms; 'interrupted' re-arms and the next keydown resumes; static: Game arms the lifecycle, no pointerdown unlock | audio-08 / crossdevice-12 / D14 (b1.1c); red on 96441ac0: 1 context built by the setters, installLifecycle missing, 2 static FAIL |
| `test-connect-supervisor` | real NetworkClient on a fake socket Worker and a virtual clock: server up after 7 s -> connect() resolves exactly once, 1 live transport, 0 resume frames although sessionStorage holds an old token, 0 'Disconnected' UI for attempts that never opened, <= 7 attempts; a drop after welcome -> exactly 1 resume with this page's token; never-up server -> 1 rejection at 50-62 s then retryNow() connects; 'offline' -> offline progress, 'online' retries at once; 30 s hidden + silently dead socket -> resume within 5 s, a live socket survives; welcome buildId skew defers in a match and reloads once on returnToMenu | correctness-04 / online-10 / vm:online:2 / vm:correctness:1 / vm:crossdevice:4 (b1.1e); red on e6011baf: 16/21 FAIL (connect() never settled, stale-token resume, 4 'Disconnected' flashes, no retryNow/installLifecycle/setVersionGate) |
| `test-connect-policy` | connectSchedule sums to 60 000 ms (0.5 s -> 8 s cap); jittered live waits never pass the budget; no public host (fly.dev, LAN IP, .local, localhost.evil.com) gets 'npm run dev' in any phase, no copy shows a URL or port, localhost dev build keeps the hint; versionGate: menu reload once per server build (sessionStorage loop guard), in_match defer until the menu, 'dev'/missing ids never reload; static: Game.connectToServer has no Promise.race/6 s timeout and uses connectCopy + Retry; DIST=<dir> fails any 'npm run dev' in a built bundle without localhost in the preceding 600 chars | online-10 / online-05 / correctness-04 (b1.1e); red on e6011baf: 3 static FAIL + DIST=dist/client (Sep 9 build) 1 bad occurrence |
| `probes/context-loss-probe` (browser) | WEBGL_lose_context mid-match: frames resume <= 3 s after restore, renderer.info.programs back to the pre-loss count <= 5 s, saved auto-tier ceiling unchanged, `#gfx-restore-pill` shown then hidden; `--mutate` (restore handler removed) FAILS | performance-03 (b1.1b) |
| `probes/frame-fault-probe` (browser) | `injectFrameFault(1)` keeps frames advancing with no overlay; `injectFrameFault(60)` shows `#frame-fault-overlay` | correctness-06 (b1.1b) |
| `probes/csp-boot-probe` (browser, by hand after a build, not in the runner) | fresh `dist/` served by its own LobbyServer on 8091: self-test (CSP rewritten to `connect-src 'none'`) MUST record a violation; control (`bypassCSP:true`) and the real CSP both reach the menu and a solo match (`phase 'playing'`); under the CSP 0 `securitypolicyviolation`, 0 'Refused to' console lines, 0 page errors | online-12 (b1.2g) |
| `test-program-validity` (browser) | LINK_STATUS asked of every program at its first useProgram and of every live program at the end; 0 `useProgram` console lines over a free-cam tour (deck, hold, sea, cave, underwater) and a real walk into the water; live swim frames (surface, look down, look up) not >95% black; `--mutate` injects an unlinkable ShaderMaterial and passes only if the census sees it AND `ProgramFallback` flattens it so it stops being bound | liveplay-04, liveplay-06 (b1.1d) |
| `test-frozen-insertions` | LOGIC: PropScatterer.swapInStoryScene on a scene/environment/island graph frozen exactly like the game's (freezeStaticParent x2 + freezeStaticSubtree): every node of the late scene at parent.matrixWorld * local after three renderer walks, island stays frozen; control: a bare add() reads stale. SCAN: every `.add(x)` inside a `.then(`/setTimeout/rAF/queueMicrotask/requestIdleCallback callback in IslandBuilder.ts + world/island/*.ts refreshes x; every function in src/client reaching islandMeshes.get()/`.inst.parent` that adds a node refreshes it or is in COVERED with an asserted per-frame refresh (EnvironmentFx.buildHarvestClone); scanners self-test on bad snippets | islands-16 / verified missing-3 (b1.1f); red with HEAD 69189598's PropScatterer (`--src`): the story swap's `parent.add(real)` in `.then(` flagged, no refreshFrozenChild(real) |
| `test-dig-sparkle` | makeDigSparkle(tex): 8 motes, material.map === the handed sprite, additive, depthWrite off, toneMapped false, gold 0xffd77a, alphaTest 0, no onBeforeCompile; EntityMeshes passes host.getSoftParticleTexture(); Game's soft sprite is a centred radial gradient to alpha 0 at size/2 (corner alpha 0 < 0.1); program census: distinct PointsMaterial variants in src/client <= 4 and the sparkle literal is the sole map+notone one | islands-10 (b1.1f); red with HEAD 69189598's EntityMeshes (`--src`): sparkle key nomap+notone, no shared sprite |
| `test-asset-provenance` | Every GLB in public/assets/models has a row in `PROVENANCE.json` (written by `scripts/provenance-scan.mjs`): kind `script` = the non-helper scripts/blender build script that exports it and still carries the literal output name (far LODs: the builder that quotes the base name and writes `_far.glb`; ambiguous writers need an OVERRIDES entry with evidence), kind `license` = a LICENSES.md row that is CC0/CC-BY with an http(s) URL and an author; no orphan rows; committed file == fresh scan; no text/image-to-3D generator string in asset.generator, asset.copyright, any extras, or any text file under scripts/ and src/; script-built GLBs carry the Blender exporter (or gltfpack/glTF-Transform) as asset.generator. Self-tests 9 fixtures every run (0.5 s, quick tier) | critique-06, D37 (b1.1h); red at HEAD bd35489c (no PROVENANCE.json: 122 missing rows); red on a models copy with a generator-tagged bedroll.glb + unlisted GLB + a text-to-3d fetch (5 failures); mutation dropping the asset.generator check fails the self-test |
| `test-match-fault-isolation` | two real Matches on real timers, fake sockets: match A's tick throws every time -> exactly 3 faults, then quarantined (interval cleared), its clients get one match_ended{reason:'server_fault'}, onFault fires once; match B ticks >= 20x, gets no match_ended; 0 process uncaughtException (index.ts FATAL_BUDGET untouched); static: LobbyServer wires onFault -> reapMatch and persists nothing for a server_fault result | correctness-01 (b1.2a); red on be60fa08+: 27 uncaught in ~0.5 s (FATAL_BUDGET 5 trips in <100 ms), 27 throws ran, no quarantine, no match_ended, 7/10 FAIL |
| `test-lobby-hold-idempotent` | LobbyServer constructed without init(), counting fake match, ws-shaped fake sockets whose terminate() emits 'close' on the next tick: onDisconnect twice -> held.size 1, removeClient 0, session still in clients, heldSince not re-stamped; sweepDeadSockets on a 60 s-silent in-match session + the late close -> seat still held, never removed; a close from a socket the session no longer owns neither parks nor disposes it | correctness-02 (b1.2b); red on 92a4243d: 8 FAIL (held.size 0, removeClient 1, disposed, identity close disposed the session) |
| `test-queue-latency` | LobbyServer without init(), fake Date.now + hand-driven tick(), PIRATES_BR_MAX_MATCHES=1, tunables never written (production 12 s / 20 s): lone solo -> match_start <= 20 s with an etaSeconds <= 20; two crews 10 s apart -> same matchId at <= T0+12.5 s; crew queueing in the countdown -> same match, one bot hull fewer, ship count unchanged, botCount honest; at the ceiling a duos crew waits 100 s with no lobby_error, queue_update{atCapacity, position 1}, dispatched when the match slot frees | online-03, online-17 (b1.2c); red on b2ebfe84: 8 FAIL (no etaSeconds, lone waited 90 s, two crews dispatched at T0+90 s, bot hulls 9 -> 9 and ships 11 -> 12, no atCapacity/position, never dispatched after the berth freed) |
| `test-capacity-sim` | Real LobbyServer dispatch with StubMatch via LobbyServer.matchFactory, capsim.py survival curve, 60 min x 7 seeds, pooled p95 queue wait per arrival-rate x MAX_MATCHES cell; the chosen row keeps >= 18 mean concurrent humans and 0 lobby_error; MUTATION (pressure window off) must FAIL the 1/min @ 4 row. ~5 s, no port | b1.2h online capacity; registered by the b1 batch gate ([b1.gate]) after the b1.2 handoff left it unwired (the runner graded it MISSING) |
| `test-names` | src/shared/names.ts, pure, no port (quick): 30 hostile names (slurs with leet, spacing, zero-width, dotted, stretched letters; RTL override, LRI, BOM/ZWJ, zalgo, 200 chars, emoji-only, punctuation-only, 1 char, Hangul fillers, whitespace) rejected or visibly cleaned, all 20 abusive spellings REJECTED; 30 normal names ('Anne Bonny', 'Cassandra', 'Jose'+U+0301, '海賊', Scunthorpe, 'Bass Hitter', 'Niger Delta', 'Therapist', Cyrillic, Arabic) accepted as their NFC form; in-match dedupe ' (2)', ' (3)' | online-15 (b1.2f); red on dc554fcb: module absent; mutation (blocklist off) 20 FAIL, (control strip off) 6 FAIL |
| `test-queue-text` | src/client/menu/queueText.ts, pure, no port (quick): at capacity names the place in line, 'about Ns' from etaSeconds or 'waiting for a free berth', the late-join window, never a raw '0s'; normal queue uses server etaSeconds; D10 late-join line 'Joined a voyage in progress (storm phase N)'; wiring greps on MenuController.renderQueue and Game.onMatchStartFromMenu | b1-ask-02; red on 70e1a8e9: module absent + 2 wiring FAIL |
| `test-cpu-copy-release` | src/client/rendering/CpuCopyRelease.ts + AssetLibrary.releaseCpuCopies/rehydrateReleased, pure three.js, no port (quick): render-only arrays drop at upload, library templates drop/arm by scene reference, boot and runtime-cloned assets kept, release idempotent; next-match rehydrate refetches every released key with at most REHYDRATE_CONCURRENCY loads in flight | b1-device-03; red on bb6043dd: peak 4 of 4 keys in flight (unbounded Promise.all) |
| `test-stats` sections 5-8 | same name + two device ids -> two records, legacy name record claimed once, raw device id never on disk, compact JSON; 10k set_name through the real LobbyServer.handleSetName -> 0 records, 0 writes, LobbyServer honours PIRATES_BR_STATS_PATH, blocked name -> Pirate#### + lobby_error; 50,010 results -> 50,000 records (LRU evicts the 10 oldest), flush p99 event-loop delay < 5 ms (monitorEventLoopDelay), <= 1 write per interval; Match dedupe ' (2)' | online-07, liveplay-14, online-15 (b1.2f); red on dc554fcb: 17 FAIL (merged records, 10,000 records + a write from set_name, data/stats.json path, no cap, flush loop delay p99 71.8 ms, no dedupe) |
| `test-abuse-limits` | real LobbyServer on port 0, PIRATES_BR_TRUST_PROXY=1 + forged x-forwarded-for, PIRATES_BR_ALLOWED_ORIGINS set: 8 sockets from one IP open, the 9th is refused 429 before the upgrade, another IP connects, closing one frees the slot, a 9th socket with a forged XFF but the same Fly-Client-IP is still refused; 20 open-and-close sockets admitted then 429; at the total ceiling 503; foreign Origin 403, allowed/missing Origin connect; 500 create_party in 1 s -> <= 30 handled, closed 1008 in [9.9, 11] s after the flood start although the flood stopped at 1 s; a 60 Hz player_input + 3 s ping client for 60 s (concurrent) -> 0 dropped, never closed, every ping answered; /health refusedConnections / rateLimitedFrames / abuseClosed; pure limits.ts bucket, 10 s rule, prune bound, loopback exemption | online-06, vm:correctness:4 (b1.2d); red on f6d12a0a (LobbyServer without the gate): 10 FAIL (9th socket opened, 21st opened, foreign Origin opened, no gate, 500/500 create_party handled, never closed, /health has no counters); Fly-Client-IP case red on aefd44bc (forged XFF opened a 9th socket) |
| `test-version-skew` | real LobbyServer on port 0 with BUILD_ID set, throwaway StatsStore: resolveServerBuildId (env > dist/build-id.txt > 'dev'), postbuild writeBuildId copies the bundle's <meta name="pirates-build-id"> (content hash without it), vite.config defines VITE_BUILD_ID; welcome.buildId and /health.buildId; shutdown(grace 1.5 s) with one match at sea, one in countdown and one menu client: every client gets server_notice{kind:'restarting', seconds:2} before ANY socket closes, every close 1012, the grace honoured, the match at sea ends 'interrupted' and is persisted as noContests 1 with matchesPlayed/wins/bestPlacement 0 and play time kept, the countdown match records nothing | online-05, online-11 (b1.2e); red on beb2481f: 15 FAIL (no resolveServerBuildId/writeBuildId/define, welcome and /health without buildId, no server_notice to any client, drained match persisted as matchesPlayed 1, placement 3, deaths 1 = a loss). `test-static-serving` gained: /assets/missing-deadbeef.js, a missing /assets/models/*.glb and a missing root *.js -> 404 (red on beb2481f: 200 text/html), extensionless route still index.html |
| `test-net-resilience` (b1.2b cases) | autoPong:false silent in-match socket, backdated past HEARTBEAT_TIMEOUT_MS, swept by the REAL heartbeat timer -> after the late close the seat is still held, player in the match and not eliminated, resume_ok with the same playerId + join; a solo match won by gold during the hold -> resume gets resume_ok, join, game_over{reason:gold, winnerId}, match_ended with a non-empty board in that order, endedMatchSince re-stamped | correctness-02 + correctness-08 (b1.2b); red on 92a4243d: resume_failed unknown_token, player removed; no game_over/match_ended after the resume join (8 FAIL) |
| `test-wire-validation` (b1.2a cases) | player_input yaw 1e17 / -1e17 / 1e308 returns inside a Worker with a 2 s kill; |yaw|,|pitch| > 1e4 refused; angleWrap == the old loop to 1e-12 over 10k values in [-50,50], in-band bit-identical, +-PI seams match, [-PI,PI] for 1e17/1e308, non-finite -> 0; 10k hostile player_input frames mean < 1 ms, worst < 5 ms | correctness-03 / vm:correctness:5 (b1.2a); red on HEAD: all 3 workers wedged (never returned), main-thread checks skipped -> FAIL |
| `test-beacon` | real LobbyServer on port 0, PIRATES_BR_TRUST_PROXY=1, Fly-Client-IP per request, console.log captured: valid POST /beacon -> 204 and exactly one JSON `client_error` line with kind/message/stack/buildId/ua/quality and no IP, unknown fields dropped; same IP within 10 s -> 429; 5 KB declared -> 413, 6 KB streamed -> 413, no log line for either; bad JSON and unknown kind -> 400; message/stack clipped to 300/1500; a 30-IP burst -> <= 20 accepted, rest 429; JSON `queue_join` {mode, crew}, `match_dispatch` {mode, humans 1, bots > 0, waitedSec}, `match_end` {reason, durationSec, humans}, `refused` {reason origin, status 403} without the IP | online-12 (b1.2g); red on 99f6081a: 16 FAIL (no /beacon: 200 index.html for every post, no JSON lifecycle line) |
| `test-http-hardening` (b1.2g cases) | needs dist/client: `/`, `/assets/index-*.js` and the 304 on `/` carry nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy camera/microphone/geolocation=(); `/` and its 304 carry the CSP (default-src/script-src 'self', no unsafe-inline/eval in script-src, worker-src 'self' blob:, connect-src 'self' wss:, object-src 'none', frame-ancestors 'none') and X-Frame-Options DENY, the JS does not; no HSTS without TRUST_PROXY; POST / , PUT /assets/*.js, DELETE /index.html -> 405 (Allow: GET, HEAD); HEAD / -> 200 + content-length, 0 body bytes; .mp3 audio/mpeg, .m4a audio/mp4, .webmanifest application/manifest+json, .avif image/avif; /health slim {ok, accepting, draining, buildId, machineId, clients, matches} without X-Health-Key when HEALTH_KEY is set, with a wrong key and whenever Fly-Client-IP is present; detail with the key or from a bare loopback rig with no key | online-13, online-14, online-20 (b1.2g); red on 99f6081a: 23 FAIL (no security headers, POST/PUT/DELETE served the file, octet-stream for all four types, /health always detailed). HEAD / was already bodiless (Node drops the body for HEAD); the fix only stops opening the file |
| `test-deploy-config` | Pure node over fly.toml (tiny TOML reader), Dockerfile, scripts/docker-entrypoint.sh, .dockerignore, DEPLOY.md and .github/workflows/deploy.yml when present: performance-* VM >= 2 GB, [[mounts]] pirates_data -> /app/data, auto_stop_machines false, min 1, top-level kill_signal SIGTERM + kill_timeout >= DRAIN + 10 s, PUBLIC_URL = https://<app>.fly.dev inside ALLOWED_ORIGINS, TRUST_PROXY, no DEV env, --ha=false on every deploy line, no app-generator command, BUILD_ID build-arg + PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD in the build stage, entrypoint chowns /app/data then execs setpriv to node (never falls back to root), DEPLOY.md capacity row {machine, MAX_MATCHES, measuredAtCommit, worstSimLagSec, humans} with fly.toml MAX_MATCHES <= row, lag < 0.1, commit not older than the last src/server or src/shared commit (`unmeasured` only at the provisional 2 and never with --require-measured); b1.3b adds deploy.yml: exists, FLY_API_TOKEN only from secrets (no literal token), wait-idle before and smoke-online --build-id after the deploy, --image rollback under if: failure() of the smoke step, concurrency group deploy without cancel, workflow_dispatch + push to release; 25 in-memory mutations must each turn a clause red every run | online-01, online-02, online-08, online-19, D8, critique gap 8 (b1.3a); red on d3663698: 12 FAIL (shared-cpu-2x, no mounts, kill_timeout parsed as a [[vm]] key so Fly's 5 s default applied, no kill_signal at top level, no PUBLIC_URL/ALLOWED_ORIGINS, no capacity row, bare `fly deploy`, app-generator command in DEPLOY.md, no BUILD_ID arg, no playwright skip, image runs as root) | b1.3b red: without deploy.yml 8 FAIL (exists, --ha=false, secret token, wait-idle, smoke, rollback, concurrency, triggers).
| `test-smoke-online` | real LobbyServer on port 0 (BUILD_ID + FLY_MACHINE_ID set, throwaway StatsStore) behind a fake edge (fixture index.html + br bundle, /health pass-through, raw WS upgrade pipe): scripts/smoke-online.mjs passes all 8 stages (GET / html no-cache, main bundle br + immutable, /health x20 ok/accepting/one machineId/one buildId, wss welcome protocolVersion + buildId, solo_start 9 bots -> join >= 10 ships <= 20 s, 60 inputs -> >= 20 snapshots, queue_join solo -> match_start <= 25 s, create_party + join_party by code); FAILS against a stopped app (ECONNREFUSED), a buildId mismatch, an alternating two-machine /health and a bundle without content-encoding br; scripts/wait-idle.mjs idle / unreachable (2 misses) / cap on a fake clock | online-04, online-11 (b1.3b); red with a mutant smoke (machineId, buildId and br guards disabled, SMOKE_MODULE): 5 FAIL |
| `test-input-bindings` | src/shared/bindings.ts (41 actions): validateBindings() = every action bound on keyboard/mouse, Standard Gamepad and touch or an n/a with a reason, no token shared by two actions in overlapping contexts (planted clash/empty/bare n/a each caught); V+MMB ping, T emote, Tab scoreboard reserved; no RMB-only action; Standard Gamepad token names; InputManager.ts and Game.ts carry 0 `.code === '...'` literals and no unguarded requestPointerLock?.().catch; the legend card in index.html names every live table key (carries test-onboarding-ux's legend audit); resolveInputAuthority / lockHintVisible per scheme; the real InputManager on a DOM stub with requestPointerLock returning undefined: unlocked click and closing the wheel never throw, mouse scheme unlocked never fires or aims, touch and gamepad schemes fire/aim/interact through setActionHeld without lock, W/Q/6 still produce forward/sailLeft/firebomb, the first move after lock is dropped and 5000 px turns as far as 300 px; requestLockSafe (undefined/throw/raw-refused retry); wheelToChartAction: 40 x deltaY -4 -> 1.3-1.6x, one -100 notch 1.2-1.3x, 10 x ctrl -10 -> 2-3x, huge event <= 1.25, deltaX pans, a pinch never pans; Game uses it and blocks ctrl-wheel + gesturestart in a match | crossdevice-02/09/10/11/14, mechanicshud-05, vm:creative:1 (b1.4a); logic, quick (~0.2 s); red on HEAD before the slice: 11 FAIL (24 + 3 key literals, unguarded lock catch, 2 TypeErrors on an undefined lock, no setActionHeld/scheme, first post-lock move applied, 5000 px spike unclamped, fixed 1.18 wheel step, no ctrl-wheel/gesture guard); b1.4g (crossdevice-13/14): CONTROL_RANGES spec ranges, clampSetting both ends, all 11 Controls settings survive save -> load, tampered storage clamped, legacy piratesBR.settings sensitivity + haptics migrate, grep: no clamp site outside rebinding.ts spells a sensitivity range, the Controls page builds sliders from CONTROL_RANGES, old 20-200 slider gone + page mounted; rebind swaps (reload->X puts interact on R; pad special->LS click puts keg on RS click), no swap across non-overlapping contexts, slot-1 alternate, fixed rows and Escape/Pad:Menu refused, only changed rows persist, clashing stored table falls back, reset = defaults + storage cleared; the real InputManager follows setLiveBindings (X reloads, R does not, reset restores R), invert Y per scheme, touch look 2x, ADS x0.5 while aiming, clamp to 3.0/0.2, vibration drives Haptics, raw mouse -> unadjustedMovement; red with 4 mutants (legacy clamp, no swap, no invert, reset keeps a rebind): 9 FAIL |
| `test-no-hardcoded-keys` | player copy never spells a key: every string literal / template text in src/**/*.ts (TypeScript AST, comments excluded) and every visible line of index.html (comments/script/style stripped) is searched for the verifier's pattern ([X]-style bracketed keys, [5/6/7], LMB/RMB, hold W, WASD); only src/shared/bindings.ts and src/client/ui/InputGlyphs.ts may; must be 0 (156 comment mentions reported as advisory). InputGlyphs: glyph('interact') = [X] / (X) / ‹X› per scheme, fire = [Click] (trackpad) / (RT) / ‹Fire›, 18 copy actions non-empty and scheme-specific, n/a rows route (legend on pad = (Menu)), an AZERTY layout map relabels KeyQ as A, the generated mouse legend names all 36 live table keys, pad legend speaks (RT)/(LB), touch legend has no WASD/LMB/RMB/Click; win copy = GOLD_WIN_TARGET and index.html types no gold figure | mechanicshud-05, crossdevice-08, crossdevice-18, vm:mechanicshud:3 (b1.4f); logic, quick (~1 s); red before the slice: 103 copy hits (InteractionPrompts 37, HudController 37, index.html 24, Game 3, OnboardingCards 1, constants 1), InputGlyphs.ts missing, index.html typed '9,000 gold' (3 FAIL) |
| `test-radial-menu` | src/client/ui/RadialMenu.ts + SupplyWheel.ts, the one radial every wheel uses (supply now, crew-call/emote later): angle -> slice clockwise from 12 o'clock (0,17,19,36,90,180,270,342,340,324,-10 deg -> 0,0,1,1,3,5,8,0,9,9,0; right = 3, not a mirrored 7), hub dead zone 0.26 r, a tap past 1.15 r takes nothing; pad stick past 0.5 selects and a centred stick KEEPS it, take() once; Digit1-9/0 and Numpad agree with WHEEL_SLOTS; SupplyWheel hover+release takes once, a finger tap takes the wedge and closes, a mouse click leaves the wheel to [I], stick then release takes; InputManager routes digits through sliceForDigit; Game.ts keeps no private wheel atan2; every painted index.html slice maps back to its own data-wheel-slot | crossdevice-01, vm:creative:2 (b1.4d); logic, quick (~0.3 s); red on HEAD before the slice: 4 FAIL (RadialMenu/SupplyWheel absent, InputManager digit rule, Game wheel atan2) |
| `test-gamepad-curves` | src/client/input/GamepadSource.ts + MenuNav.ts + Haptics.ts: radial deadzone 0.12 / outer 0.95 table (worn diagonal reaches 1 at 45 deg), look exponent 2 (half band = quarter rate), full RS 1 s = 220 deg = 3.84 rad, pitch 150 deg/s, x sens x fovScale; per-context routes from bindings.ts (foot/helm/cannon/swim/wheel, reserved ping/emote unrouted); Y tap = reload, Y 400 ms = drop chest; RT at 60% pull fires; context switch releases held rows; non-standard pads ignored; pickNext grid; haptics: each kind hands the pad / navigator.vibrate exactly the table values, mouse scheme silent, disabled setting reads no port | crossdevice-05, crossdevice-17 (b1.4e); logic, quick (~0.2 s); red with the look curve made linear and the haptics off-switch removed: 2 FAIL |
| `test-aim-assist` | src/client/input/AimAssist.ts + InputManager.tickAimAssist + Game.updateAimAssist (D13): spec constants (x0.55, 2.5 deg, 60 m, 4 deg, 3 deg/s); off for the mouse scheme (trackpad included), with the setting off, at the cannon/helm/no context, with the Wrecker's Glass, the ship gun or the spyglass; slowdown cone uses the hitbox edge and narrows with fovScale, 61 m out, 180 deg out; zero behind cover (stub LOS and the real shared hull prism via makeAimLineOfSight), a covered near target never masks a visible one; magnetism zero unless aiming, <= 3 deg in 1 s, every step <= 3 deg/s x dt, a 2 s hitch moves <= 0.15 deg, NaN dt moves nothing, never overshoots, pitch pull, short way across the yaw seam; collectAimTargets = other crews' live pirates at chest height + live sharks; the real InputManager: pad and touch look x0.55 on a target, Glass not slowed, no drift unless Aim held, pad drift <= 1.5 deg in 0.5 s, mouse never slowed or pulled; Game wires it every frame. test-input-bindings adds the trackpad rows: two-finger click (button 2) and control-click aim and never fire, aim has Mouse2 plus a key, Game suppresses the context menu | crossdevice-01 (D13 half), vm:mechanicshud:2, vm:crossdevice:6 (b1.4h); logic, quick (~0.3 s); red with 6 mutants (mouse allowed 1, no dt clamp 1, LOS ignored 2, Glass/ship gun assisted 3, cannon/helm assisted 2, overshoot 7 FAIL) and test-input-bindings red with the control-click mapping removed (1 FAIL) |

`test-perf-budget` also gained balanced-tier rows (dock-vista / open-sea /
cave-interior) with a `MID_TIER_MAX_RATIO` of 0.80 against high, except
dock-vista at 0.90: the HIGH reading there swings 1006-1212 between runs (far
bot hulls beyond balanced's 300 m detail radius) while balanced holds 850-879,
and 0.80 flaked 1 run in 3. Lane 2.6 re-pins from four runs.

## Not gates, by layout (2 declared, 33 probes, 14 tools)

`npm run test:audit` fails on **any** top-level `scripts/*.mjs` that is neither
wired nor declared. The old filter only saw `test-*`/`audit-*`/`*smoke.mjs`
names, so 72 one-off probes (`*-probe`, `*-tour`, `*-shots`) accumulated
unseen. On 2026-09-02 the layout was made to say what a file is:

| where | what | how many |
|---|---|---|
| `scripts/test-*.mjs`, `audit-*.mjs` | gates, all wired in `lib/suites.mjs` | 114 |
| `scripts/lib/` | shared code (browser args, perf scenes, z-fight probes, the manifest) | |
| `scripts/tools/` | doc-cited instruments: `perf-*`, `zfight-blame`, `approach-shots`, `fill-pass-shots` (paths in `FRAME_COST_MODEL.md`, `Z_FIGHTING.md`, `FILL_AND_SHADER_PASS.md`), `story-tour` (restored for the fix plan's lane 2.5 gate; reads `PIRATES_BR_URL`) | 14 |
| `scripts/probes/` | live probes touched after 2026-07-25 or cited by the fix plan; each opens with a `// PROBE, not a gate:` line saying what it measures | 33 |
| top level, in `EXCLUDED` | `perf-probe.mjs` (shared instrument library (planScenes, measureScene, sessionQuery) imported by twelve browser suites); `pacing-sim.mjs` (the pacing instrument (lane 0.3 owns it)); `storm-wall-probe.mjs` became the gate `test-storm-wall.mjs` in wave 0.4 | 2 |

Deleted in the same sweep (git history keeps them): 21 probes last touched
before 2026-07-25, the six wave-scoped smokes that were listed as excluded
(`audit-tour`, `endgame-live-smoke`, `finalwave-*-smoke`,
`killwave-integration-smoke`) plus `helm-stance-probe` and
`screenshot-tour` that only they referenced, thirteen dot-prefixed scratch
files, and the pre-runner `test-results/.last-run.json` (a Playwright reporter
artifact nothing wrote or read; the directory is gitignored wholesale).

## Timings and the quick tier

`test-results/summary.json` at dcd831d0, `--logic` with 8791 held by a dummy
listener: 62 suites, 101 s wall. Slowest five: storm-spawn-safety 23.3 s,
wreck-event 13.5 s, cave-walk 12.3 s, bot-peace-window 8.4 s,
interaction-arbiter 7.5 s. Server tier: net-resilience 46.5 s,
http-hardening 18.4 s.

`quick: true` in the manifest marks the 52 logic suites measured under 1.5 s
each (14.4 s wall together). `npm run test:quick` = typecheck + those, graded
against `PIRATES_QUICK_BUDGET_MS` (60 s): over it prints a warning (this Air
flaps when another agent runs), over twice it is a FAIL. Tag a suite only after
reading its ms off a summary.json; never one that boots a server or walks a
world.

---

## The load gate was bimodal, and this is what it was measuring

Seven runs of the same build against a 2000ms budget read
`1773/1837/1847/1856ms` green and `2491/3063/3259ms` red. Three instrumented runs
settled it:

| longest load task | worst single link | the difference | 1-min load avg |
|---|---|---|---|
| 2015 ms | 1980.3 ms | **34.7 ms** | 6.0 |
| 2383 ms | 2342.6 ms | **40.4 ms** | 6.5 |
| 2494 ms | 2454.0 ms | **40.0 ms** | 6.4 |
| 2047 ms | 2011.5 ms | **36.0 ms** | 2.6 |
| 1818 ms | 1772.5 ms | **45.0 ms** | 2.5 |

**The longest task of a cold load is always one `linkProgram` plus the ~40ms of
the frame it landed in.** Nobody can serve half a link — not this repo, not
three.js, not the driver — so what that costs in milliseconds is a fact about how
much CPU this fanless Air had spare when the shader was compiled. There is no
constant that grades it honestly: 2000 fails clean builds under load, and the
3500 that would stop it doing so sits above the 2385ms regression the gate was
built to catch.

So on the software path the millisecond ceiling is gone and the contract is the
**schedulable excess** — everything the longest task spent that was *not* the
indivisible link inside it. That number is 34.7–45ms across a 2.5× spread of host
speed, because it is not made of link. The ceiling is 250ms.
`ProgramWarmup.stats` now carries `joinCount`/`joinTotalMs` so the attribution
can be made from inside the run. On the GPU path a link is tens of milliseconds
and the 400ms wall-clock ceiling stays exactly where it was.

**One measure was tried and rejected, recorded here so it is not re-derived.**
The worst link against the *mean* link of the same run looks like the perfect
host-independent way to catch a monstrously expensive new shader. It is not
usable: the mean depends on how many links got joined before first control, and
that is set by host speed. Two runs of the same build read **78.2×** (400 links,
mean 25.7ms) and **44.9×** (281 links, mean 43.5ms). The distribution is
enormously skewed — nearly every program links in tens of milliseconds and one
costs two seconds — so any ratio against a population statistic inherits the
population's instability. The census is *printed* because it makes the shape
obvious at a glance; it is not asserted on. A single pathological new shader is
`test-first-draw-budget` and `perf-program-census`'s business.

**The hover assertion was the last piece still going bimodal, and it went the
same way.** Six runs of one build read 653/773/819/847/883ms and then **3969ms**,
and what changed was not the menu: a hover is acknowledged *between* frames, and
during warm-up every frame is one indivisible link. The ack is therefore (frames
it waited) × (what a link costs on this host today) — the first term is the
client's business, the second is the host's. It is now counted in **warm slices**:
the menu must answer within three frames of warm-up work. On a GPU with 30ms
links that is 390ms, far stricter than the 1200ms constant it replaces. Three
clean runs after: 634 / 838 / 834ms against bars of 6215 / 6497 / 6608ms.

**The mutation proof is `--mutate 3000`, not `--mutate 900`, and the size is not
a fudge.** A 900ms block is smaller than this load's own WebGL context creation
(0.94s) and far smaller than its worst link, so it is genuinely not the worst
thing happening during a SwiftShader load — asserting that it is would assert
something false. `--mutate 900` was measured surviving: longest task 1992ms,
still a link, 47ms of excess. `--mutate 3000` goes red at 1133ms of excess.

**So: this gate cannot see a sub-link block on the software path, and nothing
here can.** A 900ms freeze is real and player-visible; it is simply not an
anomaly against a 1.8s link. The hover check appeared to catch it once (3624ms
against the old constant) and missed it the next time (883ms) — that constant was
measuring where in the load the block happened to land.

## The HUD suite's four failures

Three shared one root cause. `Game.frame` clamps `dt` to 50ms per frame for sim
stability; the attrition vignette and the spectate lift both integrate that
clamped clock. On a host rendering this scene at under a frame a second the game
receives about 4% of the wall clock, so a suite that sleeps eight real seconds
and reads the vignette is reading the frame rate. Measured: attrition peaked at
**0.089** against a 0.15 bar, and the 2.4s camera rise reached **lift=0.62**
after forty real seconds, failing that and the vignette assertion that rides on
it. Nothing was wrong with the HUD.

Every duration-shaped assertion is now driven off `combatFx.fxClock` — the
client's own accumulated frame time — and the tempest bills 0.6hp per second of
*that* clock, which reproduces the 60fps player's curve at whatever speed the
host manages. Running out of wall clock before the game clock arrives is now its
own named failure: a failure to **measure**, not a failure of the HUD. After:
4.05s of game clock in 41.7s of wall clock, attrition 0.426, lift 1.0.

The fourth was the overload chip, and the input had moved out from under the
test. The block leaned on nulling `onSnapshot` to freeze the sim clock; the
netcode pass deliberately moved the detector onto
`NetworkClient.getServerClock()`, stamped in the socket's message handler,
precisely so this client's frame length stops being charged to the server.
Nulling the apply callbacks dilates nothing now — the chip was correctly down
with the right text on it, and the suite called that a defect. Dilation is now
injected where the detector reads it (a clock advancing at 7% of real time),
through the real 5s window, 1s trip and 1.5s dwell. The **clear** path is
asserted too, which the old block never did.

The suite also runs at 960×540 now, resizing to 1600×900 only for the block that
is about layout: same 16:9 frustum at a third of the pixels, three times the
frames on a software rasteriser, and inside the ceiling this machine's headless
GL is held to.

## fixwave4-smoke: the same clock defect, plus a port it did not own

It was failing eight of twenty-six and nobody had seen it, because the `&&` chain
never got that far. Two causes.

**Twenty-two wall-clock sleeps between "change something" and "read what the HUD
says about it."** The HUD is repainted by the frame loop. Every read landed one
step behind, and the failure details said so out loud:

```
✗ banked gold past the safe line becomes a WEIGHED hold  (cargo=3400g "")
✗ the bounty SIGN is on the HUD  (HOLD: DEEP-LADEN · 3400g · −6% knots)
```

The sign it reports missing is printed in its own failure detail, one read late.
`waitFrames(ms)` waits on the client's frame clock instead — but **opt-in**, and
that turned out to matter: this game keeps time two ways. A feed toast expires on
a 3s *wall* timer and a story vignette advances its stages on one too, so applied
to every sleep it fixed six assertions and broke two, reading an expired bounty
cry and a vignette two beats on. The bounty moment now takes **two reads on the
two clocks** — the feed early on the wall, the hold later on the frames.

**And the gilded-wreck stage started a second server on a hard-coded `:8091`** —
exactly where the new runner stands its own server up. The spawn lost the bind,
the health poll got a cheerful 200 from the *other* server, and the stage waited
120 seconds for a wreck nobody had told to hurry. It failed as "the gilded wreck
stage did not run", which is true and says nothing about the wreck. It now asks
the OS for a free port and refuses to grade any server answering there before it
started one. That stage runs for the first time in this audit, and four of its
five assertions pass.

One vacuous assertion was found and closed on the way past: *"and they lie ON
her, within a hull length"* ran `.every()` over an empty array — true — and
printed `furthest -Infinitym off her centre`. It could not fail in the state
where its subject did not exist. The population is part of the claim now.

## Still open

- **`test-viewmodel-poses` grades nothing on this machine.** It is declared
  `SKIPPED` rather than silently green, which is honest but is not coverage. The
  fix is the one applied to the HUD suite — drive the viewmodel off the client's
  frame clock instead of a wall-clock stopwatch — and it is a job of its own.
- **Five wave-scoped smokes hard-code `:3000`.** They are excluded with reasons
  rather than repaired; each would need its URL handling rewritten and its
  contract checked against what has replaced it.
- **No mutation proof for most browser suites.** Four carry `--mutate`
  (`test-load-responsiveness`, `test-program-warm`, `test-sim-lag-honesty`,
  `test-frame-governor-live`). The rest are argued from their headers, not
  demonstrated. A gate that has never been shown to fail is a claim, not a proof.

### Two suites still red, and both are telling the truth

**`audit-live-floaters` — a real product defect.** Three `decor-dock` pieces
stand 1.15 m, 1.60 m and 1.78 m above the ground they are drawn on, on islands at
local (−52.9, 106.2), (−31.5, 70.1) and (43, −94.2). The audit is doing exactly
its job; this is dock seating in the world generator and it is not test repair.
Note it may be newly *visible* rather than new: the runner now pins map seed
20260801, and before this audit the suite graded whatever world the developer's
server happened to have rolled.

**`fixwave4-smoke` — two of thirty-one.**
- *"walking into smuggler_cache makes the scene SPEAK its name and its beat"* —
  the vignette overlay says nothing. Its sibling `skull_totem` passes, so the
  machinery works; this is either one scene's trigger radius or a walk that does
  not reach it on a host this slow. Needs the story-vignette path read properly,
  not another sleep.
- *"her chests are floating on her, not buried under her"* — the read scans
  `state.islands[].chests` for ids in `wreck.chestIds` and finds none, while the
  assertion two lines above confirms the wreck carries four. The wreck's cargo is
  either not on an island's list or arrives on a later snapshot. This is a wire
  question, not a timing one.
| test-touch-controls.mjs | logic | b1.4b touch core: stick -> WASD rows (8 dirs, deadzone), 150 px drag 0.35-1.2 rad, fire tap survives a tick, touch [X] hold = interactHeld every tick, pointercancel releases, replayed hold closes a hull breach on a real Match and a 0.4 s cut hold does not. Browser half is test-touch-controls-live. |
| test-touch-controls-live.mjs | browser | b1.4b2: CDP touches on a hasTouch/isMobile page in a real solo match (entered by tap). 844x390: stick 2 s moves >=1.5 m on the server, 150 px drag turns 0.35-1.2 rad, Fire tap -> fire=true in a built input, 1.5 s Interact hold -> interactHeld on every built input + ring advancing, lift and pointercancel release. 1024x768: drag + Fire again. Both: 6 buttons in-window, none overlapping; arc vs HUD overlap printed as advisory (b1.5e). Red at 6ec7f241: the #hud panels (z 100) ate the look drag, Fire and the chip at 844x390; iPad Reload overlapped Fire. ~65 s. |
| test-front-door.mjs | logic | b1.5b (online-09/16, vm:online:5, vm:audio:6): meta description 50-155 chars; og:title/description/type/site_name/image(+alt/type/1200x630) and twitter summary_large_image; og:url, og:image, twitter:image and canonical ABSOLUTE on fly.toml PIRATES_BR_PUBLIC_URL; public/og-card.jpg JPEG SOF 1200x630, 40-300 KB; manifest parses + icons at declared PNG sizes + one maskable; build-credits parser proven on a 2-table fixture, licenseProblems flags CC-BY without author/NC/personal-use, public/credits.json == buildCredits() and lists every LICENSES.md row; #menu-privacy names name + IP; Credits button + .menu-panel; buildInviteUrl -> normalisePartyCode round trip for 4- and 6-char codes (incl. a URL with other params); share on coarse pointers, copy on desktop, show otherwise; auto Pirate####; no 'Copied!' before writeText resolves; ?party with no stored name auto-joins. Red at 4057de2e: 30 FAIL. ~0.3 s. |
| test-gamepad.mjs | browser | b1.4e (crossdevice-05, vm:liveplay:1): a scripted W3C standard pad via a stubbed navigator.getGamepads at 960x540, no mouse/keyboard events. Menu: first press wakes the pad and rings the public Play without pressing it, A presses the ringed Play (click trapped), D-pad down rings Solo, A starts the match. Match: LS 2 s >= 1.5 m on the server, RS full right 1 s turns 3.0-4.6 rad, RT -> fire=true on a built input + a 12 ms dual-rumble on the pad, LB + RS right hovers slot 3 and releasing LB sends wheelIndex 3. |
| test-hud-visibility.mjs | quick (logic) | b1.5f: pure hudVisibility/hudMessagePlan against the spec table: 12 canonical contexts, <=12 always-on desktop / <=8 phone, contradiction rows, every UiRefs id has a writer |
| test-elimination-spectate.mjs | browser | b1.5f: scuttle own sloop in Solo (server dev_scuttle, PIRATES_BR_DEV_HOOKS) -> spectate banner names a subject within 8 s, death card is a bottom bar with NEXT SHIP, frame not >95 % black, next-target key changes the subject (RED with the spectating toggle mutated: 5 FAIL) |
| test-anim-no-inversion.mjs | quick (logic) | b1.6a (animations-05/06/08/11, physics-10, vm:animations:1, vm:correctness:6): helm wheel top peg screen dx sign == heading screen dx at 3 yaws (omega sign from the real applyShipRudderSteering); flag/pennant fly . apparent wind > 0.9 at 8 headings x 3 winds, slack on a run at the wind speed, streaming head to wind; foliage lean . wind > 0.95 and a gale bends harder; turn heel lowers the OUTER rail (toShipWorld3) and stays <= 3 deg; lookPitch +0.4 raises the gaze > 0.25 on the real rigged head (updatePlayerRig on pirate_base.glb) and the low-tier head, low-tier aim arm and wrist lift with pitch; consumers grepped. Every case carries a negative control (the f5fee97e formula must fail the same predicate). Red at 2c0fa204: 9 FAIL. b1.6b (animations-03/04/09/15) adds the first-person viewmodel from the pure src/client/rendering/viewmodel/poses.ts, projected through a PerspectiveCamera(74, 16:9): per firearm (flintknock, blunderbuss, eye_of_reach, hip + ADS) the kick-peak muzzle tip moves < -0.03 m along the barrel and climbs > +2 deg (bands 4-6 / 8-11 / 5-7 deg, Eye of Reach ~9 cm back), recoil peaks in 60-90 ms, settles by 180-260 ms and stays settled (no hold plateau), muzzle flash in frame at the peak, near-plane rule (every primitive weapon vertex z < -0.12 at kick peak hip/ADS and draw start), draw starts muzzle >10 deg below the aim in a 220-280 ms draw, slash ribbon head sweeps the same way as the projected blade tip on both diagonals (p 0.2-0.56) and sits within 35 deg of it at the whip; controller wiring grepped. Red with the HEAD controller + inverted pose mutation: 18 FAIL. ~0.3 s. |
| test-handedness.mjs | quick (logic) | b1.6c (physics-04, vm:physics:2): ship-local +x is PORT. stepPirate RIGHT at yaw = ship.rotation walks toward sideOfLocalX's starboard at 4 yaws, helm RIGHT (applyShipRudderSteering) swings the bow to starboard, PhysicsSystem.impactHullSection's +x key labels 'port' through hullSectionSide; runs the SHIPPED expressions extracted from source: Match ship_hit side, HudController windBearingPhrase + windPlainGloss (wind from -x = starboard / right) and the vane rotate() (wind toward port points left), InteractionPrompts brace label; grep: no display file (HUD, hudModel, prompts, Game, Match minus the key picker, bots) names a side from a raw sign ternary or prints a HullSections key. Every predicate carries a negative control on the f5fee97e formula. Red at 2e2cb6d9 with the helper added: 16 FAIL. |
| test-truce-integrity.mjs | logic (~4 min) | b1.6e (mechanicshud-01, vm:mechanicshud:1): the truce is for everyone. 12 explicitly seeded solo worlds (15 bot crews, real Match) to t=TRUCE_SECONDS: 0 holes from ram/cannon/keg (openHoleAt wrapped), 0 founders, 0 creditShipSink calls; a firearm shot into another crew's pirate at t=5 s deals 0 and is held for a 'truce' refusal, the same shot at t=151 lands (control); a ship cannon is refused 'truce' with nothing queued, fires after (control); a solo bot given 2 waterline holes at t=30 has 0 open by t=75. Red before the fix: berth rams on 20260801 (47.2 s), 42 (9.0 s, 2 founders, 2 sink credits), 101 (42.5 s, 2 founders, 2 sink credits). |
| test-ammo-truth.mjs | quick (logic) | b1.6e (mechanicshud-02): real WeaponSystem, 6 blunderbuss shots: the SHIPPED weapon-card expression (extracted from HudController) equals server `ammo | reserve` after every shot and every reload; the 7th reload returns 'no_ammo' and starts nothing, a dry trigger leaves lastRefusal 'no_ammo', a reload with reserve left is not refused (control); Match source sends interact_refused for R ('reload') and the trigger ('fire'); no '∞' firearm readout. Red before the fix: 5 FAIL (reason undefined x3, both Match refusal sites). |
| test-budget-ratchet.mjs | quick (logic) | b1.7a (critique-05, rule 13): every value in scripts/lib/budgets.mjs (103 graded) is no looser than origin/release (once it carries the file), the f5fee97e baseline (scripts/fixtures/budget-baseline-f5fee97e.json, 59 rows) and 20 PLAN 3.4/3.14 rules (declared deviations printed and capped; they may only shrink); every test-*budget/memory/bundle/texture/transport/snapshot-size/ocean-tier/frame-governor gate imports budgets.mjs (2 declared not-yet-adopted); the last budgets.mjs commit touches no src/ or public/. Mutation: PIRATES_BR_MUTATE_BUDGET=perf.high.dock-vista.draws (+1) FAILS; a built-in +1 probe runs every time. |
| test-memory-budget.mjs | browser (slow) | b1.7b (critique-09): `window.__piratesBR.memoryCensus()` after a scripted 60 s tour standing off every island on the emulated phone (844x390 @3) and iPad (1024x768 @2), both on the mobile verdict: GPU resident (geometry + texture sources + render targets + drawing buffer) <= 160 / 220 MB, textures <= 64 / 96 MB, JS heap (performance.memory, after 3 forced GCs; includes ArrayBuffer stores) <= 120 / 150 MB, rows from budgets.mjs MEMORY_BUDGETS. Vacuity leg (geometries > 50, textures > 3, geometry > 1 MB). **`--mutate`** (every lazy story scene resident at LOD0 twice, fresh buffers + sources) FAILS; `--prod` grades the vite build via vite preview. Own 3101/8091 stack. RED on HEAD 2026-09-23: heap 213.6 / 212.8 MB (116.5 MB of it typed-array CPU copies). |
| test-session-telemetry.mjs | quick (logic) | b1.7c (critique-05/14, D35): src/client/network/sessionTelemetry.ts with a fake pacer (FramePacer rendered-interval tap) and fake pagehide: exactly one summary per match (end screen, Return to Port, or pagehide mid-match; none after), the reload marker set at match start and cleared at the end screen, a marker left without pagehide reported once at the next boot as reloadWithoutCleanExit (the iOS memory-kill signature), p50/p95 from the 1 ms histogram, long tasks and long frames > 100 ms, context losses, no field outside the whitelist (no ip/name/player id/device id/raw UA), the server sanitiser accepts it unchanged; the Show FPS p50 follows the last 5 s. Mutation (end keeps the marker, pagehide re-sends) -> 3 FAIL. |
| test-beacon-store.mjs | quick (logic) | b1.7c (critique-05/14, D35): src/server/net/beaconStore.ts. 10k synthetic beacons serialize <= 5 MB and a 200 KB ring keeps the newest past its cap; error signatures (message with numbers flattened + top frame without host, Vite hash, line:col) group across builds with per-build and per-device counts; a session nonce counts once and keeps an earlier killed verdict; /health/beacons and /health/telemetry answer 403 without / with a wrong HEALTH_KEY and to proxied or non-loopback callers when no key is set; scripts/triage-beacons.mjs against a fake server lists a 3-session signature, omits a 2-session one, grades fps shares (phone 9/10 >= 24, desktop 2/4 >= 45) and refuses loudly on 403; the ring reloads from its volume file. Mutation (no session eviction, keep Vite hash, skip access check, min-sessions - 1) -> 13 FAIL. |
