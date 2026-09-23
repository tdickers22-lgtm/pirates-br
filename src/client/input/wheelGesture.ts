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
