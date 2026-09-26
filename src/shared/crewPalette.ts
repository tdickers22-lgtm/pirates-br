/**
 * CREW PALETTE (b3.5d; crossdevice-15, vm:mechanicshud:5, D33).
 *
 * The hull, sail and flag dye of every crew in a match, chosen so no two crews
 * that share a match can be confused by a colour-blind player. The bar is
 * CIEDE2000 >= CREW_MIN_DELTA_E between EVERY pair of colours a match can hold
 * (MODES max crews = 12, Solo), measured after simulating full-severity
 * deuteranopia, protanopia and tritanopia (Machado, Oliveira & Fernandes 2009
 * matrices applied in linear sRGB) and under normal vision.
 *
 * The old sixteen "weathered banner dyes" collapsed to 1.2 dE (0x5E8E3E vs
 * 0x7E8E3E under deuteranopia) and put a red next to three greens.
 *
 * Read by the server (Match picks each new hull's dye with pickCrewColor, a
 * greedy "farthest from every dye already afloat" choice, so a late join or a
 * rejoin after a founder still gets the most distinct free dye) and by the
 * client (the colour-blind HUD mode in src/client/ui/hudModel.ts). Pure maths,
 * no Math.random: the pick is a deterministic function of the dyes in use.
 */

export type VisionMode = 'normal' | 'deut' | 'prot' | 'trit';
export const CVD_MODES: readonly VisionMode[] = ['deut', 'prot', 'trit'];
export const VISION_MODES: readonly VisionMode[] = ['normal', 'deut', 'prot', 'trit'];

/** The acceptance bar (PLAN D33 / section 4 b3.5d). */
export const CREW_MIN_DELTA_E = 20;

/** Machado et al. 2009, severity 1.0, row-major, linear RGB -> linear RGB. */
const CVD_MATRIX: Record<Exclude<VisionMode, 'normal'>, readonly number[]> = {
  deut: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  prot: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.109216, -0.003882, -0.048116, 1.051998],
  trit: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};

const srgbToLinear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** Linear RGB of `hex` as seen under `mode` (clamped to the display gamut). */
export function simulateVision(hex: number, mode: VisionMode): [number, number, number] {
  const r = srgbToLinear((hex >> 16) & 0xff), g = srgbToLinear((hex >> 8) & 0xff), b = srgbToLinear(hex & 0xff);
  if (mode === 'normal') return [r, g, b];
  const m = CVD_MATRIX[mode];
  const cl = (x: number) => Math.min(1, Math.max(0, x));
  return [cl(m[0] * r + m[1] * g + m[2] * b), cl(m[3] * r + m[4] * g + m[5] * b), cl(m[6] * r + m[7] * g + m[8] * b)];
}

/** CIELAB (D65) of a linear-RGB triple. */
export function linearToLab([r, g, b]: readonly number[]): [number, number, number] {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 (Sharma, Wu & Dalal 2005), kL = kC = kH = 1. */
export function deltaE2000(lab1: readonly number[], lab2: readonly number[]): number {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb7 = ((C1 + C2) / 2) ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const t = Math.atan2(b, a) / rad;
    return t < 0 ? t + 360 : t;
  };
  const h1p = hue(a1p, b1), h2p = hue(a2p, b2);
  const dL = L2 - L1, dC = C2p - C1p;
  let dh = 0;
  if (C1p * C2p !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hb = h1p + h2p;
  if (C1p * C2p !== 0) {
    hb = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + (h1p + h2p < 360 ? 360 : -360)) / 2 : (h1p + h2p) / 2;
  }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad)
    + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.20 * Math.cos((4 * hb - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const Cbp7 = Cbp ** 7;
  const RC = 2 * Math.sqrt(Cbp7 / (Cbp7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTheta * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/** dE2000 between two dyes as a viewer with `mode` sees them. */
export function visionDeltaE(a: number, b: number, mode: VisionMode): number {
  return deltaE2000(linearToLab(simulateVision(a, mode)), linearToLab(simulateVision(b, mode)));
}

/** The WORST dE2000 over normal vision and the three simulated dichromacies. */
export function worstDeltaE(a: number, b: number, modes: readonly VisionMode[] = VISION_MODES): number {
  let worst = Infinity;
  for (const mode of modes) worst = Math.min(worst, visionDeltaE(a, b, mode));
  return worst;
}

/**
 * The twelve dyes (MODES max crews = 12). Every pair clears CREW_MIN_DELTA_E
 * under deut/prot/trit AND normal vision (scripts/test-crew-palette.mjs grades
 * all 66 pairs x 4 modes; measured minimum 20.67, normal 22.0, deut 20.7,
 * prot 20.7, trit 20.7). Twelve dyes that far apart under three dichromacies
 * fill the whole sRGB gamut, so the set runs from tar black and bone white
 * to brimstone yellow; the hull and sail textures weather them into wood and
 * canvas. Found by a farthest-point search over a 15-step sRGB grid plus
 * integer hill-climbing (b3.5d report). Ordered as pickCrewColor deals them
 * from an empty match: the first N are what N crews joining at t0 get.
 */
export const CREW_PALETTE: readonly number[] = [
  0x8E2300, // rust red
  0xEDFFF9, // bone white
  0x0008BA, // royal blue
  0x818590, // pewter
  0x00002D, // tar black
  0x514A52, // slate
  0x2F0000, // oxblood
  0xFDF300, // brimstone yellow
  0xD16606, // tangerine
  0xFAA8FF, // orchid
  0x52C491, // sea green
  0xAA58EC, // amethyst
];

/**
 * Greedy assignment: the free palette dye whose smallest worst-mode dE2000 to
 * every dye already afloat is LARGEST (ties -> palette order). With nothing in
 * use it is CREW_PALETTE[0]. When every dye is taken (never with 12 crews max)
 * it falls back to the dye farthest from the ones in use, repeats allowed.
 */
export function pickCrewColor(inUse: readonly number[]): number {
  const used = new Set(inUse);
  const pool = CREW_PALETTE.filter((c) => !used.has(c));
  const candidates = pool.length > 0 ? pool : CREW_PALETTE;
  let best = candidates[0], bestScore = -Infinity;
  for (const c of candidates) {
    let score = Infinity;
    for (const u of used) score = Math.min(score, worstDeltaE(c, u));
    if (score > bestScore + 1e-9) { bestScore = score; best = c; }
  }
  return best;
}

/** Smallest worst-mode dE2000 over every pair of `colors` (Infinity for < 2). */
export function minPairDeltaE(colors: readonly number[], modes: readonly VisionMode[] = VISION_MODES): number {
  let min = Infinity;
  for (let i = 0; i < colors.length; i++) {
    for (let j = i + 1; j < colors.length; j++) min = Math.min(min, worstDeltaE(colors[i], colors[j], modes));
  }
  return min;
}
