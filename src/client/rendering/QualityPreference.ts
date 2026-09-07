/**
 * WHICH TIER THIS MACHINE GETS, and who decided.
 *
 * The tier used to be one line inside Renderer: core count, device memory, CSS
 * pixels. On the fanless Air this game is built on that line returns **high** —
 * eight cores, sixteen gigabytes, a 1470x956 CSS viewport — and high means the
 * largest shadow map in the game, a 96x48 sky dome, the widest LOD radii and a pixel ratio
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

/**
 * `balanced` is the stable engine/storage key used by old saves, probes and
 * links. To a player it is simply MEDIUM: the middle preset turns shadows and
 * post-processing back on, more than doubles Low's pixel budget, and holds
 * denser island dressing much farther out. Keep the internal key so existing
 * preferences continue to work, but never make the player translate product
 * jargon to find the obvious middle choice.
 */
export function renderQualityLabel(quality: RenderQuality): 'Low' | 'Medium' | 'High' {
  return quality === 'balanced' ? 'Medium'
    : quality === 'low' ? 'Low'
      : 'High';
}

const SETTINGS_KEY = 'piratesBR.settings';

function isQuality(value: unknown): value is RenderQuality {
  return value === 'low' || value === 'balanced' || value === 'high';
}

/** Accept the player-facing name in hand-written URLs/local storage while
 * preserving `balanced` as the canonical internal key. */
export function parseRenderQuality(value: unknown): RenderQuality | null {
  if (value === 'medium') return 'balanced';
  return isQuality(value) ? value : null;
}

/** The stored preference, or 'auto' when nothing has been chosen (or storage is
 *  unavailable — private windows throw on read, and a thrown tier is worse than
 *  a detected one). */
export function loadQualityPreference(): QualityPreference {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return 'auto';
    const parsed = JSON.parse(raw) as { quality?: unknown };
    return parseRenderQuality(parsed.quality) ?? 'auto';
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

/** One step UP the tier ladder, or null at the top. */
export function tierAbove(quality: RenderQuality): RenderQuality | null {
  const index = TIER_ORDER.indexOf(quality);
  return index >= 0 && index < TIER_ORDER.length - 1 ? TIER_ORDER[index + 1] : null;
}

/**
 * A FINGERPRINT of the machine a measurement was taken on.
 *
 * A ceiling or a proof is a statement about one GPU driving one panel. Plug the
 * laptop into a 4K monitor, or open the same profile on another machine through
 * a synced localStorage, and the old verdict is about a machine that is not
 * here. The renderer string plus the screen size is the cheapest pair that
 * changes when either of those does.
 */
export function machineSignature(rendererString: string | null): string {
  const screen = typeof window !== 'undefined' && window.screen ? window.screen : null;
  const w = screen?.width ?? 0;
  const h = screen?.height ?? 0;
  return `${rendererString ?? 'masked'}|${w}x${h}`;
}

/**
 * A PROMOTION the machine earned by holding its tier with headroom to spare.
 *
 * The audition ceiling was one-way (perf-04): a six-thread gaming desktop with
 * an RTX 3060 was handed 'balanced' and had no path back, and after this lane's
 * rule table every machine the detector cannot identify opens on 'low' — which
 * would be a trap without a way up. So the renderer also writes a PROOF: a full
 * minute of unsuspended play at scalar 1.0 in 'target' mode with the median
 * frame under half the budget is a machine that is plainly not being asked for
 * enough, and the tier above is offered on the NEXT launch (never mid-session:
 * the tier decides the shadow map, the sky dome and every island's material
 * set).
 *
 * A proof is only ever applied over a reason that was a GUESS. `mobile`,
 * `integrated-gpu` and `air-class-gpu` are facts about the part, and a fanless
 * Air holding 60 fps in a menu is not evidence that it can hold a 1536² shadow
 * map in a storm.
 */
export function loadAutoTierProof(rendererString: string | null): RenderQuality | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { autoQualityProof?: { tier?: unknown; sig?: unknown } };
    const proof = parsed.autoQualityProof;
    if (!proof || proof.sig !== machineSignature(rendererString)) return null;
    return parseRenderQuality(proof.tier);
  } catch {
    return null;
  }
}

export function saveAutoTierProof(quality: RenderQuality | null, rendererString: string | null): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const record = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (quality === null) delete record.autoQualityProof;
    else record.autoQualityProof = { tier: quality, sig: machineSignature(rendererString) };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(record));
  } catch {
    /* private mode */
  }
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
    return parseRenderQuality(parsed.autoQuality);
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


// ─────────────────────────────────────────────────────────────────────────────
// THE RULE TABLE — what the GPU's own name says about its fill rate
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The detector used to guess from CPU facts about a GPU problem, and it was
 * wrong on three of four device classes (PERF-01: perf-01/02/03): Safari on an
 * Apple-silicon Air reports the opaque `Apple GPU`, so the Air rule missed and
 * the Air opened on `balanced` with a 1536² shadow map, bloom and FXAA; every
 * phone landed on `balanced` too (no touch signal, and iOS never exposes
 * `deviceMemory`, so `memoryStrong` defaulted true); a 2018 Intel UHD 620
 * ultrabook landed on `balanced` because eight threads read as headroom.
 *
 * So the string is classified FIRST, by a table rather than by two ad-hoc
 * regexes, and the table is exported so the settings panel can print the rule
 * that matched instead of a bare tier.
 *
 * The classes, and why each is its own class rather than a boolean:
 * - `mobile-gpu`   Adreno / Mali / PowerVR / Xclipse: a phone or tablet part.
 * - `integrated`   Intel HD/UHD/Iris and AMD APU graphics: shares memory
 *                  bandwidth with the CPU and has roughly a third of an M2's
 *                  fill rate. Never a `balanced` machine by default.
 * - `apple-base`   `Apple M2` and friends WITHOUT a Pro/Max/Ultra suffix: the
 *                  fanless-to-nearly class (see `isAirClassGpu`).
 * - `apple-pro`    `Apple M2 Pro/Max/Ultra`: real headroom.
 * - `apple-opaque` Safari's `Apple GPU`. Could be an Air or an Ultra and the
 *                  string cannot tell you (perf-v-04) — treated as UNKNOWN, not
 *                  as a base chip, and settled by the fill benchmark.
 * - `software`     SwiftShader / llvmpipe: a headless rasteriser.
 * - `discrete`     GeForce/RTX/Quadro/Radeon RX/Arc: the only class that may
 *                  reach `high` from the string alone.
 */
export type GpuClass = 'mobile-gpu' | 'integrated' | 'apple-base' | 'apple-pro' | 'apple-opaque' | 'software' | 'discrete' | 'unknown';

export interface RendererRule {
  /** Printed in the settings panel and in probe output. */
  readonly name: string;
  readonly test: RegExp;
  readonly gpuClass: GpuClass;
}

/** Ordered: the FIRST rule whose regex matches wins, so the narrow strings
 *  (Pro/Max/Ultra, Iris Xe MAX) are tested before the broad ones. */
export const RENDERER_RULES: readonly RendererRule[] = [
  { name: 'software rasteriser', test: /swiftshader|llvmpipe|software\s*rasteriz|generic\s+renderer|basic\s+render/i, gpuClass: 'software' },
  { name: 'Apple M-series Pro/Max/Ultra', test: /\bapple\s+m\d+\s+(pro|max|ultra)\b/i, gpuClass: 'apple-pro' },
  { name: 'Apple M-series base chip', test: /\bapple\s+m\d+\b/i, gpuClass: 'apple-base' },
  { name: 'Apple GPU (opaque, Safari)', test: /\bapple\s+gpu\b/i, gpuClass: 'apple-opaque' },
  { name: 'Qualcomm Adreno / ARM Mali / PowerVR / Xclipse', test: /\b(adreno|mali|powervr|xclipse|videocore)\b/i, gpuClass: 'mobile-gpu' },
  // Iris Xe MAX (DG1) is a discrete part that happens to carry the Iris name.
  { name: 'Intel Xe MAX / Arc', test: /\b(iris\s+xe\s+max|intel\s*\(?r?\)?\s*arc)\b/i, gpuClass: 'discrete' },
  { name: 'Intel integrated graphics', test: /intel.*\b(hd|uhd|iris|gma)\b/i, gpuClass: 'integrated' },
  { name: 'AMD APU graphics', test: /\b(vega\s*\d|radeon\s+graphics|radeon\s+hd\s+[678]\d{3}g)\b/i, gpuClass: 'integrated' },
  { name: 'discrete NVIDIA / AMD', test: /\b(geforce|rtx|gtx|quadro|tesla|radeon\s+(rx|pro)\b)/i, gpuClass: 'discrete' },
];

/** The rule that matched, or null when the string is absent or unrecognised. */
export function matchRendererRule(rendererString: string | null): RendererRule | null {
  if (!rendererString) return null;
  for (const rule of RENDERER_RULES) if (rule.test.test(rendererString)) return rule;
  return null;
}

export function classifyRenderer(rendererString: string | null): GpuClass {
  return matchRendererRule(rendererString)?.gpuClass ?? 'unknown';
}

/**
 * True for an Apple BASE-chip machine — the fanless-or-nearly class.
 *
 * `Apple M2` is a base chip; `Apple M2 Pro`, `Apple M2 Max` and `Apple M2 Ultra`
 * are not, and the whole value of the string is that it separates them where a
 * core count cannot. The core ceiling is the second half of the test: a base
 * chip with more than ten cores is not a part Apple ships in an Air.
 *
 * Deliberately does NOT accept Safari's opaque `Apple GPU`: that string is an
 * Ultra as often as it is an Air, and answering "Air" to it would under-tier a
 * Mac Studio permanently (perf-v-04). `apple-opaque` gets the unknown path.
 *
 * Exported so the settings panel can say WHY it defaulted the way it did.
 */
export function isAirClassGpu(rendererString: string | null, cores: number): boolean {
  return classifyRenderer(rendererString) === 'apple-base' && cores <= 10;
}

/**
 * A phone or a tablet, by any signal that is actually present.
 *
 * There was no mobile branch at all (perf-02), so an iPhone (6 cores, no
 * `deviceMemory`, `Apple GPU`) and an 8 GB Android both fell through every
 * `low` branch into `balanced`: a 1536² PCF-soft shadow map, UnrealBloom and
 * FXAA on a part that cannot pay for any of them. Worse, the two rungs that
 * would have helped most are the two the runtime governor is forbidden to pull
 * (switching shadows or post off re-links every program), so nothing recovered.
 *
 * Three independent signals, because every one of them is missing somewhere:
 * a mobile GPU name; coarse-pointer touch; a mobile user-agent. iPadOS reports
 * a desktop UA and `Apple GPU`, and is caught by touch points.
 */
export function isMobileClient(rendererString: string | null, nav: Navigator): boolean {
  if (classifyRenderer(rendererString) === 'mobile-gpu') return true;
  const ua = typeof nav.userAgent === 'string' ? nav.userAgent : '';
  if (/android|iphone|ipad|ipod|\bmobile\b|silk|kindle/i.test(ua)) return true;
  const touchPoints = typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : 0;
  if (touchPoints > 1) {
    const coarse = typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : true;
    if (coarse) return true;
  }
  return false;
}

/**
 * The fallback for when the GPU's name is MASKED: a HiDPI panel driven by a
 * modest core count.
 *
 * Only two kinds of machine pair a devicePixelRatio of 2 or more with eight
 * cores or fewer: a thin laptop, and a small desktop on a HiDPI monitor. Both
 * are asked, by a ratio of 2, for four times the fragments of 1.0 — and neither
 * is the workstation the old core-count rule mistook them for.
 *
 * Deliberately NOT applied when the renderer string is present and recognised:
 * a named part has already answered this question better. An UNRECOGNISED
 * string is no better than a masked one, so it does not disable the rule.
 */
export function isLikelyThinLaptop(rendererString: string | null, cores: number): boolean {
  if (classifyRenderer(rendererString) !== 'unknown') return false;
  if (cores > 8) return false;
  return (window.devicePixelRatio || 1) >= 1.9;
}

export type QualityReason =
  /** 'player' when they chose it, 'url' for ?quality=, otherwise the signal that
   *  decided — surfaced in the settings panel and in probe output. */
  | 'player' | 'url'
  | 'mobile' | 'integrated-gpu' | 'air-class-gpu' | 'thin-laptop' | 'software-gpu'
  | 'few-cores' | 'low-memory' | 'huge-viewport' | 'unknown-default'
  | 'bench' | 'audition' | 'promoted' | 'default';

export type QualityVerdict = {
  quality: RenderQuality;
  reason: QualityReason;
  rendererString: string | null;
  /** The rule that classified the GPU, for the settings panel. */
  rule?: string;
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
  const requested = parseRenderQuality(param);
  if (requested) return { quality: requested, reason: 'url', rendererString: null };

  const stored = loadQualityPreference();
  if (stored !== 'auto') return { quality: stored, reason: 'player', rendererString: readGpuRendererString() };

  return detectRenderQuality();
}

/**
 * The HEURISTICS alone — no URL parameter, no stored preference.
 *
 * Split out because a probe cannot otherwise ask what the detector thinks. Every
 * measurement session passes `?quality=` on purpose (a budget graded at whatever
 * tier the runner's machine happens to earn is not a budget), and that param
 * wins first in `decideRenderQuality` — so a census asking it "what tier would
 * this machine get" was answered `url`, every time, and reported the pin back to
 * itself as a detection. This is the reading it wanted.
 *
 * LOW IS THE UNKNOWN DEFAULT (perf-20 phase 3). The old fallthrough was
 * `balanced`, which meant every machine the detector could not identify — a
 * masked string, a privacy extension, a browser this table has never seen — was
 * handed shadows, bloom and FXAA on the strength of nothing at all. The cost of
 * being wrong downward is one tier that the in-session governor gives back as
 * scalar and the cross-session promotion proof gives back as a tier; the cost of
 * being wrong upward is a session of stutter and, on this repo's own history, a
 * `userspace_watchdog_timeout`.
 */
/** Reasons a cross-session promotion proof is allowed to overrule: every one of
 *  them is an inference from missing information, not a fact about the GPU. */
const PROMOTABLE_REASONS: ReadonlySet<QualityReason> = new Set<QualityReason>([
  'default', 'few-cores', 'huge-viewport', 'unknown-default', 'thin-laptop',
]);

export function detectRenderQuality(): QualityVerdict {
  const rendererString = readGpuRendererString();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory;
  const memoryLimited = typeof memory === 'number' && memory <= 4;
  const memoryStrong = typeof memory === 'number' && memory >= 8;
  // Judge on CSS pixels: the adaptive pixel-ratio scaler owns the output
  // resolution, so a HiDPI panel must not by itself veto a tier.
  const cssPixels = window.innerWidth * window.innerHeight;
  const rule = matchRendererRule(rendererString);
  const gpuClass = rule?.gpuClass ?? 'unknown';
  const named = (quality: RenderQuality, reason: QualityReason): QualityVerdict =>
    ({ quality, reason, rendererString, rule: rule?.name });

  let verdict: QualityVerdict;
  // The GPU's class first: it is a fact about the part that will render the
  // frame, and every rule below it is an inference about the machine around it.
  if (isMobileClient(rendererString, nav)) {
    verdict = named('low', 'mobile');
  } else if (gpuClass === 'integrated') {
    verdict = named('low', 'integrated-gpu');
  } else if (gpuClass === 'software') {
    verdict = named('low', 'software-gpu');
  } else if (isAirClassGpu(rendererString, cores)) {
    verdict = named('low', 'air-class-gpu');
  } else if (cores <= 4) {
    verdict = named('low', 'few-cores');
  } else if (memoryLimited) {
    verdict = named('low', 'low-memory');
  } else if (isLikelyThinLaptop(rendererString, cores)) {
    // Firefox masks WEBGL_debug_renderer_info by default and privacy extensions
    // mask it everywhere; without the string an eight-core Air fell through to
    // 'balanced' and only reached 'low' after a session of auditioning itself.
    verdict = named('low', 'thin-laptop');
  } else if (cssPixels > 3_400_000 && cores <= 6) {
    verdict = named('low', 'huge-viewport');
  } else if (gpuClass === 'discrete' || gpuClass === 'apple-pro') {
    // 'high' needs headroom the eight-core class does not demonstrate. Twelve is
    // the first count that is not an Air, a base Mini or a two-port Pro.
    verdict = cores >= 12 && cssPixels <= 2_600_000
      ? named('high', 'default')
      : named('balanced', 'default');
  } else if (gpuClass === 'apple-opaque') {
    // Safari on Apple silicon: the string, the core count (WebKit clamps it)
    // and deviceMemory (never exposed) are ALL opaque at once, so there is no
    // input that separates an M2 Air from an M2 Ultra (perf-v-04). Only the
    // fill benchmark can, and until it has run this opens safe.
    verdict = named('low', 'unknown-default');
  } else {
    verdict = named('low', 'unknown-default');
  }
  // memoryStrong is only ever allowed to hold a tier back, never to grant one:
  // an unreported deviceMemory used to read as "strong" and was the reason iOS
  // reached 'balanced'.
  if (verdict.quality === 'high' && typeof memory === 'number' && !memoryStrong) {
    verdict = named('balanced', 'low-memory');
  }

  // A previous session that held this tier with a minute of headroom to spare
  // has earned the one above it — but only over a reason that was a GUESS.
  const proof = PROMOTABLE_REASONS.has(verdict.reason) ? loadAutoTierProof(rendererString) : null;
  if (proof && TIER_ORDER.indexOf(proof) > TIER_ORDER.indexOf(verdict.quality)) {
    verdict = { quality: proof, reason: 'promoted', rendererString, rule: rule?.name };
  }

  // …and clamp to whatever a previous session's audition proved this machine
  // could not hold. Only ever downward.
  const ceiling = loadAutoTierCeiling();
  if (ceiling && TIER_ORDER.indexOf(ceiling) < TIER_ORDER.indexOf(verdict.quality)) {
    return { quality: ceiling, reason: 'audition', rendererString, rule: rule?.name };
  }
  return verdict;
}
