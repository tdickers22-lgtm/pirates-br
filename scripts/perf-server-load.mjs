#!/usr/bin/env node
// N MATCHES ON ONE PROCESS — does the sim still make its tick, and is the
// (N+1)th crew TOLD, or quietly served a broken game? (ONLINE-01 phase 2,
// netcode-24.)
//
// A host degrades by dropping ticks, and it drops them for EVERYBODY at once:
// the thirteenth match does not make the thirteenth game bad, it makes all
// thirteen slow. Nothing measured where that line is and nothing refused a
// crew above it, so the only visible symptom online would have been every
// player on the box reporting lag at the same time.
//
// This drives a real LobbyServer over real sockets: N solo matches, a settling
// window, then the numbers off /health, then one more crew that must be refused
// with a message (and must keep its session).
//
//   PIRATES_BR_LOAD_MATCHES=8   how many matches to stand up  (default 8)
//   PIRATES_BR_LOAD_SECONDS=12  measurement window in seconds (default 12)
//
// Server-side only: no browser, no GPU, no render tier is affected by anything
// this grades. Measured on the owner's Air at N=8: see the printed table.
import { WebSocket } from 'ws';

const N = Number(process.env.PIRATES_BR_LOAD_MATCHES ?? 8);
const WINDOW_SEC = Number(process.env.PIRATES_BR_LOAD_SECONDS ?? 12);
/** The whole point of the ceiling: above this the sim is not keeping up. */
const WORST_SIM_LAG_BUDGET_SEC = 0.1;

// Read BEFORE importing the server: the ceiling is a module-load constant.
process.env.PIRATES_BR_MAX_MATCHES = String(N);
const { LobbyServer } = await import('../src/server/core/LobbyServer.ts');

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = new LobbyServer();
server.init(0);
for (let i = 0; i < 50 && server.boundPort == null; i += 1) await sleep(100);
if (server.boundPort == null) throw new Error('LobbyServer never reported a bound port');
const PORT = server.boundPort;

function open(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const seen = [];
  const errors = [];
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      seen.push(msg.type);
      if (msg.type === 'lobby_error') errors.push(msg.payload?.reason ?? '');
    } catch { seen.push('<unparsed>'); }
  });
  ws.on('error', () => {});
  const send = (msg) => { try { ws.send(JSON.stringify(msg)); } catch {} };
  return {
    ws, seen, errors, name,
    ready: new Promise((resolve) => ws.once('open', resolve)),
    send,
    async joinSolo(bots) {
      send({ type: 'set_name', ts: Date.now(), payload: { name } });
      await sleep(30);
      send({ type: 'solo_start', ts: Date.now(), payload: { botCount: bots } });
    },
  };
}

async function health() {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  return { status: res.status, body: await res.json() };
}

console.log(`Server load: ${N} matches on one process, ${WINDOW_SEC}s window`);

// ── Stand up N matches ─────────────────────────────────────────────────────
const clients = [];
const buildStart = Date.now();
for (let i = 0; i < N; i += 1) {
  const c = open(`Load${i}`);
  clients.push(c);
  await c.ready;
  await c.joinSolo(3);
  // Serialised on purpose: world generation is synchronous, and firing N of
  // them into the same tick would measure the build, not the steady state.
  await sleep(400);
}
for (let i = 0; i < 60 && (await health()).body.matches < N; i += 1) await sleep(500);
const built = await health();
console.log(`  built ${built.body.matches}/${N} matches in ${((Date.now() - buildStart) / 1000).toFixed(1)}s`);
expect(`${N} matches are live on one process`, built.body.matches === N, JSON.stringify(built.body));

// ── Let them run, then read the sim ────────────────────────────────────────
await sleep(WINDOW_SEC * 1000);
const loaded = await health();
const worst = loaded.body.worstSimLagSec;
const dropped = loaded.body.droppedTicks;
console.log(`  worstSimLagSec ${worst}  droppedTicks ${dropped}  clients ${loaded.body.clients}`);
expect(`worstSimLagSec < ${WORST_SIM_LAG_BUDGET_SEC} at ${N} matches`,
  typeof worst === 'number' && worst < WORST_SIM_LAG_BUDGET_SEC,
  `worst=${worst} — this host cannot carry ${N} matches; lower PIRATES_BR_MAX_MATCHES`);
expect('/health answers 200 while healthy', loaded.status === 200);

// ── The ceiling refuses, and says so ───────────────────────────────────────
expect('/health reports the ceiling', loaded.body.maxMatches === N, `${loaded.body.maxMatches}`);
expect('/health says the host has stopped accepting', loaded.body.accepting === false,
  JSON.stringify({ accepting: loaded.body.accepting, matches: loaded.body.matches }));

const overflow = open('Overflow');
await overflow.ready;
await overflow.joinSolo(3);
await sleep(800);
expect('the crew above the ceiling is told, not silently dropped',
  overflow.errors.some((m) => /full/i.test(m)), JSON.stringify(overflow.errors));
expect('the refused crew never got a match', !overflow.seen.includes('join'), overflow.seen.join(','));
expect('the refused crew keeps its socket', overflow.ws.readyState === WebSocket.OPEN);
const after = await health();
expect('a refusal starts no match', after.body.matches === N, `${after.body.matches}`);

// ── The wire validator is visible from outside ─────────────────────────────
const before = after.body.rejectedFrames;
overflow.send({ type: 'state_snapshot', ts: Date.now(), payload: {} });
overflow.send({ type: 'solo_start', ts: Date.now(), payload: [] });
await sleep(300);
const counted = await health();
expect('/health counts refused frames', counted.body.rejectedFrames >= before + 2,
  `${before} → ${counted.body.rejectedFrames}`);

for (const c of [...clients, overflow]) { try { c.ws.close(); } catch {} }
await server.shutdown?.();
console.log(failures === 0 ? '\nPASS server load' : `\nFAIL server load (${failures})`);
process.exit(failures === 0 ? 0 : 1);
