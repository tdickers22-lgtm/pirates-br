# Pirates BR closeout status

Closed on 2026-08-05 from branch `feat/volcanic-geysers-cliffs-flora` at seed
`20260801`. The final browser checks used the isolated client/server on ports
3107/8097, SwiftShader, one browser, and viewports no larger than 960 x 540. The
live development stack on ports 3000/8090 was not used or changed.

## Result

The interrupted polish and verification campaign is recovered, committed, and
pushed. There are no deliberately red tests or known correctness failures left
from its closeout scope.

- Z-fighting: low, balanced, and high each passed all 54 camera/time/dolly
  readings with zero detected patch pixels (162 clean readings total). The
  deliberately broken control produced 1,248 patch pixels, including an
  827-pixel failure, proving the detector still fails when the defect returns.
  Local evidence: `test-results/closeout2/zfight-low/report.json`,
  `test-results/closeout/zfight-balanced/report.json`,
  `test-results/closeout/zfight-high/report.json`, and
  `test-results/closeout2/zfight-mutated/report.json`.
- Floating props: the final full census checked 3,298 placed pieces across all
  islands: 0 floaters, 0 unaccounted elevated pieces, 0 indoor-cover failures,
  and 36 explicitly classified design placements. Local evidence:
  `test-results/live-floaters-fixed/live-floaters.json`.
- Runtime hitches: shader warm-up now targets the same render target used by
  post-processing. The final high-tier census reduced new play-time program
  links from 43 to 6; three are expected shadow-depth variants, one is a scene
  shader, and the two remaining basic variants took about 1 ms. The official
  eight-island tour recorded no new play-time links. No shader errors were
  recorded. Local evidence: `test-results/closeout/programs-high-final.json`.
- Network smoothness: client/server time is stamped at socket-worker receipt,
  so a slow renderer no longer displays a false server-overload warning. The
  adversarial run held real server lag to 0.03 seconds with no dropped ticks;
  freezing the server clock made the control fail as intended.
- Remote motion: the shark gate now grades the buffered pose that is actually
  rendered. The real-network mutation measured 0.150 old/off p99 error versus
  0.007 on (21.8x improvement), with 98.3% real interpolation pairs and 0.6%
  extrapolation. The deterministic control also passed.
- Stability: transient non-finite storm poses are stopped before reaching the
  camera or Web Audio. Motion continuity, load responsiveness, death/feed HUD,
  storm outrun, gameplay smoke, and end-match/scoreboard/quit checks all passed.
- Coverage: all 93 shipped test suites are accounted for: 87 wired into the
  normal runners and 6 explicitly documented exclusions. See
  [TEST_SUITE_INVENTORY.md](./TEST_SUITE_INVENTORY.md).
- Visual review: the complete low-tier approach sequence, the complete prior
  high-tier approach sequence, normal/night deck scenes, storm scenes, and
  fresh high-tier 900/600/380 m frames were rendered and inspected. The fresh
  high-tier batch timed out while asking SwiftShader for its fourth screenshot;
  the first three files are valid and the earlier complete high sequence covers
  the remaining distances. This was a capture timeout, not a game assertion or
  page error.

The verification establishes the automated lifecycle from menu through active
gameplay and the deterministic end-match/scoreboard/quit path. It is not a
claim that a human completed an uninterrupted hour-long subjective playtest;
play feel remains a human judgment, not an unresolved engineering gate.

## Final recovery commits

- `fe9e12bb` — warm shaders against the scene render target
- `d8fcc10d` — keep transient storm poses out of Web Audio
- `dd3e92d5` — stamp server time at the socket worker
- `8e41f51e` — align the shark motion gate with buffered poses

The remote recovery branch is
`origin/feat/volcanic-geysers-cliffs-flora-local`.
