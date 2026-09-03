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
| `test-storm-wall` | the old storm-wall-probe as a gate: night sea ≤ sky luma, noon sea chroma ≤ 1.3× sky | yes | wave 0.4; **red by design** until lane 5.4 (STORMVIS-01) lands (noon 6.67×); slow |

## Server suites (2)

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

**Red by design (GATES-01).** Six gates were written first and fail on HEAD on
purpose; each grades a defect the 2026-09-01 audit found unguarded and stays
red until its fix lane lands. `npm run test:logic` exits 1 for the whole
campaign because of them, so read the FAIL lines, not the exit code, until the
runner grows an `expectRed` vocabulary. They are not in the quick tier.

| suite | red on HEAD because | goes green with |
|---|---|---|
| `test-avatar-pose-invariants` | boots at -0.19, head 1.92 vs 1.68 | AVATAR-01 (wave 2) |
| `test-ship-attitude-frame` | XYZ root Euler: bow dips E/W | SHIP-01 (lane 1.3) |
| `test-ship-hole-vis` | fire burn-down / recycled slot leave the decal behind; `ship-dark-timber` bars the breach at 0.178 m | SHIP-01 (lane 1.3, landed) |
| `test-ship-helm-anchor` | wheel span on yaw rate (−12.32 rad from a ram, 0 at the helm); galleon anchor stock at +1.09 m; 7 hoist heights draw both canvases | SHIP-01 (lane 1.3, landed) |
| `test-ship-geometry` | hold floor 24/24 verts outside the loft, stern 0.85 m aft | HULLGEO-01 |
| `test-asset-bounds` | boulder_b r 2.6 vs reach 2.3, log sphere 0.38x (world-space TRS applied) | ASSETS lane |
| `test-quality-preference` | Safari M2 Air (opaque "Apple GPU") and four other rows grade `balanced` | PERF-01 (lane 2.6) |
| `test-storm-wall` (browser) | noon sea chroma 6.67× sky | STORMVIS-01 (lane 5.4) |

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
| `scripts/test-*.mjs`, `audit-*.mjs` | gates, all wired in `lib/suites.mjs` | 111 |
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
