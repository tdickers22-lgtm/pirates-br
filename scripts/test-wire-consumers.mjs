#!/usr/bin/env node
// EVERY MESSAGE THE SERVER BROADCASTS REACHES A HUMAN — OR IS DECLARED DARK.
//
// The bug this gate exists for (review-0, P1): lane 1.5 moved the sink announce
// off `crew_eliminated` onto a NEW `ship_sunk` message, and the client's message
// switch never got a case for it. `NetworkClient.handle` has no `default`, so an
// unknown type is DROPPED silently — the commit body's claim that "unknown types
// fall through today" is false. A hull went under and the player saw nothing: no
// line, no counter pulse, no sting. `carpenter_patch` had been dark the same way
// since lane 1.5 slice d, and the suite that graded it monkey-patched
// `match.broadcast` and asserted on the SERVER payload, so it stayed green while
// the player heard nothing.
//
// So the rule is a wiring rule, not a copy rule, and it is checked end to end:
//
//   server emits `type: 'x'` with a payload
//     → NetworkClient has `case 'x':`
//       → the handler that case calls (`this.onX`) is ASSIGNED somewhere in
//         src/client outside NetworkClient itself
//
// A case that fires a callback nobody assigned is exactly as dark as no case.
// Anything genuinely not consumed on purpose goes in KNOWN_DARK with a reason,
// and KNOWN_DARK is itself graded: an entry that HAS been wired up is a failure
// too, so the allowlist cannot rot into a blanket exemption.
//
// Pure text analysis: no stack, no browser, no server. ~0.1 s.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const NETWORK_CLIENT = 'src/client/network/NetworkClient.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

/** Wire messages the client deliberately does not consume, and why. Each entry
 *  is asserted BOTH ways: still produced, still unconsumed. */
const KNOWN_DARK = {
  revive_start: 'Predates this campaign: the reviver\'s progress is read off the '
    + 'snapshot (player.reviveProgress), so the event carries nothing the HUD '
    + 'needs. Left dark deliberately; CREWHUD-01 either uses it or deletes it.',
};

function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (rel.endsWith('.ts')) out.push(rel);
  }
  return out;
}
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// ── 1. The vocabulary: MsgType in shared/types is the only legal set ──────
const typesSrc = read('src/shared/types/index.ts');
const unionStart = typesSrc.indexOf('type MsgType');
const unionEnd = typesSrc.indexOf(';', typesSrc.indexOf('| \'stats_update\''));
const union = typesSrc.slice(unionStart, unionEnd);
const KNOWN_TYPES = new Set([...union.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1]));
expect('the MsgType union parsed', KNOWN_TYPES.size > 30, `parsed ${KNOWN_TYPES.size} types`);

// ── 2. What the server actually puts on the wire ─────────────────────────
// An envelope is `type: '<known>'` with a `payload:` inside the same literal.
// The 400-char window is what keeps prop/entity kinds ('palm_a', 'barrel',
// 'bullet' — same `type:` key, no payload) out of the census.
const produced = new Map();
for (const file of walk('src/server')) {
  const src = read(file);
  for (const m of src.matchAll(/type: '([a-z_]+)'/g)) {
    const t = m[1];
    if (!KNOWN_TYPES.has(t)) continue;
    if (!/payload\s*:/.test(src.slice(m.index, m.index + 400))) continue;
    const line = src.slice(0, m.index).split('\n').length;
    if (!produced.has(t)) produced.set(t, `${file}:${line}`);
  }
}
expect('the server\'s outbound vocabulary was found', produced.size > 20, `${produced.size} message types`);

// ── 3. What the client's switch consumes, and who it hands it to ─────────
const netSrc = read(NETWORK_CLIENT);
expect('NetworkClient still has no `default:` (an unknown type is DROPPED, not '
  + 'forwarded — this is why a missing case is invisible at runtime)',
  !/^\s*default:/m.test(netSrc));

const cases = new Map(); // type -> the case body
const caseRe = /case '([a-z_]+)':/g;
const hits = [...netSrc.matchAll(caseRe)];
for (let i = 0; i < hits.length; i += 1) {
  const from = hits[i].index + hits[i][0].length;
  const to = i + 1 < hits.length ? hits[i + 1].index : netSrc.indexOf('\n  }', from);
  cases.set(hits[i][1], netSrc.slice(from, to));
}

// Every `onFoo` a Game-side file assigns: `network.onFoo =`, `this.onFoo =`, …
const clientFiles = walk('src/client').filter((f) => f !== NETWORK_CLIENT);
const bound = new Set();
for (const file of clientFiles) {
  for (const m of read(file).matchAll(/\.(on[A-Z]\w*)\s*=/g)) bound.add(m[1]);
}
expect('client handler assignments were found', bound.size > 20, `${bound.size} handlers bound`);

// ── 4. The rule ──────────────────────────────────────────────────────────
console.log('\nEvery broadcast message type has a client consumer');
for (const [type, where] of [...produced].sort()) {
  if (type in KNOWN_DARK) continue;
  const body = cases.get(type);
  if (!body) {
    expect(`'${type}' has a case in NetworkClient`, false,
      `broadcast at ${where}; no \`case '${type}':\` in ${NETWORK_CLIENT} — the payload is dropped on arrival`);
    continue;
  }
  expect(`'${type}' has a case in NetworkClient`, true);
  const handlers = [...body.matchAll(/this\.(on[A-Z]\w*)/g)].map((m) => m[1]);
  if (handlers.length === 0) continue; // handled inline (pong, lobby_left, …)
  expect(`'${type}' hands off to a handler something in src/client assigns`,
    handlers.some((h) => bound.has(h)),
    `case calls ${handlers.join('/')}; nothing outside ${NETWORK_CLIENT} assigns it, so the callback is null and the message dies in the switch`);
}

console.log('\nThe dark list is honest');
for (const [type, why] of Object.entries(KNOWN_DARK)) {
  expect(`'${type}' is still produced by the server (a stale exemption is a lie)`,
    produced.has(type), why);
  expect(`'${type}' is still unconsumed (wire it up, then delete the exemption)`,
    !cases.has(type), why);
}

console.log(failures === 0
  ? `\nPASS — ${produced.size} broadcast types, ${Object.keys(KNOWN_DARK).length} declared dark`
  : `\nFAIL — ${failures} wire message(s) with no consumer`);
process.exit(failures === 0 ? 0 : 1);
