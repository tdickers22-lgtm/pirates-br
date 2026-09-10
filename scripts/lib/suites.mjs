// THE SUITE MANIFEST — the one place that knows what "the tests" are.
//
// WHY IT IS A FILE AND NOT A package.json STRING. `test:logic` was a single
// 3,900-character `&&` chain and `test:browser` another. Three things followed
// from that shape and every one of them has bitten this repo:
//
//  • `&&` STOPS AT THE FIRST FAILURE. One red suite hid the state of the sixty
//    behind it, so a chain that died early looked exactly like a chain of one
//    problem — and the HUD suite sat failing four assertions for a whole wave
//    because nothing ever reached it.
//  • NOTHING CROSS-CHECKED THE LIST. Suites were written, committed, and never
//    added to it. test-remote-interpolation and test-remote-smoothness — the
//    gates for the wave that shipped REMOTE_MOTION.md — were among eight files
//    on disk that no npm script ran. `npm run test:audit` now fails when a
//    `scripts/test-*.mjs` is not accounted for here.
//  • A SUITE'S NEEDS WERE INVISIBLE. Whether a given file wanted a browser, a
//    server, a pinned map or nothing at all was knowable only by reading it, so
//    the runner could not stand up what a suite required and suites quietly
//    graded whatever stack happened to be up.
//
// Each entry is: how to run it, what it needs, and — for anything deliberately
// not run — why not. `evidence` is the pattern that proves the suite actually
// graded something; see run-all-tests.mjs for what is done with it.

/** A line matching this is a suite saying something gradeable out loud. Every
 *  suite in this repo prints one of these three dialects. A run that produces
 *  NONE of them has not passed — it has failed to assert, which is how
 *  `test-perf-budget` reported success for a week while measuring nothing. */
export const EVIDENCE = /(^|\s)(✓|✗|PASS\b|FAIL\b|OK:)/m;

/** `node` for plain ESM; `node --import tsx` for anything that imports src/. */
const tsx = (file) => ({ file, cmd: ['node', '--import', 'tsx', `scripts/${file}`] });
const plain = (file) => ({ file, cmd: ['node', `scripts/${file}`] });
/** THE PRE-COMMIT TIER. `quick` marks a logic suite measured under 1.5 s on
 *  this Air (test-results/summary.json, HEAD dcd831d0): 52 suites, 15 s serial.
 *  `npm run test:quick` runs only these against a 60 s soft ceiling (FAIL at
 *  2x). Tag a new suite only after reading its ms off a summary.json; never a
 *  suite that boots a server or walks a world. */
const quick = (s) => ({ ...s, quick: true });

/**
 * LOGIC SUITES. No browser, no server, no ports — they import the real
 * simulation out of src/ and drive it. Safe to run anywhere, in any order.
 */
export const LOGIC = [
  quick(plain('test-edge-gate.mjs')),
  quick(plain('test-water-entry.mjs')),
  quick(plain('test-barrel-flow.mjs')),
  quick(plain('test-kill-streak-powers.mjs')),
  quick(tsx('test-wildlife-meat.mjs')),
  tsx('test-wildlife-flee.mjs'),
  quick(tsx('test-ship-interactions.mjs')),
  quick(tsx('test-swimmer-ship-collision.mjs')),
  quick(tsx('test-keg-placement.mjs')),
  quick(tsx('test-sea-rock-colliders.mjs')),
  quick(tsx('test-sea-rock-ship-damage.mjs')),
  quick(tsx('test-occlusion.mjs')),
  quick(tsx('test-game-balance.mjs')),
  quick(tsx('test-terrain-detail.mjs')),
  tsx('test-perf-scenes.mjs'),
  quick(tsx('test-foliage-geometry.mjs')),
  // [rocks] (2026-09-09). Every `<name>_far.glb` welded at 1e-4 against its
  // source: a rock's far file has no boundary loop, every decimated far file
  // keeps ≥ 92% of the surface area and ≤ 40% of the triangles. The first far
  // files were Collapse run on split vertices — half the surface deleted —
  // and nothing measured them as surfaces. 0.2 s of file arithmetic.
  quick(plain('test-far-lod-integrity.mjs')),
  quick(tsx('test-ocean-dynamics.mjs')),
  // PLAID-01 (wave 3.4). The far-ocean lattice, graded as a 2-D power spectrum
  // of the shipped foam field rather than as an FFT of a screenshot: the plaid
  // is a property of the FIELD, and the field is closed form, so this is a
  // 0.3 s logic suite instead of a stack + a browser. It parses the octave
  // scales and rotations out of OCEAN_FRAG, so the mirror cannot drift.
  quick(tsx('ocean-lattice-probe.mjs')),
  // GFXPOL-01 (wave 8.2). The same measurement turned on the two OTHER
  // hand-drawn grids: the sea-stack mottle (one hash per floor()ed 1.8 m cell)
  // and the terrain caustics (a product of two world-axis sines switched on by
  // step() across one contour, i.e. a bright ring at 0.6 m around every coast).
  // Both fields are closed form, so this grades them directly — worst adjacent
  // brightness step over an 8 m patch, worst modulation change per 1 cm of
  // height — off the GLSL strings the shaders are actually compiled from.
  quick(tsx('test-shader-lattice.mjs')),
  // GFXPOL-01 (wave 8.2). The cloud deck's thickness: the spread of shading
  // inside a cloud's silhouette, graded against the shipped 2-octave field as
  // the control, plus the proof that the low tier's cloud field is still
  // bit-identical to the one it had before the ladder existed.
  quick(tsx('test-cloud-depth.mjs')),
  // GFXPOL-01 (wave 8.2). The colour grade: which tiers get one at all (it was
  // 'high' only, so balanced played an ungraded game), that mid grey stays
  // neutral under the split tone, and that the body still costs no fetch — it
  // rides inside OutputPass and must never become a pass again.
  quick(tsx('test-grade.mjs')),
  // GFXPOL-01 (wave 8.2). Whether a lantern is bright enough for the bloom pass
  // to see it at night, which is arithmetic on the shipped threshold curve and
  // the shipped glow opacities — and whether noon still blooms at the old 1.05.
  quick(tsx('test-lantern-bloom.mjs')),
  // WATER-01 (wave 3.4). The hull cut-out that keeps the exterior sea out of
  // the hold: the GLSL outline is parsed back out of OCEAN_FRAG and graded
  // against the shared getSwimHullHalfWidth, and setHullMasks' culling /
  // ordering / zero-allocation contract is driven through the real API.
  quick(tsx('test-ocean-hull-mask.mjs')),
  // SHADOW-01 (wave 4.3). The four numbers the lighting rig got wrong, graded
  // without a rasteriser: normalBias as a count of shadow texels instead of a
  // hand-picked metre (and re-derived across the governor's whole map-size
  // ladder), the heightfield casting BackSide, the sea's shadow wiring read
  // back out of the shipped OCEAN_VERT/OCEAN_FRAG, and the storm key/fill
  // trade plus the third DirectionalLight that is no longer allocated.
  quick(tsx('test-shadow-bias.mjs')),
  // STORMVIS-01 (wave 5.4): the weather anchor (one position for overcast, rain,
  // wall nearness and lightning), the leak gate's sea-state, thunder delay, the
  // deleted halo/ring/rain-canvas, and the storm front + sky shader terms read
  // back out of the shipped GLSL. 0.2 s, no stack.
  quick(tsx('test-storm-visuals.mjs')),
  // STORMUP-01 (wave 9.2): the weather is one set of SHARED fields, not two sets
  // of client-local scalars. Grades stormCloudDensity/stormRain against the
  // client functions they replaced point for point, and grades the gust field
  // bounded, zero-mean, and continuous in x/z/t (a hashed cell lattice snaps the
  // wind 1.2 rad across a border). 0.3 s, no stack.
  quick(tsx('test-storm-fields.mjs')),
  // STORMUP-01 (wave 9.2), storm-04: the bolts are rolled by the server off the
  // match-seeded stream into a replicated ring buffer, in a band that is wholly
  // OUTSIDE the safe ring, and the mainmast conducts them unless the crew bought
  // the rod. Mutation: restore the old client band (0.88 + rand*0.38) and 34.7%
  // of bolts land inside shelter again. ~2 s, no stack.
  tsx('test-storm-lightning.mjs'),
  // [I.3] the five authored weapon GLBs must land in the envelope the
  // primitive-era viewmodel constants (muzzleTipFor, the hand grips, the near
  // plane) were measured in — the logic-tier half of test-near-plane-clearance.
  // Mutation: PIRATES_BR_MUTATE_VIEWMODEL=nofit.
  quick(tsx('test-viewmodel-envelope.mjs')),
  // [I.2] the 1024² bathymetry texture is built a few rows per frame; the
  // deadline must be read inside a row or the 2 ms budget is a fiction.
  quick(tsx('test-bathymetry-budget.mjs')),
  // [9.1] FLORA-01: radial scatter sampling must be area-uniform (the old
  // radius-uniform draw made every island ~7x denser in the middle than at the
  // rim) and the low tier must get a ground-cover BUDGET, not a gate that left
  // integrated-GPU players on bald islands. Mutation: revert radialFill to the
  // lerp, or set the low branch's grassCap to 0.
  quick(tsx('test-flora-density.mjs')),
  quick(tsx('test-island-props.mjs')),
  quick(tsx('test-asset-merge.mjs')),
  quick(tsx('test-ship-dynamics.mjs')),
  quick(tsx('test-ship-ladder.mjs')),
  quick(tsx('test-server-fixes.mjs')),
  quick(tsx('test-flooding.mjs')),
  // HULL-01: cannonball-vs-hull parity with the drawn wale (swept swim-hull
  // skin, stem crossings, deck-vs-breach classification).
  quick(tsx('test-projectile-hull-parity.mjs')),
  quick(tsx('test-locomotion.mjs')),
  // PRED-01: the shared pirate step (server + client prediction) against a
  // transcription of the pre-extraction Match block, plus the ack-delay
  // reconciliation. Logic tier, no stack, ~2 s.
  quick(tsx('test-prediction.mjs')),
  // PRED-01/physics-09: the client's mirror of a server pushout must stand in
  // the same place the server's does. Logic tier, ~1 s.
  quick(tsx('test-client-prediction-parity.mjs')),
  quick(tsx('test-world-fixed.mjs')),
  // RNG-01: two seeded Matches ticked 90 s side by side, state hashed each
  // second, plus a different-matchId control. ~11 s, so not in the quick tier.
  tsx('test-match-determinism.mjs'),
  // RNG-01 pacing gate: minutes of seeded sim, so opt-in (PACING=1) and long.
  { ...tsx('test-pacing-curve.mjs'), optIn: 'PACING', timeoutMs: 1_500_000,
    why: 'opt-in slow tier: set PACING=1 (two 13-minute seeded matches)' },
  // DEV-01: dev hooks refused without PIRATES_BR_DEV_HOOKS=1 / MatchOptions.devHooks;
  // stats skip dev-assisted matches. Pure Match + StatsStore, ~1 s.
  quick(tsx('test-dev-hooks.mjs')),
  quick(tsx('test-traversal.mjs')),
  quick(tsx('test-revive.mjs')),
  // SPAWN-01: 12 crews, 10 piers x 2 berths — no hull stacked on another, bot
  // fleet moored, late joiner anchored. ~4 s of real Match, no stack.
  quick(tsx('test-spawn-berths.mjs')),
  // CREW-01: a party of N shares ONE hull — crew record, crew-scaled hull,
  // crewmates set down a stride apart, small arms passing through a crewmate.
  quick(tsx('test-crews.mjs')),
  // DECK-01 / ships-24 phase 1: the hull loft moved to src/shared/hull.ts —
  // pins every derived number against the pre-move renderer capture, the sheer
  // vs walk-taper standing contract, and "only one LOFT_STATIONS in src/".
  quick(tsx('test-hull-loft.mjs')),
  // PHYS-02 / physics-02: grounding sampled the KEEL LINE, so a hull laid
  // beam-on to a cliff sailed her whole broadside into the rock and the server
  // called it clear water. 30,240 placements round all 14 islands; ~4 s, so
  // logic tier but NOT quick.
  tsx('test-hull-vs-terrain.mjs'),
  // DECK-01: the crew stand on the planking that is DRAWN — the shared 3D ship
  // frame graded against an independent Ry·Rx·Rz reference at the attitude caps
  // (3.3 m of daylight at a galleon bow before it).
  quick(tsx('test-deck-attitude.mjs')),
  quick(tsx('test-snapshot-size.mjs')),
  quick(tsx('test-combat-fixes.mjs')),
  quick(tsx('test-geyser.mjs')),
  // PHYSREM-01 (wave 8.3). Bodies in the cannonBallistic branch driven over the
  // real fixed world: single-tick vertical LIFT at cliff faces (a landing may
  // raise a body onto the ground under it, never by a cliff height), bodies held
  // under cave roofs, and the tavern's slates as a real surface. Quick tier, no
  // stack, 0.5 s measured on this Air.
  quick(tsx('test-ballistic-terrain.mjs')),
  tsx('test-cave-walk.mjs'),
  tsx('test-swim-shore.mjs'),
  quick(tsx('test-harvest.mjs')),
  quick(tsx('test-shark-lunge.mjs')),
  quick(tsx('test-shark-surface.mjs')),
  quick(tsx('test-shark-inland-shove.mjs')),
  quick(tsx('test-shark-spawn-curve.mjs')),
  quick(tsx('test-station-spacing.mjs')),
  quick(tsx('test-block.mjs')),
  quick(tsx('test-skeleton-crowd.mjs')),
  quick(tsx('test-deck-safety.mjs')),
  quick(tsx('test-stats.mjs')),
  quick(tsx('test-dock-frame.mjs')),
  quick(tsx('test-gangway-walk.mjs')),
  quick(tsx('test-climb-verbs.mjs')),
  quick(tsx('test-prop-colliders.mjs')),
  quick(tsx('test-light-budget.mjs')),
  quick(tsx('test-first-draw-budget.mjs')),
  quick(tsx('test-frame-governor.mjs')),
  quick(tsx('test-island-reveal.mjs')),
  tsx('test-interaction-arbiter.mjs'),
  // HUD-01/hud-12: prompt ⊆ grant on a 0.25 m deck grid, all three hulls (w1.6).
  quick(tsx('test-interact-parity.mjs')),
  // HUD-01/hud-01,02,03,27: one wheel table, the axe's key, the modal layer,
  // and letting go of every held key on blur (w1.6).
  quick(tsx('test-hud-wheel-and-input.mjs')),
  // HUD-01/hud-04, liveplay-07, storm-09: two alarm lines, the ring bearing,
  // the wall distance and its ETA (w1.6).
  quick(tsx('test-hud-storm-warnings.mjs')),
  // FEED-01 client half (hud-23, hud-29, liveplay-06/23) + hud-26 (w1.6).
  quick(tsx('test-hud-feed-scope.mjs')),
  // FEED-01/liveplay-21: the defender's ship_hit — HULL STRUCK line, compass
  // arc at the guns, bounded shudder, one feed row per attacker (w1.6).
  quick(tsx('test-hud-ship-struck.mjs')),
  // WIRING, not copy: every message the server broadcasts reaches a case in
  // NetworkClient AND a handler something in src/client assigns. `ship_sunk`
  // and `carpenter_patch` were both landed on the wire with no client case at
  // all and no suite noticed, because the suites that graded them asserted on
  // the SERVER payload (review-0 P1, fixup0).
  quick(plain('test-wire-consumers.mjs')),
  // ONLINE-01 / codehealth-13: the other direction. Every ClientMsgType has one
  // validator in src/server/net/validate.ts, LobbyServer routes nothing that
  // has not been through it, and the five shipped holes (solo_start's NaN
  // fleet, set_name's throwing .trim(), the unchecked party ids, ping's 64 KB
  // echo, trade_action's crashing cast) are pinned one by one (w8.4).
  quick(tsx('test-wire-validation.mjs')),
  // ONLINE-01 phase 2 (netcode-24): N matches on ONE process. Server-side only
  // (no browser, no GPU) but ~45 s and CPU-bound, so NOT quick tier. Grades
  // worstSimLagSec < 0.1 at 8 matches, the capacity refusal above the ceiling,
  // and /health's accepting/maxMatches/rejectedFrames fields (w8.4).
  { ...tsx('perf-server-load.mjs'), timeoutMs: 180_000 },
  // PARTY-01 client half: the six-character code the server issues survives
  // every client path that carries it (it was truncated to four in three
  // places, which made private crews unjoinable), plus the party panel's
  // roster model and the DOM contract the controller binds to (w3.5).
  quick(tsx('test-menu-party-ui.mjs')),
  // hud-22: ONE Escape key. The stack's negative property is the important
  // one — an empty stack consumes nothing, so the in-match pointer-lock
  // release and the name field keep their keys (w3.5).
  quick(tsx('test-modal-stack.mjs')),
  // CREWHUD-01: who is on my crew, what they are doing, and the throttle that
  // keeps the strip off the per-frame allocation path (w3.5).
  quick(tsx('test-crew-ui.mjs')),
  quick(tsx('test-block-hold.mjs')),
  tsx('test-grounding-cap.mjs'),
  // Not quick: 103.6s of its own on this machine (2026-09-03 run), which alone
  // blew the 60s quick-tier ceiling. It still runs in the full logic tier.
  tsx('test-material-floor.mjs'),
  quick(tsx('test-sea-voids.mjs')),
  tsx('test-bot-peace-window.mjs'),
  // BOT-02: a bot whose lone pirate is dead is an unmanned hull (w1.1).
  tsx('test-bot-ghost-helm.mjs'),
  // BOT-01/bots-v03: dry pieces are skipped, the crate tops a bot up in a lull (w1.1).
  tsx('test-bot-ammo.mjs'),
  // BOT-01/liveplay-19: a hull moored at a dock berth is spared until 270 s (w1.1).
  tsx('test-bot-berth-truce.mjs'),
  // BOTCREW-01/bots-v02/bots-06: a bot helmsman answers her helm like a player,
  // and works the capstan and the rigging instead of switching them (w3.2).
  tsx('test-bot-seamanship-parity.mjs'),
  // BOTCREW-01/bots-16/bots-03: a two-hand bot crew keeps firing while a hand
  // is free for the breach; a lone pirate still has to choose (w3.2).
  tsx('test-bot-crew-roles.mjs'),
  // BOTFUN-01/bots-08: a bot hunts what she can SEE — tier sight x storm
  // weather, a loud cue inside 200 m, and a 25 s memory (w6.2).
  tsx('test-bot-perception.mjs'),
  // BOTFUN-01/bots-15, bots-14: the behaviour tree has named leaves and a
  // voice — >=3 distinct branches per crew over an arc, >=1 line per 2 min.
  // Not `quick`: it sails a whole 9-crew match (~90 s on this Air) (w6.2).
  tsx('bot-intent-probe.mjs'),
  quick(tsx('test-oneshot-underload.mjs')),
  tsx('test-gold-cargo.mjs'),
  tsx('test-wreck-event.mjs'),
  quick(tsx('test-wreck-site.mjs')),
  tsx('test-capture.mjs'),
  quick(tsx('test-reach-vocabulary.mjs')),
  quick(tsx('test-story-delivery.mjs')),
  quick(tsx('test-shanty-grammar.mjs')),
  // CAVE-01 (islandworld-05): the cave drip bed, on a fake clock — pure, so no
  // AudioContext and no stack. PIRATES_BR_MUTATE_DRIP=grid proves it can fail.
  quick(tsx('test-cave-audio.mjs')),
  quick(tsx('test-coast-wobble.mjs')),
  // GRID-01 (w7.2): the ONE terrain grid — GridGround vs the drawn triangles
  // within 1 mm, tier-independent positions, ring doubling, the 1.22 apron, a
  // watertight stitch and the baked vertex AO. MUTATE=analytic|tier|nostitch
  // proves each half can fail.
  quick(tsx('test-terrain-grid.mjs')),
  // GRID-01 slice c (w7.2): one apron for the walk floor, the swim seabed and
  // the terrain raycast. MUTATE=footprint|seabed|raylimit restores each of the
  // three old cut-offs and each turns it red.
  quick(tsx('test-walk-off-edge.mjs')),
  // ENTITYSEAT (w7.2): chests, barrels and stations on the DRAWN ground, not
  // the analytic field. MUTATE=raw restores the old placement (60/133 out).
  quick(tsx('test-entity-seat.mjs')),
  // POSE-01 wire half (w7.5): `aiming` and `atCapstan` cross the wire, are
  // momentary, and cost nothing when false. Comment out updateAimStance (or the
  // atCapstan line) in Match to see it fail.
  quick(tsx('test-aim-wire.mjs')),
  // MATCHSPLIT-01 (w7.5): the tick spine — which subsystem runs when, and how
  // many draws each takes off the shared seeded stream. Pins the Match.ts split
  // against a silent re-order. Swap two update* calls in tick() to see it fail.
  tsx('test-tick-order.mjs'),
  quick(tsx('test-death-causes.mjs')),
  // WIN-01 / TOW-01 / OPEN-01 (wave 1.5). All three drive a real Match on real
  // ticks with no stack; test-respawn-tow and test-capstan-first-safe run tens
  // of seconds of sim, so neither is tagged `quick`.
  quick(tsx('test-win-condition.mjs')),
  tsx('test-respawn-tow.mjs'),
  tsx('test-capstan-first-safe.mjs'),
  tsx('test-storm-spawn-safety.mjs'),
  tsx('test-storm-outrun.mjs'),
  // END-01 (wave 3.3). The eye-collapse sim and the ring Monte Carlo: 200 ring
  // sequences over 5 generated worlds, so it costs ~60 s of CPU and no stack.
  // Not `quick` for that reason — it is a logic-tier suite, not a browser one.
  tsx('test-storm-endgame.mjs'),
  tsx('test-damage-visibility.mjs'),
  quick(tsx('test-endmatch-board.mjs')),
  quick(tsx('test-landing-stores.mjs')),
  // WIRED HERE FOR THE FIRST TIME. The gates for the remote-motion wave shipped
  // with the wave and were run by nothing: a continuous-path proof and its
  // mutation twin, sitting on disk for a fortnight. test-remote-interpolation
  // drives the buffer directly and needs no stack at all.
  quick(tsx('test-remote-interpolation.mjs')),
  quick(tsx('audit-floating-props.mjs')),
  // GATES-01 (wave 0.4): written RED FIRST, on purpose. Each grades a defect the
  // 2026-09-01 audit found unguarded and stays red until its fix lane lands —
  // that is the record that the gate can fail, not a broken build. Not in the
  // quick tier so a pre-commit run in another lane is not blocked by them.
  //   test-avatar-pose-invariants — boots -0.19, head 1.92 vs 1.68 (AVATAR-01, wave 2)
  //   test-ship-attitude-frame    — XYZ root Euler: bow never dips E/W (SHIP-01, lane 1.3)
  //   test-ship-geometry          — hold floor / trim / iron outside the loft, stern 0.85 m aft (HULLGEO-01)
  //   test-asset-bounds           — boulder_b r 2.6 vs reach 2.3, log sphere 0.38x (ASSETS lane); node TRS applied
  tsx('test-avatar-pose-invariants.mjs'),
  //   test-avatar-rig             — the skinned pirate's contract: 23 bones, head bone == PLAYER.HEAD_Y,
  //                                 33 clips present and non-empty, dressed tris/draws/materials (RIG-01, lane 7.1).
  //                                 Pure GLB JSON parse — no THREE, no GPU, ~60 ms.
  tsx('test-avatar-rig.mjs'),
  //   test-avatar-rig-drive       — the rig DRIVEN: SkeletonUtils clone, the dressed set, the crew tint,
  //                                 disjoint upper/lower masks, state->clip, soles on the ground, the
  //                                 distance mixer LOD and the low-tier gate (RIG-01, lane 7.1).
  tsx('test-avatar-rig-drive.mjs'),
  tsx('test-ship-attitude-frame.mjs'),
  //   test-ship-hole-vis          — hole decals never re-read moved coords; strakes bar the breach (SHIP-01, lane 1.3)
  tsx('test-ship-hole-vis.mjs'),
  //   test-ship-helm-anchor       — wheel on yaw rate, galleon anchor in the air, sail+bundle both drawn (SHIP-01, lane 1.3)
  tsx('test-ship-helm-anchor.mjs'),
  tsx('test-ship-geometry.mjs'),
  //   test-ship-geometry-hash     — the refactor seatbelt for HULLGEO-01: the drawn geometry of all three
  //                                 hulls hashed against scripts/fixtures/ship-geometry.snapshot.json, so a
  //                                 "pure move" of ShipRenderer into rendering/ship/* cannot change a vertex
  //                                 unnoticed. --update rebuilds the baseline; --mutate is its red proof.
  tsx('test-ship-geometry-hash.mjs'),
  //   test-ship-plank-shader      — SHIPVIS-01 phase A: the procedural planking injected into hullMat and
  //                                 deckMat. Grades declaration-before-use in three's chunk order, that the
  //                                 patch CHAINS with the breach see-through discard instead of replacing it,
  //                                 that the low tier compiles the colour-only program, and that the wet line
  //                                 is a live uniform that climbs the topside as she floods. --mutate is red.
  tsx('test-ship-plank-shader.mjs'),
  //   perf-cost-model             — perf-15's resident-geometry census: a full match's hulls built by the
  //                                 real ShipRenderer, every BufferGeometry billed once by identity, graded
  //                                 against the 8 MB ship budget. --no-cache reproduces the pre-fix 25.4 MB
  //                                 and is its red proof; the plain run also verifies every shared buffer.
  tsx('perf-cost-model.mjs'),
  //   test-ship-rigging           — ships-16: the rigging is instanced cylinders, not hairlines, and every
  //                                 rope made fast to a yard still ends on that yard within 5 cm after a
  //                                 60-degree brace. Refuses to grade a ship whose yards did not move.
  //                                 --mutate freezes the yard-attached instances and is its red proof.
  tsx('test-ship-rigging.mjs'),
  //   test-ship-wake              — SHIPVIS-01 phase B: the Kelvin wedge. Measures the drawn arm geometry
  //                                 and requires arcsin(1/3) = 19.47 deg at four yaws and two speeds (the
  //                                 wedge lengthens with speed, never widens), that the low tier builds no
  //                                 arm at all, that they cost no second draw, and that the fade reaches
  //                                 sub-millimetre width BEFORE leaving the draw range so nothing pops.
  //                                 --mutate collapses the arms onto the ship's track and is its red proof.
  tsx('test-ship-wake.mjs'),
  //   test-hold-lanterns          — ships-23: the hold's two lanterns are served by exactly ONE registered
  //                                 budget light, unmoved in position, intensity and range, with the pair
  //                                 hung symmetrically about it and both emissive so neither reads as unlit.
  //                                 Also grades that they share two materials (so they merge into the hull
  //                                 bake) and prints the low/high triangle cost. --mutate gives the after
  //                                 lantern its own point light — the obvious fix — and is its red proof.
  tsx('test-hold-lanterns.mjs'),
  tsx('test-asset-bounds.mjs'),
  //   test-hero-assets            — the atlas-textured hero GLBs (weapons, ship hardware): triangle band,
  //                                 ONE material with a baseColorTexture, COLOR_0 present and WHITE (the AO
  //                                 is in the atlas now), the node names the viewmodel and the aim rig
  //                                 address, the pivots, and the far LOD. PIRATES_BR_MUTATE_HERO is its red
  //                                 proof (WEAPON-01 / HWGLB-01, lane 5.3)
  quick({ file: 'test-hero-assets.mjs', cmd: ['node', 'scripts/test-hero-assets.mjs'] }),
  //   glb-census --check          — the models README's counts vs disk + ASSET_NAMES/FAR_ASSET_NAMES
  //                                 (64 / 63 / 61 / 56 were all quoted as the contract; assets-20, lane 2.5)
  quick({ file: 'glb-census.mjs', cmd: ['node', 'scripts/glb-census.mjs', '--check'] }),
  //   test-fauna-census           — the shark is the closest a creature ever gets to the camera (it swims at
  //                                 your face in the dodge window) and was the lowest-fidelity mesh we
  //                                 shipped: 1,972 tris, a belly sphere pushed through the hull, three node
  //                                 rotations for a swim. Grades the skinned hero (>=8k tris, skin, joints,
  //                                 swim+bite clips, unchanged 3.4 m silhouette) AND the low-tier swap
  //                                 shark_far (<=3.2k, unskinned, the four pivot nodes the fallback animator
  //                                 drives) — without that second file SHARK.MAX_WORLD=4 heroes are +25k tris
  //                                 in a low-tier frame (FAUNAGLB-01/assets-12, w6.6)
  quick({ file: 'test-fauna-census.mjs', cmd: ['node', 'scripts/test-fauna-census.mjs'] }),
  //   test-fauna-gait             — the shark's pose maths (pure, out of Game.syncSharks) and the mixer's
  //                                 distance LOD: every frame inside 45 m, 15 Hz off a LOSSLESS accumulator
  //                                 to 130 m, nothing past that. The accumulator is the graded part — drop
  //                                 time there and a shark that swims out and back returns at a different
  //                                 phase, a pop on the one creature a player is watching (FAUNAGLB-01, w6.6)
  tsx('test-fauna-gait.mjs'),
  //   test-prop-ground-ao         — AO-01: a prop's OWN base occlusion, baked into COLOR_0 once per cached
  //                                 geometry. Graded because every failure here is silent: without the
  //                                 userData latch ten islands take one barrel to 0.62^10 (black), and a ramp
  //                                 that reaches the canopy is a global dimmer wearing occlusion's name. Also
  //                                 pins the zero-cost claim — no new attribute, same mutated array (w7.3)
  quick(tsx('test-prop-ground-ao.mjs')),
  //   test-story-lazy             — LOD-01: the fifteen story tableaux (~17 MB, 25-48k tris each) leave
  //                                 preloadWorld and load through AssetLibrary.ensure() behind a seated,
  //                                 named placeholder. Graded because both halves are silent when wrong: a
  //                                 leak back into the world set only shows as a longer countdown, and a
  //                                 placeholder that is not seated/named only shows in the floater census
  //                                 four suites later (w7.4)
  quick(tsx('test-story-lazy.mjs')),
  //   test-ocean-tier             — OCEANTIER-01: the ocean fragment shader is the heaviest in the game over
  //                                 45-55% of the frame and was IDENTICAL on low and high. Grades the
  //                                 OCEAN_TIER define on both ocean programs, the static fill-op count per
  //                                 tier (897 / 1369 / 1709), and the parity rule that the VERTEX stage has
  //                                 no tiers — one displaced surface, shared with the physics (w7.4)
  quick(tsx('test-ocean-tier.mjs')),
  //   check-hud-ids               — every id the client reads by string exists in index.html, and no id inside
  //                                 the HUD block is driven by nothing. TypeScript cannot see through
  //                                 getElementById('x'), so a renamed id used to type-check and then silently
  //                                 stop painting one line of HUD (HUDS-01/codehealth-16, w6.5)
  quick({ file: 'tools/check-hud-ids.mjs', cmd: ['node', 'scripts/tools/check-hud-ids.mjs'] }),
  //   test-quality-preference     — detector rows per device: RENDERER_RULES sends the opaque-Apple Air,
  //                                 phones, Adreno and Intel UHD to 'low', 'low' is the unknown default, and a
  //                                 fill-bench score or a headroom proof is the only way back up (PERF-01, lane 2.6)
  tsx('test-quality-preference.mjs'),
];

/**
 * SERVER SUITES. No browser, but a real LobbyServer on a real socket. They sat
 * in LOGIC ("no ports") while binding fixed ports: test-net-resilience on 8791
 * hung behind a stale listener until the 900 s kill, and a two-minute logic run
 * took seventeen with nothing recording why. The runner hands them
 * PIRATES_BR_TEST_PORT=0 (kernel-picked port) and each carries a timeout sized
 * off a real run: net-resilience needs 47 s of heartbeat windows.
 */
export const SERVER = [
  { ...tsx('test-net-resilience.mjs'), timeoutMs: 120_000 },
  // PARTY-01: the lobby state machine (create/join/ready/kick/crown/start/end/
  // play-again) over real sockets on a kernel-picked port. It sleeps through
  // the auto-detach, reap and lockout clocks turned down via LobbyServer
  // .tunables, and spawns ~10 short matches, so it wants more than the tier's
  // default: measured 46 s on this Air.
  { ...tsx('test-lobby-flow.mjs'), timeoutMs: 180_000 },
  { ...tsx('test-http-hardening.mjs'), timeoutMs: 60_000 },
  // BOOT-01 (wave 4.4). What the real LobbyServer puts on the wire for the 27 MB
  // of client it serves: precompressed br/gz siblings, `.glb` as
  // model/gltf-binary, ETag/304, and `immutable` earned by a Vite content hash
  // instead of promised for a year on `/assets/models/palm_a.glb`. Needs
  // `dist/client` (it fails with that instruction when the build is absent) and
  // writes the siblings itself, which costs ~12 s the first time and ~0.3 s
  // after, since they are stamped at their source's mtime.
  { ...tsx('test-static-serving.mjs'), timeoutMs: 120_000 },
];

/** Watchdog per tier (ms); an entry's `timeoutMs` overrides it. A suite silent
 *  past this is hung, not slow. Logic suites finish in 1-18 s on this Air, so
 *  120 s reports a hang in two minutes rather than fifteen. */
export const TIER_TIMEOUT_MS = { logic: 120_000, server: 120_000, browser: 900_000 };

/**
 * BROWSER SUITES. Every one wants a page: `PIRATES_BR_URL` for the client and,
 * through the Vite that serves it, a game server on `PIRATES_BR_SERVER_PORT`.
 * `slow` marks the ones that own the machine for minutes — they run last so a
 * cheap failure is reported in the first minute rather than the twentieth.
 */
export const BROWSER = [
  { ...plain('test-world-fidelity.mjs'), timeoutMs: 1_500_000 }, // two tiers (high + low) since I.4
  { ...plain('test-gameplay-smoke.mjs') },
  { ...plain('test-lod-reveal.mjs') },
  { ...plain('test-minimap.mjs') },
  { ...plain('test-chart-and-feed.mjs') },
  { ...plain('test-music-render.mjs') },
  { ...tsx('test-onboarding-ux.mjs') },
  // HUDS-01/hud-20, hud-16: the HUD measured at the three window shapes people
  // play in (960x540, 1280x720, 1366x650) — regions that must not overlap, <=24
  // strings at idle, the objective line never hidden, one gold readout, one
  // storm clock, and the [X] prompt inside the window AND clear of the footer.
  // One browser, one solo match, three resizes: ~95 s on this Air (w6.5).
  { ...plain('hud-layout-probe.mjs') },
  { ...plain('test-geometry-lod.mjs') },
  { ...plain('test-shadow-gate.mjs') },
  { ...plain('test-decor-batch.mjs') },
  { ...plain('test-frame-allocation.mjs') },
  { ...plain('test-frame-governor-live.mjs') },
  //   edge-shimmer-probe          — 'low' asks for and is granted default-framebuffer MSAA, and 30 same-size
  //                                 resize events cost at most one setSize (AA-01 + perf-v-02, lane 2.6).
  //                                 The staircase-count half is advisory unless a --ratio 1 baseline exists.
  { ...plain('edge-shimmer-probe.mjs') },
  { ...plain('test-join-stall-survival.mjs') },
  { ...plain('test-sim-lag-honesty.mjs') },
  { ...plain('test-motion-continuity.mjs') },
  // WIRED HERE FOR THE FIRST TIME — see test-remote-interpolation above. This is
  // the same contract measured through a real client against a real server.
  { ...plain('test-remote-smoothness.mjs'), slow: true },
  {
    ...plain('test-viewmodel-poses.mjs'),
    // A SKIP HAS TO BE DECLARED, NOT BURIED. This suite opens with
    // `if (IS_SOFTWARE_GL) { console.log('skipped'); process.exit(0); }` — and
    // exit 0 is what a pass looks like, so on the backend every graded run on
    // this machine uses it has been reporting a green suite that measured
    // nothing since the day it was written. Its reason is real (pose invariants
    // need frames at animation rate, and a software rasteriser cannot make
    // them), so it is not deleted — it is declared here, printed as SKIPPED in
    // the table, and counted as a pass by nobody.
    skipOn: 'software',
    why: 'pose invariants need real frames at animation rate; SwiftShader cannot produce them',
  },
  { ...plain('fixwave4-smoke.mjs') },
  { ...plain('audit-live-floaters.mjs'), slow: true },
  { ...plain('test-program-warm.mjs'), slow: true },
  { ...plain('test-load-responsiveness.mjs'), slow: true },
  { ...plain('test-perf-budget.mjs'), slow: true },
  // DEPTH. Both grade the same buffer from opposite ends: the first counts the
  // pixels standing on a depth-buffer tie (z-fighting, measured exactly rather
  // than sampled — see scripts/lib/zfight-probe.mjs), the second proves the near
  // plane those ties depend on takes no geometry out of the picture.
  { ...plain('test-z-fighting.mjs'), slow: true },
  { ...plain('test-near-plane-clearance.mjs'), slow: true },
  { ...plain('test-hud-death-and-feed.mjs'), slow: true },
  // GATES-01 (wave 0.4), written RED FIRST like their logic siblings above.
  // Both run at ?quality=low, 960x540, and grade counts / pixel ratios, so the
  // software rasteriser the runner uses here is a valid backend for them.
  //   test-fill-budget — stencil census: sky layers ≤0.55, whole/blended ceilings;
  //                      --mutate (sky depthTest=false) must FAIL
  //   test-storm-wall  — the old storm-wall-probe as a gate: night sea ≤ sky luma,
  //                      noon sea chroma ≤ 1.3× sky (RED on HEAD: noon 6.67×, blue sea under slate)
  { ...plain('test-fill-budget.mjs'), slow: true },
  { ...plain('test-storm-wall.mjs'), slow: true },
  // OCEAN-01 (wave 1.4). The fair-weather half of what test-storm-wall grades
  // under the ring: is the ocean lit by the sky it dissolves into? Reads the
  // sea/sky junction at noon on the LOW tier (no composer, so the material must
  // tone-map itself), the night body ratio (the inversion), the moon path, and
  // the wiring that makes those possible (shared fog density, scene light
  // uniforms, the active light after dark). RED on HEAD on every band.
  { ...plain('horizon-luminance-probe.mjs'), slow: true },
];

/**
 * AT THE TOP LEVEL OF scripts/, DELIBERATELY NOT A GATE — with its role, so the
 * audit can tell "known" from "forgotten". Everything else on that level must be
 * wired above. Instruments live in scripts/probes/ (read, never graded),
 * doc-cited tooling in scripts/tools/, shared code in scripts/lib/; `npm run
 * test:audit` fails on any other top-level .mjs. The six wave-scoped smokes
 * that used to sit here were deleted with the 2026-09-02 sweep (72 orphans).
 */
export const EXCLUDED = {
  'perf-probe.mjs':
    'shared instrument library (planScenes, measureScene, sessionQuery) imported by twelve browser suites — a module, not a gate',
  'pacing-sim.mjs':
    'the pacing instrument (lane 0.3 owns it); its gate is test-pacing-curve, opt-in under PACING=1',
};

export const ALL = [
  ...LOGIC.map((s) => ({ ...s, kind: 'logic' })),
  ...SERVER.map((s) => ({ ...s, kind: 'server' })),
  ...BROWSER.map((s) => ({ ...s, kind: 'browser' })),
];
