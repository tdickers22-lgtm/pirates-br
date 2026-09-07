// COHERENCE METRICS — "is this a place, or is it a pattern?"
//
// The north star for this game is one consistent stylised look with NO lattice,
// moiré or plaid on terrain or water. Every gate that claimed to grade that
// graded `png.length > 20000` instead, which passes any picture at all, so the
// hex knit on the grass and the rhombus grid on the open sea sat in the suite's
// own verification shots for a whole pass without turning anything red.
//
// TWO NUMBERS, because the two defects are not the same shape.
//
// 1. SPECTRAL PEAK — for a repeating LATTICE (value-noise cells, a tiling
//    texture). Take a 64² patch, remove the mean, Hann-window it, 2D FFT, then
//    RADIALLY WHITEN: divide each bin's power by the mean power of every bin at
//    the same radius. Natural imagery has a smooth 1/f^a spectrum, so after
//    whitening it is flat noise and the largest bins sit around 8-12 (the
//    expected maximum of ~2,400 exponential draws). A lattice puts its energy in
//    a few DISCRETE bins and those bins stand 2-4x above their own ring. The
//    score is the mean of the top four whitened bins, so one hot pixel cannot
//    carry it and a genuine spike (which always has neighbours, being windowed)
//    still reads.
//
// 2. STRUCTURE CONTRAST — for the open sea seen from ALTITUDE, where the defect
//    is not a crisp lattice but a perspective-warped interference grid whose
//    pitch changes across the patch, so it has no single spectral line to find.
//    What it does have is CONTRAST: dark rhombi against lifted flanks. RMS of
//    the mean-removed patch over its mean luma says how strongly patterned that
//    water is, and the fix for it (fade the height tint toward its mean once the
//    eye is high and the water is far, where only the longest — and therefore
//    the most periodic — swell components survive) is exactly what lowers it.
//
// Patches are sampled on a grid and the MEDIAN is graded, so one hull, one bush
// or one strip of sky cannot decide the verdict; patches with no detail at all
// (sky, black night water) are DROPPED rather than scored, because a flat patch
// has nothing to be periodic about and would otherwise be a free pass.
import { readPng } from './png-read.mjs';

const N = 64;
// Bins finer than ~3 px are the RASTERISER, not the world: the frame governor
// drops the render scale under a software GL and the upscale leaves a comb of
// near-Nyquist lines that reads as a lattice on every surface, water included.
// Captures pin the render scale to 1 for exactly this reason; the cap is the
// belt to that pair of braces.
const MAX_RING = 20;
const HANN = new Float64Array(N);
for (let i = 0; i < N; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

/** In-place radix-2 FFT of length N. */
function fft(re, im) {
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const a = ang * k, wr = Math.cos(a), wi = Math.sin(a);
        const p = i + k, q = i + k + len / 2;
        const ur = re[p], ui = im[p];
        const vr = re[q] * wr - im[q] * wi, vi = re[q] * wi + im[q] * wr;
        re[p] = ur + vr; im[p] = ui + vi; re[q] = ur - vr; im[q] = ui - vi;
      }
    }
  }
}

/** Spectral peak + structure contrast for one 64² patch. */
function scorePatch(img, x0, y0) {
  const { width, channels, data } = img;
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  let mean = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = ((y0 + y) * width + (x0 + x)) * channels;
      const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      re[y * N + x] = v; mean += v;
    }
  }
  mean /= N * N;
  let varr = 0;
  for (let i = 0; i < N * N; i++) { re[i] -= mean; varr += re[i] * re[i]; }
  varr /= N * N;
  const rms = Math.sqrt(varr);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) re[y * N + x] *= HANN[y] * HANN[x];
  const rr = new Float64Array(N), ii = new Float64Array(N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) { rr[x] = re[y * N + x]; ii[x] = im[y * N + x]; }
    fft(rr, ii);
    for (let x = 0; x < N; x++) { re[y * N + x] = rr[x]; im[y * N + x] = ii[x]; }
  }
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < N; y++) { rr[y] = re[y * N + x]; ii[y] = im[y * N + x]; }
    fft(rr, ii);
    for (let y = 0; y < N; y++) { re[y * N + x] = rr[y]; im[y * N + x] = ii[y]; }
  }
  const ringSum = new Float64Array(40), ringCnt = new Float64Array(40), bins = [];
  for (let ky = 0; ky < N; ky++) {
    for (let kx = 0; kx < N; kx++) {
      const fy = ky > N / 2 ? ky - N : ky, fx = kx > N / 2 ? kx - N : kx;
      const ri = Math.round(Math.hypot(fx, fy));
      if (ri < 2 || ri > MAX_RING) continue;
      const pw = re[ky * N + kx] ** 2 + im[ky * N + kx] ** 2;
      ringSum[ri] += pw; ringCnt[ri]++; bins.push([ri, pw, fx, fy]);
    }
  }
  const whitened = [];
  let pf = null, top1 = 0;
  for (const [ri, pw, fx, fy] of bins) {
    const m = ringSum[ri] / ringCnt[ri];
    if (m <= 0) continue;
    const w = pw / m;
    whitened.push(w);
    if (w > top1) { top1 = w; pf = [fx, fy]; }
  }
  whitened.sort((a, b) => b - a);
  const peak = whitened.slice(0, 4).reduce((a, b) => a + b, 0) / 4;
  return { peak: Number(peak.toFixed(1)), contrast: Number((rms / Math.max(1, mean)).toFixed(3)), rms: Number(rms.toFixed(2)), lattice: pf };
}

const median = (a) => (a.length ? a[Math.floor(a.length / 2)] : null);

/**
 * Grade a region of a screenshot.
 * @param {Buffer} png                        screenshot bytes
 * @param {{x:number[],y:number[]}} grid      patch origins (64² each)
 * @returns {{peak:{median:number|null,max:number|null}, contrast:{median:number|null,max:number|null}, used:number, patches:object[], worst:object|null}}
 */
export function surfaceScore(png, grid, { minRms = 1.2 } = {}) {
  const img = readPng(png);
  const patches = [];
  for (const y0 of grid.y) {
    for (const x0 of grid.x) {
      if (x0 + N > img.width || y0 + N > img.height) continue;
      patches.push({ x: x0, y: y0, ...scorePatch(img, x0, y0) });
    }
  }
  // A patch with no detail (flat sky, black night water) has nothing to be
  // periodic ABOUT. Scoring it would hand the gate a free zero.
  const used = patches.filter((p) => p.rms >= minRms);
  const peaks = used.map((p) => p.peak).sort((a, b) => a - b);
  const cons = used.map((p) => p.contrast).sort((a, b) => a - b);
  const worst = used.length ? used.reduce((a, p) => (p.peak > a.peak ? p : a)) : null;
  return {
    peak: { median: median(peaks), max: peaks.at(-1) ?? null },
    contrast: { median: median(cons), max: cons.at(-1) ?? null },
    used: used.length, patches, worst,
  };
}

/** The ground fills the lower half of an eye-level shot. */
export const GROUND_GRID = { x: [80, 240, 400, 560, 720, 840], y: [300, 380, 440] };
/** Open water seen from altitude: the frame's top band and its outer columns. */
export const WATER_GRID = { x: [20, 180, 340, 660, 844], y: [12, 80, 150] };
