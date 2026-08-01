/**
 * WHICH TIER THIS MACHINE GETS, and who decided.
 *
 * The tier used to be one line inside Renderer: core count, device memory, CSS
 * pixels. On the fanless Air this game is built on that line returns **high** —
 * eight cores, sixteen gigabytes, a 1470x956 CSS viewport — and high means a
 * 4096 shadow map, a 96x48 sky dome, the widest LOD radii and a pixel ratio
 * allowed to climb to 1.75 on a dPR-2 panel, which is three times the fragments
 * of 1.0. The machine then spends the session losing that argument through the
 * distress ladder, and macOS's own compositor loses it with them: the crash in
 * this repo's history is `userspace_watchdog_timeout`, WindowServer starved of
 * the GPU by a tab that was told it was a workstation.
 *
 * Core count cannot tell those apart, because it is the same number. What CAN
 * is the GPU's own name. Apple's base chips report as `Apple M2`; the parts with
 * headroom report `Apple M2 Pro` / `Max` / `Ultra`. A base chip with ten cores
 * or fewer is an Air, a base Mini or a two-port Pro — the fanless-to-nearly
 * class — and it should open on **low** and be given quality back by the runtime
 * ladder if it turns out to have the headroom, rather than opening at the
 * ceiling and being walked down from it while the desktop stutters.
 *
 * The verdict is a DEFAULT, never a verdict the player cannot overturn: the
 * settings panel writes an explicit tier here and this module hands it back
 * ahead of any detection. It shares the one `piratesBR.settings` record the menu
 * already persists so there is a single place a preference lives.
 */

export type RenderQuality = 'low' | 'balanced' | 'high';
/** What the PLAYER asked for. 'auto' means "you decide" — the default. */
export type QualityPreference = 'auto' | RenderQuality;

const SETTINGS_KEY = 'piratesBR.settings';

function isQuality(value: unknown): value is RenderQuality {
  return value === 'low' || value === 'balanced' || value === 'high';
}

/** The stored preference, or 'auto' when nothing has been chosen (or storage is
 *  unavailable — private windows throw on read, and a thrown tier is worse than
 *  a detected one). */
export function loadQualityPreference(): QualityPreference {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return 'auto';
    const parsed = JSON.parse(raw) as { quality?: unknown };
    return isQuality(parsed.quality) ? parsed.quality : 'auto';
  } catch {
    return 'auto';
  }
}

/** Write the player's choice into the shared settings record, leaving every
 *  other field (volume, mute, sensitivity) exactly as it was. */
export function saveQualityPreference(preference: QualityPreference): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const record = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (preference === 'auto') delete record.quality;
    else record.quality = preference;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(record));
  } catch {
    /* private mode: the choice lasts this session, which is better than a throw */
  }
}

const TIER_ORDER: RenderQuality[] = ['low', 'balanced', 'high'];

/** One step down the tier ladder, or null at the bottom. */
export function tierBelow(quality: RenderQuality): RenderQuality | null {
  const index = TIER_ORDER.indexOf(quality);
  return index > 0 ? TIER_ORDER[index - 1] : null;
}

/**
 * A CEILING the machine earned by failing to hold a tier, remembered for next
 * launch.
 *
 * The GPU-name signal is the good one, and it is not always there: a browser
 * masking WEBGL_debug_renderer_info leaves the auto path with nothing but a core
 * count, which is exactly the number that cannot tell an Air from a desktop. So
 * the client also AUDITIONS itself on real frames — see Renderer.updatePerformance
 * — and a machine that plainly could not hold its tier writes the tier below it
 * here. This never overrides an explicit choice, and it never raises anything;
 * it is a floor the detector is clamped to, and choosing a tier in settings
 * clears it.
 */
export function loadAutoTierCeiling(): RenderQuality | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { autoQuality?: unknown };
    return isQuality(parsed.autoQuality) ? parsed.autoQuality : null;
  } catch {
    return null;
  }
}

export function saveAutoTierCeiling(quality: RenderQuality | null): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const record = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (quality === null) delete record.autoQuality;
    else record.autoQuality = quality;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(record));
  } catch {
    /* private mode */
  }
}

/** The GPU's own name, via WEBGL_debug_renderer_info, or null when the context
 *  or the extension is unavailable (masked by the browser, or headless). One
 *  throwaway canvas, read once and cached — this runs before the real renderer
 *  exists and must never be the reason a client fails to start. */
let cachedRendererString: string | null | undefined;
export function readGpuRendererString(): string | null {
  if (cachedRendererString !== undefined) return cachedRendererString;
  cachedRendererString = null;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) cachedRendererString = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext();
    }
  } catch {
    cachedRendererString = null;
  }
  return cachedRendererString;
}

/**
 * True for an Apple BASE-chip machine — the fanless-or-nearly class.
 *
 * `Apple M2` is a base chip; `Apple M2 Pro`, `Apple M2 Max` and `Apple M2 Ultra`
 * are not, and the whole value of the string is that it separates them where a
 * core count cannot. The core ceiling is the second half of the test: a base
 * chip with more than ten cores is not a part Apple ships in an Air.
 *
 * Exported so the settings panel can say WHY it defaulted the way it did.
 */
export function isAirClassGpu(rendererString: string | null, cores: number): boolean {
  if (!rendererString) return false;
  if (/\bapple\s+m\d+\s+(pro|max|ultra)\b/i.test(rendererString)) return false;
  if (!/\bapple\s+m\d+\b/i.test(rendererString)) return false;
  return cores <= 10;
}

export type QualityVerdict = {
  quality: RenderQuality;
  /** 'player' when they chose it, 'url' for ?quality=, otherwise the signal that
   *  decided — surfaced in the settings panel and in probe output. */
  reason: 'player' | 'url' | 'air-class-gpu' | 'few-cores' | 'low-memory' | 'huge-viewport' | 'audition' | 'default';
  rendererString: string | null;
};

/**
 * The startup tier, and the signal that chose it.
 *
 * Order is deliberate: an explicit request always wins, because a rig measuring
 * a specific tier and a player who has decided are both saying something no
 * heuristic should be allowed to overrule.
 */
export function decideRenderQuality(): QualityVerdict {
  const param = new URLSearchParams(window.location.search).get('quality');
  if (isQuality(param)) return { quality: param, reason: 'url', rendererString: null };

  const stored = loadQualityPreference();
  const rendererString = readGpuRendererString();
  if (stored !== 'auto') return { quality: stored, reason: 'player', rendererString };

  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory;
  const memoryLimited = typeof memory === 'number' && memory <= 4;
  const memoryStrong = typeof memory === 'number' ? memory >= 8 : true;
  // Judge on CSS pixels: the adaptive pixel-ratio scaler owns the output
  // resolution, so a HiDPI panel must not by itself veto a tier.
  const cssPixels = window.innerWidth * window.innerHeight;

  // The signal core count cannot give. A fanless Air reports the same eight
  // cores and sixteen gigabytes as a desktop that would run this at the ceiling.
  let verdict: QualityVerdict;
  if (isAirClassGpu(rendererString, cores)) {
    verdict = { quality: 'low', reason: 'air-class-gpu', rendererString };
  } else if (cores <= 4) {
    verdict = { quality: 'low', reason: 'few-cores', rendererString };
  } else if (memoryLimited) {
    verdict = { quality: 'low', reason: 'low-memory', rendererString };
  } else if (cssPixels > 3_400_000 && cores <= 6) {
    verdict = { quality: 'low', reason: 'huge-viewport', rendererString };
  } else if (cores >= 12 && memoryStrong && cssPixels <= 2_600_000) {
    // 'high' now needs headroom the eight-core class does not demonstrate.
    // Twelve is the first count that is not an Air, a base Mini or a two-port
    // Pro — the machines this game kept telling it was a workstation.
    verdict = { quality: 'high', reason: 'default', rendererString };
  } else {
    verdict = { quality: 'balanced', reason: 'default', rendererString };
  }

  // …and clamp to whatever a previous session's audition proved this machine
  // could not hold. Only ever downward.
  const ceiling = loadAutoTierCeiling();
  if (ceiling && TIER_ORDER.indexOf(ceiling) < TIER_ORDER.indexOf(verdict.quality)) {
    return { quality: ceiling, reason: 'audition', rendererString };
  }
  return verdict;
}
