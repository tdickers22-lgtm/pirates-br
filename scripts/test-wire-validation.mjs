#!/usr/bin/env node
// EVERY INBOUND FRAME IS SHAPE-CHECKED BEFORE A HANDLER SEES IT (ONLINE-01,
// codehealth-13 / netcode-24).
//
// The bugs this gate exists for, all reachable from a browser console against a
// live server, all found by reading the handlers rather than by a suite:
//
//   • `solo_start {botCount: NaN}` — the handler's guard was
//     `typeof payload.botCount === 'number'`, which NaN passes.
//     `Math.max(0, Math.min(fullFill, Math.floor(NaN)))` is NaN, so the fleet
//     size handed to spawnAndBoard was NaN.
//   • `set_name {name: 7}` — cast to `{name?: string}` and then `.trim()`ed, so
//     the handler THREW; the frame was logged and lost instead of refused.
//   • `join_party` / `party_kick` / `party_transfer_host` cast their id field
//     with no check at all.
//   • `ping` replied with `payload: msg.payload` verbatim, so the server
//     reflected up to a whole 64 KB frame per ping.
//   • Nothing separated CLIENT vocabulary from SERVER vocabulary: a client
//     could post `state_snapshot`, `game_over` or `welcome` and it was routed.
//
// The rule now: `ClientMsgType` is the client's vocabulary, every member has
// exactly one validator in src/server/net/validate.ts, and LobbyServer routes
// nothing that has not been through it.
//
// Pure logic: no stack, no ports, no browser. ~0.3 s.
import { readFileSync } from 'node:fs';
import {
  CLIENT_VALIDATORS, validateClientMsg, isClientMsgType, sanitizePlayerInput,
} from '../src/server/net/validate.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

console.log('Wire validation (client→server boundary)');

const ROOT = new URL('..', import.meta.url);
const readSrc = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const TYPES = readSrc('src/shared/types/index.ts');
const LOBBY = readSrc('src/server/core/LobbyServer.ts');

// ── 1. The declared vocabulary and the validator map are the same set ───────
const declared = (TYPES.match(/export type ClientMsgType =([\s\S]*?);/)?.[1] ?? '')
  .split('|').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
expect('ClientMsgType parses and is non-trivial', declared.length >= 15, `${declared.length} types`);
const validators = Object.keys(CLIENT_VALIDATORS);
const unvalidated = declared.filter((t) => !validators.includes(t));
expect('every ClientMsgType has a validator', unvalidated.length === 0, unvalidated.join(', '));
const orphan = validators.filter((t) => !declared.includes(t));
expect('no validator for a type the union does not declare', orphan.length === 0, orphan.join(', '));

// ── 2. LobbyServer routes NOTHING it has not validated ─────────────────────
// Structural, because the alternative is booting a server per assertion. The
// switch must sit downstream of the validator call inside routeMessage.
const route = LOBBY.match(/private routeMessage\([\s\S]*?\n  }\n/)?.[0] ?? '';
expect('routeMessage exists and was parsed', route.length > 0);
expect('routeMessage validates before its switch',
  route.indexOf('validateClientMsg') >= 0
  && route.indexOf('validateClientMsg') < route.indexOf('switch (msg.type)'),
  'the switch must be downstream of the validator, not beside it');
expect('no handler still casts a raw payload',
  !/msg\.payload as \{/.test(LOBBY) && !/\(msg\.payload \?\? \{\}\) as/.test(LOBBY),
  (LOBBY.match(/.*msg\.payload (as|\?\?).*/g) ?? []).join('\n     '));

// ── 3. Server vocabulary is refused on the way IN ──────────────────────────
for (const serverOnly of ['state_snapshot', 'state_hot', 'game_over', 'welcome', 'lobby_update', 'join']) {
  expect(`a client cannot speak '${serverOnly}'`,
    !isClientMsgType(serverOnly)
    && validateClientMsg({ type: serverOnly, ts: 0, payload: {} }) === null);
}
expect('an unknown type is refused', validateClientMsg({ type: 'nonsense', ts: 0, payload: {} }) === null);
expect('a non-string type is refused', validateClientMsg({ type: 7, ts: 0, payload: {} }) === null);

// ── 4. Per-type: null, wrong-typed and oversized payloads ──────────────────
// Every client type must survive a null payload (either normalised or refused —
// never a throw), refuse an array/primitive payload, and refuse a 64 KB string
// in any string field it declares.
const HUGE = 'x'.repeat(64 * 1024);
const WRONG = [[], 'string', 7, true];
for (const type of declared) {
  let threw = null;
  try {
    for (const payload of [null, undefined, {}, ...WRONG, { junk: HUGE }]) {
      validateClientMsg({ type, ts: 0, payload });
    }
    validateClientMsg({ type, ts: NaN, payload: {} });
  } catch (err) { threw = err; }
  expect(`'${type}' never throws on a hostile payload`, threw === null, threw?.message ?? '');
  for (const payload of WRONG) {
    expect(`'${type}' refuses a ${Array.isArray(payload) ? 'array' : typeof payload} payload`,
      validateClientMsg({ type, ts: 0, payload }) === null);
  }
}

// ── 5. The five shipped holes, pinned one by one ───────────────────────────
const v = (type, payload) => validateClientMsg({ type, ts: 0, payload });

expect('solo_start refuses a NaN bot count', v('solo_start', { botCount: NaN })?.payload.botCount === null,
  `got ${JSON.stringify(v('solo_start', { botCount: NaN })?.payload)}`);
expect('solo_start refuses an Infinite bot count', v('solo_start', { botCount: Infinity })?.payload.botCount === null);
expect('solo_start keeps a real bot count', v('solo_start', { botCount: 4 })?.payload.botCount === 4);
expect('solo_start with no payload means "server default"', v('solo_start', {})?.payload.botCount === null);

expect('set_name refuses a numeric name', v('set_name', { name: 7 }) === null);
expect('set_name refuses a 64 KB name', v('set_name', { name: HUGE }) === null);
expect('set_name keeps a real name', v('set_name', { name: 'Sally' })?.payload.name === 'Sally');
expect('set_name with no name reaches the handler as empty (so the refusal still fires)',
  v('set_name', {})?.payload.name === '');

expect('join_party refuses a non-string code', v('join_party', { code: { a: 1 } }) === null);
expect('party_kick refuses a non-string id', v('party_kick', { clientId: 12 }) === null);
expect('party_transfer_host refuses a non-string id', v('party_transfer_host', { clientId: null }) === null);
expect('party_kick keeps a real id', v('party_kick', { clientId: 'abc' })?.payload.clientId === 'abc');

const pong = v('ping', { t: 5, blob: HUGE });
expect('ping carries only its timestamp forward (no 64 KB echo)',
  pong !== null && Object.keys(pong.payload).length === 1 && pong.payload.t === 5,
  JSON.stringify(Object.keys(pong?.payload ?? {})));
expect('ping with a NaN timestamp reads as 0', v('ping', { t: NaN })?.payload.t === 0);

expect('dev_grant_gold refuses NaN gold', v('dev_grant_gold', { gold: NaN }) === null);
expect('dev_grant_gold refuses a missing amount', v('dev_grant_gold', {}) === null);
expect('dev_bot_peace only ever reads a literal true',
  v('dev_bot_peace', { enabled: 'yes' })?.payload.enabled === false
  && v('dev_bot_peace', { enabled: true })?.payload.enabled === true);

expect('update_party_settings refuses a NaN bot fill',
  v('update_party_settings', { botFill: NaN })?.payload.botFill === null);
expect('start_match force is a literal true or nothing',
  v('start_match', { force: 'yes' })?.payload.force === false
  && v('start_match', { force: true })?.payload.force === true);

// ── 6. trade_action: the cast that used to crash the trade handler ─────────
expect('trade_action refuses a missing action', v('trade_action', { sessionId: 's' }) === null);
expect('trade_action refuses an unknown action', v('trade_action', { sessionId: 's', action: 'steal' }) === null);
expect('trade_action refuses a non-array offer', v('trade_action', { sessionId: 's', action: 'offer', offer: 'all' }) === null);
expect('trade_action refuses a 10k-entry offer',
  v('trade_action', { sessionId: 's', action: 'offer', offer: new Array(10_000).fill({ item: 'gold', qty: 1 }) }) === null);
expect('trade_action refuses a NaN quantity',
  v('trade_action', { sessionId: 's', action: 'offer', offer: [{ item: 'gold', qty: NaN }] }) === null);
{
  const ok = v('trade_action', { sessionId: 's', action: 'offer', offer: [{ item: 'gold', qty: 3.7 }] });
  expect('trade_action keeps a real offer, floored', ok?.payload.offer?.[0]?.qty === 3);
}
expect('trade_action confirm needs no offer',
  v('trade_action', { sessionId: 's', action: 'confirm' })?.payload.action === 'confirm');

// ── 7. player_input still behaves exactly as Match.sanitizeInput did ───────
const baseInput = { seq: 1, ts: 0, yaw: 0, pitch: 0 };
expect('NaN yaw drops the whole input', sanitizePlayerInput({ ...baseInput, yaw: NaN }) === null);
expect('Infinite pitch drops the whole input', sanitizePlayerInput({ ...baseInput, pitch: Infinity }) === null);
expect('a non-numeric seq drops the whole input', sanitizePlayerInput({ ...baseInput, seq: 'x' }) === null);
expect('a non-object input is dropped', sanitizePlayerInput('garbage') === null);
expect('yaw is wrapped', Math.abs(sanitizePlayerInput({ ...baseInput, yaw: Math.PI * 7.5 }).yaw) <= Math.PI + 1e-9);
expect('pitch is clamped', sanitizePlayerInput({ ...baseInput, pitch: 3 }).pitch === Math.PI / 2);
expect('an over-long selectMap is dropped',
  sanitizePlayerInput({ ...baseInput, selectMap: HUGE }).selectMap === null);
expect('an unknown interactIntent is nulled, not routed',
  sanitizePlayerInput({ ...baseInput, interactIntent: 'launch_nuke' }).interactIntent === null);
expect('a real interactIntent survives',
  sanitizePlayerInput({ ...baseInput, interactIntent: 'helm' }).interactIntent === 'helm');
expect('player_input goes through the same validator',
  v('player_input', { ...baseInput, yaw: NaN }) === null
  && v('player_input', baseInput)?.payload.seq === 1);

console.log(failures === 0 ? '\nPASS wire validation' : `\nFAIL wire validation (${failures})`);
process.exit(failures === 0 ? 0 : 1);
