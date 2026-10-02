// CREW EMBLEMS (b4.3e; crossdevice-15, PLAN D33).
//
// Every crew in a match flies its own emblem on its ensign and paints it on
// every sail, so a colour-blind player (or anyone squinting at a hull 400 m
// off at dusk) tells crews apart by SHAPE, never by hue alone.
//
// Assignment is exact, not hash-probable: a crew's dye is already unique in its
// match (the server deals one CREW_PALETTE dye per crew through pickCrewColor,
// carries it in state.crews[].color and Ship.teamColor, and hands a captured
// hull the captor's dye), so emblem i belongs to palette dye i. Twelve dyes,
// twelve emblems: no two crews of one match can ever share one. A dye that is
// not in the palette (legacy or test data) falls back to an FNV-1a hash of the
// crew id (or the dye), still deterministic on every client.
//
// The shapes are DATA (polygons in a unit box, y down like canvas), so the same
// geometry drives the canvas painter and scripts/test-emblems.mjs, which
// rasterises them to grade silhouette distinctness at the size a far hull shows.
import { CREW_PALETTE } from '../../../shared/crewPalette.js';

export type Pt = readonly [number, number];
/** One closed polygon. `hole` paints the background back over what came before
 *  (eye sockets, a ring's bore); parts paint in order, even-odd fill. */
export interface EmblemPart { pts: Pt[]; hole?: boolean }

export const EMBLEM_IDS = [
  'skull', 'anchor', 'star', 'crossed_swords', 'compass_rose', 'kraken',
  'crown', 'bell', 'helm', 'hourglass', 'trident', 'crescent',
] as const;
export type EmblemId = typeof EMBLEM_IDS[number];

const TAU = Math.PI * 2;
const part = (pts: Pt[], hole = false): EmblemPart => (hole ? { pts, hole } : { pts });
const ellipse = (cx: number, cy: number, rx: number, ry: number, hole = false, n = 28): EmblemPart =>
  part(Array.from({ length: n }, (_, i) => [cx + rx * Math.cos((TAU * i) / n), cy + ry * Math.sin((TAU * i) / n)] as Pt), hole);
const circle = (cx: number, cy: number, r: number, hole = false, n = 28) => ellipse(cx, cy, r, r, hole, n);
const rect = (x0: number, y0: number, x1: number, y1: number, hole = false) =>
  part([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], hole);
/** A straight bar of width w from (x0,y0) to (x1,y1). */
function bar(x0: number, y0: number, x1: number, y1: number, w: number, hole = false): EmblemPart {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * w * 0.5, ny = (dx / len) * w * 0.5;
  return part([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]], hole);
}
/** A thick arc (angles in canvas sense: 0 = +x, PI/2 = down). */
function arcBand(cx: number, cy: number, r: number, w: number, a0: number, a1: number, n = 32): EmblemPart {
  const outer: Pt[] = [], inner: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    outer.push([cx + (r + w / 2) * Math.cos(a), cy + (r + w / 2) * Math.sin(a)]);
    inner.push([cx + (r - w / 2) * Math.cos(a), cy + (r - w / 2) * Math.sin(a)]);
  }
  return part([...outer, ...inner.reverse()]);
}
function star(cx: number, cy: number, ro: number, ri: number, points: number, rot = -Math.PI / 2): EmblemPart {
  const pts: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? ro : ri, a = rot + (Math.PI * i) / points;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return part(pts);
}
/** A tapering tube along a polyline (tentacles). */
function tube(path: Pt[], w0: number, w1: number): EmblemPart {
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const w = (w0 + ((w1 - w0) * i) / (path.length - 1)) * 0.5;
    left.push([path[i][0] - (dy / len) * w, path[i][1] + (dx / len) * w]);
    right.push([path[i][0] + (dy / len) * w, path[i][1] - (dx / len) * w]);
  }
  return part([...left, ...right.reverse()]);
}
function sword(fx: number, fy: number, tx: number, ty: number): EmblemPart[] {
  const len = Math.hypot(tx - fx, ty - fy), ux = (tx - fx) / len, uy = (ty - fy) / len;
  const at = (d: number): Pt => [fx + ux * d, fy + uy * d];
  const [gx, gy] = at(0.3), [bx, by] = at(len - 0.16);
  return [
    bar(fx, fy, gx, gy, 0.1),
    bar(gx, gy, bx, by, 0.14),
    part([[bx - uy * 0.07, by + ux * 0.07], [tx, ty], [bx + uy * 0.07, by - ux * 0.07]]),
    bar(gx - uy * 0.24, gy + ux * 0.24, gx + uy * 0.24, gy - ux * 0.24, 0.1),
    circle(fx, fy, 0.09),
  ];
}
function tentacle(s: number, j: number): EmblemPart {
  const pts: Pt[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push([
      s * (0.06 + 0.09 * j + (0.1 + 0.26 * j) * t + 0.09 * Math.sin(t * 5.5 + j * 1.3) * t),
      -0.08 + (0.96 - 0.22 * j) * t - 0.18 * j * Math.max(0, t - 0.7),
    ]);
  }
  return tube(pts, 0.17, 0.035);
}

const HELM: EmblemPart[] = [
  ...Array.from({ length: 8 }, (_, i) => {
    const a = (TAU * i) / 8;
    return bar(0, 0, 0.84 * Math.cos(a), 0.84 * Math.sin(a), 0.09);
  }),
  ...Array.from({ length: 8 }, (_, i) => circle(0.86 * Math.cos((TAU * i) / 8), 0.86 * Math.sin((TAU * i) / 8), 0.1)),
  arcBand(0, 0, 0.56, 0.14, 0, TAU, 40),
  circle(0, 0, 0.18),
  circle(0, 0, 0.07, true),
];

/** Unit-box geometry: x, y in [-1, 1], y DOWN (canvas), drawn in order. */
export const EMBLEMS: Record<EmblemId, EmblemPart[]> = {
  skull: [
    bar(-0.78, 0.02, 0.78, 0.74, 0.15), bar(-0.78, 0.74, 0.78, 0.02, 0.15),
    circle(-0.82, -0.04, 0.11), circle(-0.72, 0.1, 0.11), circle(0.82, -0.04, 0.11), circle(0.72, 0.1, 0.11),
    circle(-0.82, 0.8, 0.11), circle(-0.72, 0.66, 0.11), circle(0.82, 0.8, 0.11), circle(0.72, 0.66, 0.11),
    ellipse(0, -0.3, 0.48, 0.46), rect(-0.27, -0.02, 0.27, 0.36),
    ellipse(-0.19, -0.32, 0.13, 0.15, true), ellipse(0.19, -0.32, 0.13, 0.15, true),
    part([[0, -0.14], [-0.07, 0.0], [0.07, 0.0]], true),
    rect(-0.1, 0.16, -0.05, 0.36, true), rect(0.05, 0.16, 0.1, 0.36, true),
  ],
  anchor: [
    arcBand(0, -0.76, 0.13, 0.09, 0, TAU, 24),
    bar(0, -0.64, 0, 0.7, 0.15),
    bar(-0.44, -0.44, 0.44, -0.44, 0.13),
    arcBand(0, 0.1, 0.62, 0.14, 0.12 * Math.PI, 0.88 * Math.PI),
    part([[-0.76, 0.42], [-0.44, 0.38], [-0.74, 0.02]]),
    part([[0.76, 0.42], [0.44, 0.38], [0.74, 0.02]]),
  ],
  star: [star(0, 0.06, 0.98, 0.4, 5)],
  crossed_swords: [...sword(-0.66, 0.7, 0.72, -0.76), ...sword(0.66, 0.7, -0.72, -0.76)],
  compass_rose: [
    arcBand(0, 0, 0.54, 0.08, 0, TAU, 40),
    star(0, 0, 0.98, 0.17, 4),
    star(0, 0, 0.6, 0.15, 4, -Math.PI / 4),
    circle(0, 0, 0.08, true),
  ],
  kraken: [
    ...[0, 1, 2].flatMap((j) => [tentacle(-1, j), tentacle(1, j)]),
    ellipse(0, -0.46, 0.36, 0.44),
    circle(-0.14, -0.36, 0.07, true), circle(0.14, -0.36, 0.07, true),
  ],
  crown: [
    part([[-0.72, 0.32], [-0.86, -0.46], [-0.42, -0.08], [0, -0.7], [0.42, -0.08], [0.86, -0.46], [0.72, 0.32]]),
    circle(-0.86, -0.56, 0.11), circle(0, -0.8, 0.11), circle(0.86, -0.56, 0.11),
    rect(-0.76, 0.3, 0.76, 0.56),
    circle(-0.42, 0.43, 0.07, true), circle(0, 0.43, 0.07, true), circle(0.42, 0.43, 0.07, true),
  ],
  bell: [
    arcBand(0, -0.82, 0.11, 0.08, 0, TAU, 24),
    part([
      [0, -0.72], [0.22, -0.7], [0.34, -0.56], [0.38, -0.22], [0.46, 0.16], [0.7, 0.42], [0.7, 0.52],
      [-0.7, 0.52], [-0.7, 0.42], [-0.46, 0.16], [-0.38, -0.22], [-0.34, -0.56], [-0.22, -0.7],
    ]),
    bar(-0.46, 0.3, 0.46, 0.3, 0.05, true),
    circle(0, 0.68, 0.14),
  ],
  helm: HELM,
  hourglass: [
    rect(-0.66, -0.96, 0.66, -0.8), rect(-0.66, 0.8, 0.66, 0.96),
    bar(-0.56, -0.8, -0.56, 0.8, 0.07), bar(0.56, -0.8, 0.56, 0.8, 0.07),
    part([[-0.42, -0.8], [0.42, -0.8], [0.07, 0], [0.42, 0.8], [-0.42, 0.8], [-0.07, 0]]),
    part([[-0.3, -0.7], [0.3, -0.7], [0.06, -0.16], [-0.06, -0.16]], true),
  ],
  trident: [
    bar(0, -0.62, 0, 0.98, 0.13),
    arcBand(0, -0.42, 0.42, 0.12, 0, Math.PI, 20),
    bar(-0.42, -0.42, -0.42, -0.76, 0.11), bar(0, -0.42, 0, -0.76, 0.11), bar(0.42, -0.42, 0.42, -0.76, 0.11),
    ...[-0.42, 0, 0.42].map((x) => part([[x - 0.12, -0.74], [x, -0.99], [x + 0.12, -0.74]])),
  ],
  crescent: [
    circle(-0.08, 0, 0.86, false, 40),
    circle(0.3, -0.14, 0.7, true, 40),
    star(0.42, 0.16, 0.3, 0.12, 5),
  ],
};

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** The crew's emblem: palette dye i -> emblem i (unique per match, because the
 *  dye is); an off-palette dye falls back to a hash of the crew id (or dye). */
export function emblemForCrew(teamColor: number, crewId?: string | null): EmblemId {
  const i = CREW_PALETTE.indexOf(teamColor >>> 0);
  if (i >= 0) return EMBLEM_IDS[i % EMBLEM_IDS.length];
  return EMBLEM_IDS[fnv1a(crewId ?? `dye:${(teamColor >>> 0).toString(16)}`) % EMBLEM_IDS.length];
}

/** Relative luminance (WCAG) of a 0xRRGGBB dye. */
export function dyeLuminance(c: number): number {
  const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((c >> 16) & 0xff) + 0.7152 * lin((c >> 8) & 0xff) + 0.0722 * lin(c & 0xff);
}
export const hexOf = (c: number) => `#${(c >>> 0).toString(16).padStart(6, '0')}`;
const BONE = '#f2efe6', TAR = '#1c1712';
/** The ink an emblem is painted in on a field of `dye` (bone on dark, tar on light). */
export function inkOn(dye: number): string { return dyeLuminance(dye) > 0.3 ? TAR : BONE; }

export interface EmblemStyle { fg: string; bg: string; halo?: string; haloWidth?: number }

/** Paints emblem `id` centred on (cx, cy) with half-extent `half` px. */
export function drawEmblem(ctx: CanvasRenderingContext2D, id: EmblemId, cx: number, cy: number, half: number, style: EmblemStyle) {
  const parts = EMBLEMS[id];
  const trace = (p: EmblemPart) => {
    ctx.beginPath();
    p.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(cx + x * half, cy + y * half) : ctx.lineTo(cx + x * half, cy + y * half)));
    ctx.closePath();
  };
  ctx.save();
  if (style.halo) {
    // Outline pass under the fills: a dark rim keeps a bone-white or
    // brimstone emblem readable on cream canvas.
    ctx.strokeStyle = style.halo; ctx.fillStyle = style.halo;
    ctx.lineWidth = style.haloWidth ?? half * 0.12; ctx.lineJoin = 'round';
    for (const p of parts) if (!p.hole) { trace(p); ctx.stroke(); ctx.fill('evenodd'); }
  }
  for (const p of parts) {
    ctx.fillStyle = p.hole ? style.bg : style.fg;
    trace(p);
    ctx.fill('evenodd');
  }
  ctx.restore();
}

/** Where the emblem sits on the 256x256 sail canvas (head at the top): between
 *  the second reef band (y 66) and the team band (y 168). */
export const SAIL_EMBLEM = { cx: 128, cy: 117, half: 44 } as const;
/** On the 256x128 ensign: centred on the fly half (hoist at x = 0). */
export const FLAG_EMBLEM = { cx: 150, cy: 64, half: 44 } as const;
/** Sail canvas base tone (textures.ts sailTexture), the colour holes paint back. */
export const SAIL_CANVAS = '#EEE0B8';

/** Sail layer: the crew emblem painted in the crew dye with a tar rim. */
export function drawSailEmblem(ctx: CanvasRenderingContext2D, teamColor: number, crewId?: string | null) {
  const { cx, cy, half } = SAIL_EMBLEM;
  ctx.globalAlpha = 0.9;
  drawEmblem(ctx, emblemForCrew(teamColor, crewId), cx, cy, half, { fg: hexOf(teamColor), bg: SAIL_CANVAS, halo: 'rgba(36,26,14,0.85)', haloWidth: 5 });
  ctx.globalAlpha = 1;
}

/** Flag layer: the crew emblem in bone or tar on the crew dye. */
export function drawFlagEmblem(ctx: CanvasRenderingContext2D, teamColor: number, crewId?: string | null) {
  const { cx, cy, half } = FLAG_EMBLEM;
  drawEmblem(ctx, emblemForCrew(teamColor, crewId), cx, cy, half, { fg: inkOn(teamColor), bg: hexOf(teamColor) });
}
