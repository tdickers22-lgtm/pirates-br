/**
 * THE SUPPLY WHEEL, IN ONE TABLE.
 *
 * There were four independent copies of "what is in slot n": the SVG slices and
 * labels in index.html, the digit→slot map in InputManager, the count/kind
 * switches in Game, and the digits printed in the pocket strip. Three of them
 * agreed. The strip did not: it read "1 Plantain | 2 Plank | 3 Coconut | 4 Meat"
 * while 1 equipped the spyglass, 2 the compass, 3 the bucket and 4 spent a
 * plank — a player who followed the strip to heal ended up holding a bucket
 * (hud-01). And the tenth slice, the axe, had no key at all, while the legend
 * promised "1-9 to take one" (hud-02).
 *
 * So: one ordered table, and every consumer derives from it. The slice ORDER is
 * the SVG's clockwise order starting at twelve o'clock; the keys are 1-9 then 0
 * for the tenth.
 *
 * Client-only truth (the wheel is a HUD device): no server module imports this.
 * It lives in shared/ because the plan puts the HUD's shared vocabulary there
 * and because the eventual bindings table (shared/bindings.ts) will read it.
 */

/** Tools EQUIP when their slice is taken; they are not consumed. */
export type WheelTool = 'spyglass' | 'compass' | 'bucket' | 'shovel' | 'lantern' | 'axe';
/** Pocket consumables: the slice shows a count and taking it spends one. */
export type WheelPocket = 'wood' | 'banana' | 'coconut' | 'meat';

export type WheelSlot = {
  /** Slice index, and the wheelIndex the server receives. */
  readonly index: number;
  /** The key the player presses, as printed. Slot 9 is '0'. */
  readonly key: string;
  /** The KeyboardEvent.code that key produces. */
  readonly digitCode: string;
  /** Short name, as shown on the slice and in the pocket strip. */
  readonly label: string;
  readonly glyph: string;
  readonly tool: WheelTool | null;
  readonly pocket: WheelPocket | null;
};

export const WHEEL_SLOTS: readonly WheelSlot[] = [
  { index: 0, key: '1', digitCode: 'Digit1', label: 'Scope', glyph: '🔭', tool: 'spyglass', pocket: null },
  { index: 1, key: '2', digitCode: 'Digit2', label: 'Compass', glyph: '🧭', tool: 'compass', pocket: null },
  { index: 2, key: '3', digitCode: 'Digit3', label: 'Bucket', glyph: '🪣', tool: 'bucket', pocket: null },
  { index: 3, key: '4', digitCode: 'Digit4', label: 'Planks', glyph: '🪵', tool: null, pocket: 'wood' },
  { index: 4, key: '5', digitCode: 'Digit5', label: 'Plantain', glyph: '🍌', tool: null, pocket: 'banana' },
  { index: 5, key: '6', digitCode: 'Digit6', label: 'Coconut', glyph: '🥥', tool: null, pocket: 'coconut' },
  { index: 6, key: '7', digitCode: 'Digit7', label: 'Meat', glyph: '🥩', tool: null, pocket: 'meat' },
  { index: 7, key: '8', digitCode: 'Digit8', label: 'Shovel', glyph: '⛏️', tool: 'shovel', pocket: null },
  { index: 8, key: '9', digitCode: 'Digit9', label: 'Lantern', glyph: '🪔', tool: 'lantern', pocket: null },
  { index: 9, key: '0', digitCode: 'Digit0', label: 'Axe', glyph: '🪓', tool: 'axe', pocket: null },
];

/** What the legend and the wheel hint must say. Derived, never typed twice. */
export const WHEEL_KEY_HINT = `${WHEEL_SLOTS[0].key}-${WHEEL_SLOTS[WHEEL_SLOTS.length - 2].key}, ${WHEEL_SLOTS[WHEEL_SLOTS.length - 1].key}`;

/** Which slice a digit takes while the wheel is held, or null for any other key. */
export function wheelSlotForDigitCode(code: string): number | null {
  const slot = WHEEL_SLOTS.find((s) => s.digitCode === code);
  return slot ? slot.index : null;
}

/** Which slice holds an equipped tool (for the highlight), or -1. */
export function wheelSlotForTool(tool: WheelTool | string | null | undefined): number {
  if (!tool) return -1;
  const slot = WHEEL_SLOTS.find((s) => s.tool === tool);
  return slot ? slot.index : -1;
}

/** The pocket item a slice spends, or null on a tool slice. */
export function wheelPocketForSlot(index: number): WheelPocket | null {
  return WHEEL_SLOTS[index]?.pocket ?? null;
}
