/**
 * WHEEL AND TRACKPAD ON THE CHART (b1.4a; crossdevice-09).
 *
 * Every wheel event used to multiply the chart zoom by a fixed 1.18, so a Mac
 * trackpad flick (30-80 events of deltaY ~ -4) slammed the chart from 1x to the
 * 7x cap. Zoom is now continuous in the scroll distance:
 *   factor = exp(-deltaY_px * k), clamped per event,
 * with deltaMode normalised (LINE x16 px, PAGE x viewport height). ctrl+wheel
 * is what macOS delivers for a trackpad PINCH (Chrome, Safari, Firefox): it
 * zooms with a stronger k. A horizontal two-finger scroll (deltaX) pans.
 *
 *   40 x deltaY -4        -> ~1.42x  (a trackpad flick)
 *    1 x deltaY -100      -> ~1.25x  (one mouse notch)
 *   10 x ctrl deltaY -10  -> ~2.72x  (a pinch)
 */

export type WheelLike = {
  readonly deltaX: number;
  readonly deltaY: number;
  /** 0 = pixel, 1 = line, 2 = page (WheelEvent.DOM_DELTA_*). */
  readonly deltaMode?: number;
  readonly ctrlKey?: boolean;
};

export type ChartWheelAction = {
  /** Multiplicative zoom to apply about the cursor (1 = none). */
  readonly zoomFactor: number;
  /** Pan to apply, in client px of "drag" (feeds MapRenderer.panByClient). */
  readonly panDx: number;
  readonly panDy: number;
};

export const WHEEL_ZOOM_K = 0.0022;
export const PINCH_ZOOM_K = 0.01;
export const WHEEL_ZOOM_MIN_STEP = 0.8;
export const WHEEL_ZOOM_MAX_STEP = 1.25;
const LINE_PX = 16;

export function normaliseWheelDelta(delta: number, deltaMode = 0, pageHeight = 800): number {
  if (!Number.isFinite(delta)) return 0;
  if (deltaMode === 1) return delta * LINE_PX;
  if (deltaMode === 2) return delta * pageHeight;
  return delta;
}

export function wheelToChartAction(event: WheelLike, pageHeight = 800): ChartWheelAction {
  const dy = normaliseWheelDelta(event.deltaY, event.deltaMode, pageHeight);
  const dx = normaliseWheelDelta(event.deltaX, event.deltaMode, pageHeight);
  const k = event.ctrlKey ? PINCH_ZOOM_K : WHEEL_ZOOM_K;
  const raw = Math.exp(-dy * k);
  const zoomFactor = Math.max(WHEEL_ZOOM_MIN_STEP, Math.min(WHEEL_ZOOM_MAX_STEP, raw));
  // A pinch never pans; a two-finger sideways scroll pans the chart (scrolling
  // right moves the view right = dragging the chart left).
  const panDx = event.ctrlKey ? 0 : -dx;
  return { zoomFactor, panDx, panDy: 0 };
}

// ── Touch on the chart (b1.4d): one finger pans, two fingers pinch ──────────

export type Pt = { readonly x: number; readonly y: number };

export type PinchStep = {
  /** Zoom to apply about (midX, midY): the new finger spread over the old. */
  readonly zoomFactor: number;
  readonly midX: number;
  readonly midY: number;
  /** The midpoint's own travel, applied as a pan (two fingers dragging together). */
  readonly panDx: number;
  readonly panDy: number;
};

/** Fingers closer than this never zoom (a spread of 0 would divide by zero). */
const PINCH_MIN_SPREAD_PX = 12;

/**
 * One pointermove of a two-finger gesture. Pan first by the midpoint's travel,
 * then zoom about the NEW midpoint by the spread ratio, so the water between
 * the fingers stays between the fingers (the same anchor rule as the wheel).
 */
export function pinchStep(prevA: Pt, prevB: Pt, curA: Pt, curB: Pt): PinchStep {
  const d0 = Math.hypot(prevB.x - prevA.x, prevB.y - prevA.y);
  const d1 = Math.hypot(curB.x - curA.x, curB.y - curA.y);
  const zoomFactor = d0 >= PINCH_MIN_SPREAD_PX && d1 >= PINCH_MIN_SPREAD_PX && Number.isFinite(d1 / d0) ? d1 / d0 : 1;
  const midX = (curA.x + curB.x) / 2;
  const midY = (curA.y + curB.y) / 2;
  return {
    zoomFactor,
    midX,
    midY,
    panDx: midX - (prevA.x + prevB.x) / 2,
    panDy: midY - (prevA.y + prevB.y) / 2,
  };
}

/**
 * Chart focus after a zoom about a screen point (MapRenderer.zoomAtClient's
 * rule, pure): the world point at (px, py) canvas px from the centre stays at
 * (px, py). focus = world at the canvas centre; scale = canvas px per metre.
 */
export function zoomFocusAbout(
  focus: { x: number; z: number }, px: number, py: number, scale0: number, scale1: number,
): { x: number; z: number } {
  const worldX = focus.x + px / scale0;
  const worldZ = focus.z + py / scale0;
  return { x: worldX - px / scale1, z: worldZ - py / scale1 };
}
