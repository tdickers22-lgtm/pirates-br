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

/**
 * LOGIC SUITES. No browser, no server, no ports — they import the real
 * simulation out of src/ and drive it. Safe to run anywhere, in any order.
 */
export const LOGIC = [
  plain('test-edge-gate.mjs'),
  plain('test-water-entry.mjs'),
  plain('test-barrel-flow.mjs'),
  plain('test-kill-streak-powers.mjs'),
  tsx('test-wildlife-meat.mjs'),
  tsx('test-ship-interactions.mjs'),
  tsx('test-swimmer-ship-collision.mjs'),
  tsx('test-keg-placement.mjs'),
  tsx('test-sea-rock-colliders.mjs'),
  tsx('test-sea-rock-ship-damage.mjs'),
  tsx('test-occlusion.mjs'),
  tsx('test-game-balance.mjs'),
  tsx('test-terrain-detail.mjs'),
  tsx('test-island-props.mjs'),
  tsx('test-asset-merge.mjs'),
  tsx('test-ship-dynamics.mjs'),
  tsx('test-server-fixes.mjs'),
  tsx('test-flooding.mjs'),
  tsx('test-locomotion.mjs'),
  tsx('test-world-fixed.mjs'),
  tsx('test-traversal.mjs'),
  tsx('test-revive.mjs'),
  tsx('test-snapshot-size.mjs'),
  tsx('test-combat-fixes.mjs'),
  tsx('test-geyser.mjs'),
  tsx('test-cave-walk.mjs'),
  tsx('test-swim-shore.mjs'),
  tsx('test-harvest.mjs'),
  tsx('test-shark-lunge.mjs'),
  tsx('test-station-spacing.mjs'),
  tsx('test-block.mjs'),
  tsx('test-deck-safety.mjs'),
  tsx('test-stats.mjs'),
  tsx('test-dock-frame.mjs'),
  tsx('test-gangway-walk.mjs'),
  tsx('test-climb-verbs.mjs'),
  tsx('test-prop-colliders.mjs'),
  tsx('test-light-budget.mjs'),
  tsx('test-first-draw-budget.mjs'),
  tsx('test-frame-governor.mjs'),
  tsx('test-island-reveal.mjs'),
  tsx('test-interaction-arbiter.mjs'),
  tsx('test-block-hold.mjs'),
  tsx('test-grounding-cap.mjs'),
  tsx('test-net-resilience.mjs'),
  tsx('test-material-floor.mjs'),
  tsx('test-sea-voids.mjs'),
  tsx('test-bot-peace-window.mjs'),
  tsx('test-oneshot-underload.mjs'),
  tsx('test-gold-cargo.mjs'),
  tsx('test-wreck-event.mjs'),
  tsx('test-reach-vocabulary.mjs'),
  tsx('test-story-delivery.mjs'),
  tsx('test-shanty-grammar.mjs'),
  tsx('test-coast-wobble.mjs'),
  tsx('test-death-causes.mjs'),
  tsx('test-storm-spawn-safety.mjs'),
  tsx('test-storm-outrun.mjs'),
  tsx('test-damage-visibility.mjs'),
  tsx('test-endmatch-board.mjs'),
  tsx('test-landing-stores.mjs'),
  // WIRED HERE FOR THE FIRST TIME. The gates for the remote-motion wave shipped
  // with the wave and were run by nothing: a continuous-path proof and its
  // mutation twin, sitting on disk for a fortnight. test-remote-interpolation
  // drives the buffer directly and needs no stack at all.
  tsx('test-remote-interpolation.mjs'),
  tsx('audit-floating-props.mjs'),
];

/**
 * BROWSER SUITES. Every one wants a page: `PIRATES_BR_URL` for the client and,
 * through the Vite that serves it, a game server on `PIRATES_BR_SERVER_PORT`.
 * `slow` marks the ones that own the machine for minutes — they run last so a
 * cheap failure is reported in the first minute rather than the twentieth.
 */
export const BROWSER = [
  { ...plain('test-gameplay-smoke.mjs') },
  { ...plain('test-lod-reveal.mjs') },
  { ...plain('test-minimap.mjs') },
  { ...plain('test-chart-and-feed.mjs') },
  { ...plain('test-music-render.mjs') },
  { ...tsx('test-onboarding-ux.mjs') },
  { ...plain('test-geometry-lod.mjs') },
  { ...plain('test-shadow-gate.mjs') },
  { ...plain('test-decor-batch.mjs') },
  { ...plain('test-frame-allocation.mjs') },
  { ...plain('test-frame-governor-live.mjs') },
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
];

/**
 * ON DISK, DELIBERATELY NOT IN THE RUN — with the reason, so the audit below
 * can tell "considered and excluded" from "forgotten". Anything else matching
 * `scripts/test-*.mjs` fails `npm run test:audit`.
 */
export const EXCLUDED = {
  'audit-tour.mjs':
    'a screenshot tour with no assertions and no exit code — a probe, not a gate',
  'endgame-live-smoke.mjs':
    'superseded by test-endmatch-board (logic) + fixwave4-smoke; hard-codes :3000 and ignores PIRATES_BR_URL',
  'finalwave-island-smoke.mjs':
    'wave-scoped screenshot smoke; hard-codes :3000, no PIRATES_BR_URL support',
  'finalwave-skysea-smoke.mjs':
    'wave-scoped screenshot smoke; hard-codes :3000, no PIRATES_BR_URL support',
  'finalwave-voyage-smoke.mjs':
    'wave-scoped screenshot smoke; hard-codes :3000, no PIRATES_BR_URL support',
  'killwave-integration-smoke.mjs':
    'wave-scoped; its contract is covered by test-kill-streak-powers and test-death-causes',
};

export const ALL = [
  ...LOGIC.map((s) => ({ ...s, kind: 'logic' })),
  ...BROWSER.map((s) => ({ ...s, kind: 'browser' })),
];
