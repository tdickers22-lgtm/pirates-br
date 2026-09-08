/**
 * ONE VALIDATOR PER CLIENT MESSAGE — the whole inbound boundary, in one file.
 *
 * WHY THIS EXISTS (ONLINE-01 / codehealth-13, netcode-24). Before this module
 * the server's only inbound checks were `MAX_DECODED_MESSAGE_BYTES`, a JSON
 * parse and `typeof msg.type === 'string'`. After that every handler was on its
 * own, and they did not agree:
 *
 *   • `solo_start` did `typeof payload.botCount === 'number'` — which NaN
 *     passes. `Math.max(0, Math.min(fullFill, Math.floor(NaN)))` is NaN, so a
 *     hostile client asked for a NaN-sized bot fleet.
 *   • `set_name` cast to `{ name?: string }` and called `.trim()`, so
 *     `{name: 7}` threw inside the handler (caught upstream and logged, but the
 *     player's frame was simply gone).
 *   • `join_party` / `party_kick` / `party_transfer_host` cast their id fields
 *     with no check at all.
 *   • `ping` echoed `msg.payload` back verbatim — up to the whole 64 KB frame
 *     budget, reflected off the server to whoever asked.
 *   • Nothing distinguished CLIENT vocabulary from SERVER vocabulary, so a
 *     client could post `state_snapshot` or `game_over` at the lobby and it was
 *     forwarded into the match's own switch.
 *
 * The rule now: a frame is routed only if its `type` is a `ClientMsgType` AND
 * its validator returns a normalised payload. Validators check SHAPE, never
 * policy — "is this a string" here, "is this name empty" / "are you the host"
 * stays in the handler, so every existing refusal message still reaches the
 * player exactly as before.
 *
 * Consumed by: `src/server/core/LobbyServer.ts` (`routeMessage`) and
 * `src/server/core/Match.ts` (`sanitizeInput` delegates to
 * `sanitizePlayerInput` here). Graded by `scripts/test-wire-validation.mjs`,
 * which fails if any member of `ClientMsgType` has no validator.
 */
import type {
  AnyClientMsg, ClientMsgPayloads, ClientMsgType, InteractIntent, ItemStack,
  NetMsg, PlayerInput, TradeActionPayload,
} from '../../shared/types/index.js';
import { angleWrap, clamp } from '../../shared/utils/index.js';

/** Every intent the server will honour on [X]. Kept beside the validator that
 *  enforces it so a new verb cannot be typed on the wire without landing here. */
export const VALID_INTERACT_INTENTS: ReadonlySet<InteractIntent> = new Set<InteractIntent>([
  'barrel', 'chest', 'board', 'dock', 'mermaid', 'keg_diffuse', 'upgrade',
  'gold_hoarder', 'stow_chest', 'helm', 'sails', 'brace',
  'crow', 'anchor', 'repair', 'bail', 'revive', 'cannon', 'ammo',
]);

/** Longest string any inbound field may carry. Names/codes/ids are far shorter;
 *  this is the backstop that keeps a 60 KB string out of a party roster. */
const MAX_FIELD_CHARS = 128;

type Bag = Record<string, unknown>;

/** A payload must be an object (or absent). Arrays and primitives are not. */
function bag(raw: unknown): Bag | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Bag;
}

/** A finite number, or null. `NaN`/`Infinity` are NOT numbers for wire purposes
 *  — that distinction is the whole solo_start bug. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A bounded string, or null. Over-long strings are rejected, not truncated:
 *  silently keeping the first 128 chars of a 60 KB field hides the attack. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length <= MAX_FIELD_CHARS ? v : null;
}

/** Missing/rubbish reads as absent, not as `true`. */
function bool(v: unknown): boolean {
  return v === true;
}

/**
 * PLAYER INPUT — the hot path (one per client per frame). Moved here from
 * `Match.sanitizeInput` so the sim and the lobby share one shape check; Match
 * still exposes `sanitizeInput` as a delegate (test-server-fixes drives it).
 */
export function sanitizePlayerInput(raw: unknown): PlayerInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const input = raw as Record<keyof PlayerInput, unknown>;
  const seq = num(input.seq);
  const yaw = num(input.yaw);
  const pitch = num(input.pitch);
  if (seq === null || yaw === null || pitch === null) return null;

  const slot = input.slot === 0 || input.slot === 1 || input.slot === 2 || input.slot === 3
    ? input.slot
    : null;
  const wheelIndex = typeof input.wheelIndex === 'number'
    && Number.isInteger(input.wheelIndex)
    && input.wheelIndex >= 0
    && input.wheelIndex <= 9
    ? input.wheelIndex
    : null;
  const cannonAmmo = input.cannonAmmo === 'cannonball' || input.cannonAmmo === 'firebomb' || input.cannonAmmo === 'chainshot'
    ? input.cannonAmmo
    : null;
  const interactIntent = typeof input.interactIntent === 'string'
    && VALID_INTERACT_INTENTS.has(input.interactIntent as InteractIntent)
    ? input.interactIntent as InteractIntent
    : null;

  return {
    seq,
    ts: num(input.ts) ?? 0,
    forward: bool(input.forward),
    back: bool(input.back),
    left: bool(input.left),
    right: bool(input.right),
    jump: bool(input.jump),
    jumpPressed: bool(input.jumpPressed),
    fire: bool(input.fire),
    useItem: bool(input.useItem),
    crouch: bool(input.crouch),
    aim: bool(input.aim),
    interact: bool(input.interact),
    interactHeld: bool(input.interactHeld),
    anchor: bool(input.anchor),
    sailRaise: bool(input.sailRaise),
    sailLower: bool(input.sailLower),
    sailLeft: bool(input.sailLeft),
    sailRight: bool(input.sailRight),
    trade: bool(input.trade),
    reload: bool(input.reload),
    placeKeg: bool(input.placeKeg),
    dropChest: bool(input.dropChest),
    specialAttack: bool(input.specialAttack),
    slot,
    cannonAmmo,
    yaw: angleWrap(yaw),
    pitch: clamp(pitch, -Math.PI / 2, Math.PI / 2),
    wheelIndex,
    useWheelItem: bool(input.useWheelItem),
    barrelTakeAll: bool(input.barrelTakeAll),
    interactIntent,
    // Quest-map equip rode in the payload but was dropped here, so the
    // selectMap one-shot on the other side could never fire.
    selectMap: typeof input.selectMap === 'string' && input.selectMap.length <= 64
      ? input.selectMap
      : null,
  };
}

/** A trade offer is a list of `{item, qty}` stacks. An offer that is present
 *  but not a bounded array of objects is a malformed frame, not an empty offer:
 *  the unvalidated cast used to crash the trade handler. */
function sanitizeTradeAction(raw: unknown): TradeActionPayload | null {
  const p = bag(raw);
  if (!p) return null;
  const sessionId = str(p.sessionId);
  if (sessionId === null) return null;
  const action = p.action;
  if (action !== 'offer' && action !== 'confirm' && action !== 'cancel') return null;
  if (p.offer === undefined) return { sessionId, action };
  if (!Array.isArray(p.offer) || p.offer.length > 64) return null;
  const offer: ItemStack[] = [];
  for (const entry of p.offer) {
    const e = bag(entry);
    if (!e) return null;
    const item = str(e.item);
    const qty = num(e.qty);
    if (item === null || qty === null) return null;
    // The item id itself is checked against the player's own hold by the trade
    // handler; here it only has to BE a bounded string with a sane count.
    offer.push({ item: item as ItemStack['item'], qty: Math.max(0, Math.floor(qty)) });
  }
  return { sessionId, action, offer };
}

/**
 * THE MAP. `Record<K, ...>` over the whole union, so TypeScript itself fails
 * the build when a `ClientMsgType` is added without a validator — the gate is
 * the type, the suite only proves it at runtime as well.
 */
export const CLIENT_VALIDATORS: {
  [K in ClientMsgType]: (raw: unknown) => ClientMsgPayloads[K] | null;
} = {
  set_name: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    const name = p.name === undefined ? '' : str(p.name);
    return name === null ? null : { name };
  },
  create_party: (raw) => (bag(raw) ? {} : null),
  join_party: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    const code = p.code === undefined ? '' : str(p.code);
    return code === null ? null : { code };
  },
  leave_party: (raw) => (bag(raw) ? {} : null),
  party_ready: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    // Historic contract: anything that is not literal `false` reads as ready.
    return { ready: p.ready !== false };
  },
  party_kick: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    const clientId = str(p.clientId);
    return clientId === null ? null : { clientId };
  },
  party_transfer_host: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    const clientId = str(p.clientId);
    return clientId === null ? null : { clientId };
  },
  update_party_settings: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    return { mode: p.mode === undefined ? null : str(p.mode), botFill: num(p.botFill) };
  },
  start_match: (raw) => {
    const p = bag(raw);
    return p ? { force: p.force === true } : null;
  },
  queue_join: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    return { mode: p.mode === undefined ? null : str(p.mode) };
  },
  queue_leave: (raw) => (bag(raw) ? {} : null),
  solo_start: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    // The NaN hole: `typeof NaN === 'number'` waved a NaN bot count straight
    // through into the fleet-size arithmetic.
    return { botCount: num(p.botCount) };
  },
  return_to_menu: (raw) => (bag(raw) ? {} : null),
  play_again: (raw) => (bag(raw) ? {} : null),
  resume: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    // A missing or wrong-typed token is a legitimate 'unknown_token' refusal, not
    // a dropped frame: the client must hear back so it can start fresh.
    return { token: str(p.token) ?? '', protocolVersion: num(p.protocolVersion) };
  },
  ping: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    // Only the timestamp comes back. The old handler reflected the entire
    // payload, which made the server a 64 KB-per-frame echo amplifier.
    return { t: num(p.t) ?? 0 };
  },
  player_input: (raw) => sanitizePlayerInput(raw),
  shop_buy: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    const line = str(p.line);
    return line === null ? null : { line };
  },
  trade_action: (raw) => sanitizeTradeAction(raw),
  dev_bot_peace: (raw) => {
    const p = bag(raw);
    return p ? { enabled: p.enabled === true } : null;
  },
  dev_grant_gold: (raw) => {
    const p = bag(raw);
    if (!p) return null;
    const gold = num(p.gold);
    return gold === null ? null : { gold };
  },
};

/** Runtime membership test for the client vocabulary (the type-level one is
 *  `ClientMsgType`). Server→client types answer false. */
export function isClientMsgType(type: unknown): type is ClientMsgType {
  return typeof type === 'string'
    && Object.prototype.hasOwnProperty.call(CLIENT_VALIDATORS, type);
}

/**
 * The boundary. Returns a fully-typed message whose payload the handlers may
 * trust, or null — and null means DROP THE FRAME, never "close the socket":
 * a client's frame loop can legitimately race a match teardown, and killing the
 * session over one unaddressable frame costs the player their whole game.
 */
export function validateClientMsg(msg: NetMsg): AnyClientMsg | null {
  if (!isClientMsgType(msg?.type)) return null;
  const type = msg.type as ClientMsgType;
  const payload = CLIENT_VALIDATORS[type](msg.payload);
  if (payload === null) return null;
  const ts = num(msg.ts) ?? 0;
  return { type, ts, payload } as AnyClientMsg;
}
