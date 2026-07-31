// One place that decides which GL backend every headless Chromium in scripts/ gets.
//
// WHY THIS EXISTS. Every probe and browser suite in this repo opened with the same
// hardcoded line — `['--use-gl=angle', '--use-angle=metal', '--enable-gpu', …]`. On a
// developer machine with a discrete GPU that is exactly right, and it stays the
// default here. On the fanless Air this game is actually built on it is a hazard: a
// GPU-backed headless Chromium drives the real Metal stack through WindowServer, and
// a heavy scene under load has twice tripped `userspace_watchdog_timeout` and taken
// the whole desktop with it. Recovering from that costs more than any suite saves.
//
// There was no way to say "run the battery, just not on the GPU" without editing
// eleven files by hand every time, so the choice moves into an environment variable:
//
//   npm run test:browser                          # metal, unchanged
//   PIRATES_GL=swiftshader npm run test:browser    # software ANGLE, no GPU process
//
// SwiftShader renders real pixels — it is a full software rasteriser, so screenshots
// and readPixels are trustworthy — it is simply slow (single digit fps on a scene
// this size). Suites that assert on frame rate should skip or relax under it by
// checking `IS_SOFTWARE_GL` themselves rather than by having their thresholds
// widened, because a widened threshold stays widened on the GPU path too.
//
// The crash-handler switches ride along on BOTH backends on purpose. These rigs run
// while a human is at the keyboard, and a headless Chromium that dies with breakpad
// armed puts a macOS crash dialog on his screen.

/** The backend name in effect: 'metal' (default) or 'swiftshader'. */
export const GL_BACKEND = (process.env.PIRATES_GL ?? 'metal').trim().toLowerCase();

/** True when we are on the software rasteriser — real pixels, but far slower. */
export const IS_SOFTWARE_GL = GL_BACKEND === 'swiftshader' || GL_BACKEND === 'software' || GL_BACKEND === 'swangle';

// A crashed headless Chromium must never interrupt the person at the machine.
const NO_CRASH_UI = ['--disable-breakpad', '--noerrdialogs', '--disable-crash-reporter'];

// Software ANGLE. Deliberately omits --enable-gpu and --ignore-gpu-blocklist: the
// point is that no GPU process does any real work, so asking for one is at best
// noise and at worst the very thing being avoided.
const SOFTWARE_ARGS = ['--use-angle=swiftshader', ...NO_CRASH_UI];

// The historical default, byte for byte what the suites hardcoded.
const METAL_ARGS = ['--use-gl=angle', '--use-angle=metal', '--enable-gpu', ...NO_CRASH_UI];

/**
 * Chromium args for a headless launch.
 *
 * @param {string[]} extra  Non-GL switches the caller needs regardless of backend
 *                          (`--mute-audio`, `--ignore-gpu-blocklist`, …). Anything
 *                          GL-selecting passed here is dropped, because letting a
 *                          caller re-add `--use-angle=metal` by hand would quietly
 *                          defeat the whole switch.
 */
export function browserArgs(extra = []) {
  const base = IS_SOFTWARE_GL ? SOFTWARE_ARGS : METAL_ARGS;
  const kept = extra.filter((a) => !/^--(use-gl|use-angle|enable-gpu|disable-gpu)\b/.test(a))
    // `--ignore-gpu-blocklist` is meaningless without a GPU path and only muddies the
    // command line the failure message prints, so it goes with the backend it serves.
    .filter((a) => !(IS_SOFTWARE_GL && a === '--ignore-gpu-blocklist'));
  return [...base, ...kept.filter((a) => !base.includes(a))];
}

/** For log lines, so a run's output says which backend produced its numbers. */
export function describeGl() {
  return IS_SOFTWARE_GL
    ? 'swiftshader (software ANGLE — real pixels, single-digit fps; timing numbers are advisory)'
    : 'metal (GPU)';
}
