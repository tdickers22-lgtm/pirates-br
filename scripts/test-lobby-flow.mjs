#!/usr/bin/env node
/**
 * THE LOBBY STATE MACHINE, against a real LobbyServer over real sockets.
 *
 * Everything a crew does before and between matches — create, join, ready,
 * kick, hand over the crown, start, come back from the horn, play again — ran
 * with ZERO test coverage while the file changed in eleven commits (netcode-18).
 * The bugs that hid in there are all shape-of-the-state-machine bugs, invisible
 * to a unit test of any single handler and invisible to a human who does not
 * happen to read the scoreboard for 25 seconds:
 *
 *   netcode-04  the 25 s end-screen auto-detach dissolved the party under the
 *               crew's feet, so "Play Again with Crew" was a silent no-op
 *   netcode-26  party.inMatch latched TRUE forever (removeFromParty cleared
 *               session.partyCode BEFORE the clear read it), so a friend with
 *               the code got "Crew is already at sea" for the process lifetime
 *   netcode-37  the crown was handed to members[0] whoever that was, so it
 *               could land on a member still at sea while the one person
 *               sitting in the lobby had Start disabled
 *   netcode-38  reapMatch set state 'menu' but kept partyCode, never cleared
 *               inMatch and never sent lobby_left — a second, independent
 *               source of the same stuck party
 *   netcode-14  handleStartMatch never read inMatch, so an early returner
 *               launched a SECOND match while their crew was still at sea
 *   netcode-15  a cohort member whose socket had already closed was still
 *               given a hull, a dock and a colour: a ghost target
 *   netcode-16  a friend refused with "at sea" was never told when the crew
 *               got back (server half: the waiters map + party_available)
 *   netcode-17  match_start.expectedHumans / botCount were fiction
 *   netcode-23  no ready state, no kick, no host transfer, 4-char codes
 *
 * NEVER port 8080 on this machine: a content filter there replays the upgrade
 * bytes and corrupts every websocket. This suite asks the kernel for a port
 * (init(0)) exactly as test-net-resilience does, so it can never collide with
 * the 8091 stack or a human's 8090.
 *
 * The suite turns the lobby's clocks down through `LobbyServer.tunables`
 * instead of sleeping through 25 s + 60 s + 30 s of production timers.
 */
import { WebSocket } from 'ws';
import { LobbyServer } from '../src/server/core/LobbyServer.ts';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`);
    failures += 1;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

LobbyServer.tunables.endedMatchDetachMs = 400;
LobbyServer.tunables.matchGcAfterEndMs = 60_000;
LobbyServer.tunables.hostForceStartMs = 10_000;
LobbyServer.tunables.joinLockoutMs = 1_000;

const server = new LobbyServer();
server.init(Number(process.env.PIRATES_BR_TEST_PORT ?? 0));
for (let i = 0; i < 50 && server.boundPort == null; i += 1) await sleep(100);
if (server.boundPort == null) throw new Error('LobbyServer never reported a bound port');
const WS_URL = `ws://127.0.0.1:${server.boundPort}/ws`;

/** A named socket that keeps every message it was sent. */
async function pirate(name) {
  const ws = new WebSocket(WS_URL);
  const msgs = [];
  let closeCode = null;
  ws.on('message', (data) => {
    try { msgs.push(JSON.parse(data.toString())); } catch { /* ignore */ }
  });
  ws.on('close', (code) => { closeCode = code; });
  ws.on('error', () => {});
  await new Promise((resolve) => ws.once('open', resolve));
  await new Promise((resolve) => setTimeout(resolve, 60));
  // Read the id ONCE, off welcome: forget() clears the message log and a
  // clientId derived from it would go undefined halfway through a section.
  const clientId = msgs.find((m) => m.type === 'welcome')?.payload?.clientId;
  const c = {
    name, ws, msgs, clientId,
    get closeCode() { return closeCode; },
    of: (type) => [...msgs].reverse().find((m) => m.type === type),
    all: (type) => msgs.filter((m) => m.type === type),
    saw: (type) => msgs.some((m) => m.type === type),
    forget: () => { msgs.length = 0; },
    send: (type, payload = {}) => { try { ws.send(JSON.stringify({ type, ts: Date.now(), payload })); } catch {} },
    session: () => server.clients.get(c.clientId),
  };
  c.send('set_name', { name });
  await sleep(80);
  return c;
}

const crews = [];
async function crew(...names) {
  const members = [];
  for (const n of names) members.push(await pirate(n));
  crews.push(members);
  return members;
}

/** Everybody home, every match stopped — sections must not leak sims. */
async function scuttle() {
  for (const members of crews.splice(0)) {
    for (const c of members) { try { c.ws.close(); } catch {} }
  }
  await sleep(200);
  for (const [id, match] of Array.from(server.matches)) {
    try { match.stop(); } catch {}
    server.matches.delete(id);
  }
}

const partyOf = (c) => server.parties.get(c.session()?.partyCode ?? '');
const roster = (c) => c.of('lobby_update')?.payload;
const errorText = (c) => c.of('lobby_error')?.payload?.reason ?? '';

/** The end horn, without playing eight minutes of battle royale: the same
 *  emitMatchEnd the last-ship check calls, so the lobby's onMatchEnd runs for
 *  real (stats, state flip to 'match_ended', endedMatchSince). */
function forceEnd(match) {
  match.state.phase = 'ended';
  match.endedAt = Date.now();
  match.endReason = 'last_ship';
  match.emitMatchEnd();
}

const liveMatches = () => server.matches.size;
/** The match just spawned — an ENDED match lingers until its GC, so "the" match
 *  is the newest one (Map keeps insertion order). */
const onlyMatch = () => [...server.matches.values()].at(-1);

/** Host starts; members must be Ready first (PLAN 2.2). */
async function launch(host, ...others) {
  for (const o of others) { o.send('party_ready', { ready: true }); }
  await sleep(120);
  host.send('start_match');
  await sleep(600);
  return onlyMatch();
}

// ── 1. Codes ────────────────────────────────────────────────────
console.log('A party code a human can read down a phone line:');
{
  const [a] = await crew('Anne');
  a.send('create_party');
  await sleep(120);
  const code = roster(a)?.code ?? '';
  expect('the code is six characters (netcode-23)', code.length === 6, `code=${code}`);
  expect('the code never uses I O 0 1 (netcode-23)', /^[A-HJ-NP-Z2-9]+$/.test(code), `code=${code}`);

  const [b] = await crew('Bess');
  for (let i = 0; i < 5; i += 1) { b.send('join_party', { code: 'ZZZZZZ' }); await sleep(40); }
  b.forget();
  b.send('join_party', { code: 'ZZZZZZ' });
  await sleep(120);
  expect('five wrong codes buy a lockout (netcode-23)', /too many|slow down|wait/i.test(errorText(b)),
    `reason="${errorText(b)}"`);
  b.forget();
  b.send('join_party', { code });
  await sleep(120);
  expect('the lockout also refuses a code that DOES exist', !b.saw('lobby_update'), 'joined while locked out');
  await sleep(1_100);
  b.send('join_party', { code });
  await sleep(150);
  expect('the lockout expires and a real code still works', roster(b)?.members?.length === 2,
    JSON.stringify(roster(b)?.members ?? null));
  await scuttle();
}

// ── 2. Ready / kick / crown ─────────────────────────────────────
console.log('\nThe roster is an Among-Us roster:');
{
  const [a, b, c] = await crew('Anne', 'Bess', 'Cutty');
  a.send('create_party');
  await sleep(120);
  const code = roster(a).code;
  b.send('join_party', { code });
  c.send('join_party', { code });
  await sleep(200);
  expect('every member carries a ready flag (netcode-23)',
    roster(a)?.members?.every((m) => typeof m.ready === 'boolean') === true,
    JSON.stringify(roster(a)?.members ?? null));
  expect('Start is refused while a mate has not readied (netcode-23)', roster(a)?.canStart === false,
    `canStart=${roster(a)?.canStart}`);
  b.send('party_ready', { ready: true });
  c.send('party_ready', { ready: true });
  await sleep(200);
  expect('the crew all ready ⇒ the host may start', roster(a)?.canStart === true,
    `canStart=${roster(a)?.canStart} members=${JSON.stringify(roster(a)?.members ?? null)}`);

  c.forget();
  b.send('party_kick', { clientId: c.clientId });
  await sleep(150);
  expect('only the host may kick (netcode-23)', partyOf(a)?.members?.length === 3,
    `members=${partyOf(a)?.members?.length}`);
  a.send('party_kick', { clientId: c.clientId });
  await sleep(180);
  expect('the host kicks a mate out of the crew (netcode-23)', partyOf(a)?.members?.length === 2,
    `members=${partyOf(a)?.members?.length}`);
  expect('the kicked pirate is told they left', c.saw('lobby_left'), JSON.stringify(c.msgs.map((m) => m.type)));

  a.send('party_transfer_host', { clientId: b.clientId });
  await sleep(150);
  expect('the crown can be handed over on purpose (netcode-23)',
    roster(b)?.members?.find((m) => m.clientId === b.clientId)?.isHost === true,
    `hostId=${roster(b)?.hostId} b=${b.clientId}`);
  await scuttle();
}

// ── 3. netcode-04 — the scoreboard does not dissolve the crew ───
console.log('\nA crew that reads the scoreboard is still a crew:');
{
  const [a, b] = await crew('Anne', 'Bess');
  a.send('create_party');
  await sleep(120);
  const code = roster(a).code;
  b.send('join_party', { code });
  await sleep(150);
  const match = await launch(a, b);
  expect('the party sailed', !!match && match.humanCount() === 2, `humans=${match?.humanCount()}`);
  expect('match_start tells the truth about the crew size (netcode-17)',
    a.of('match_start')?.payload?.expectedHumans === 2 && b.of('match_start')?.payload?.expectedHumans === 2,
    `a=${a.of('match_start')?.payload?.expectedHumans} b=${b.of('match_start')?.payload?.expectedHumans}`);

  forceEnd(match);
  await sleep(120);
  expect('the horn closes the world-build window it opened (netcode-15)',
    a.session()?.matchJoinedAt === undefined, `matchJoinedAt=${a.session()?.matchJoinedAt}`);
  a.forget(); b.forget();
  await sleep(1_600); // the 25 s auto-detach, turned down to 400 ms
  expect('the idle crew is detached TO THE PARTY, not to the main menu (netcode-04)',
    a.session()?.state === 'party' && b.session()?.state === 'party',
    `a=${a.session()?.state} b=${b.session()?.state}`);
  expect('the party still has both hands after the auto-detach (netcode-04)',
    server.parties.get(code)?.members?.length === 2,
    `party=${JSON.stringify(server.parties.get(code)?.members ?? null)}`);
  expect('the auto-detach says why (match_detached)', a.saw('match_detached'),
    JSON.stringify(a.msgs.map((m) => m.type)));
  expect('the crew who never left the panel is not the crew at sea (netcode-26)',
    server.parties.get(code)?.inMatch === false, `inMatch=${server.parties.get(code)?.inMatch}`);

  const second = await launch(a, b);
  expect('Play Again with Crew really sails again (netcode-04)', !!second && second.humanCount() === 2,
    `matches=${liveMatches()} humans=${second?.humanCount()}`);
  await scuttle();
}

// ── 4. netcode-26 — the latch ───────────────────────────────────
console.log('\nThe crew is back, so the code works again:');
{
  const [a, b] = await crew('Anne', 'Bess');
  a.send('create_party');
  await sleep(120);
  const code = roster(a).code;
  b.send('join_party', { code });
  await sleep(150);
  LobbyServer.tunables.endedMatchDetachMs = 60_000; // nobody is auto-detached here
  const match = await launch(a, b);
  forceEnd(match);
  await sleep(150);
  a.send('play_again');       // A goes back to the panel first
  await sleep(200);
  b.send('return_to_menu');   // B, the last one at sea, goes home
  await sleep(250);
  expect('the last sailor home clears the at-sea latch (netcode-26)',
    server.parties.get(code)?.inMatch === false, `inMatch=${server.parties.get(code)?.inMatch}`);

  const [c] = await crew('Cutty');
  c.send('join_party', { code });
  await sleep(200);
  expect('a friend with the code can now join (netcode-26)', roster(c)?.code === code,
    `reason="${errorText(c)}"`);
  LobbyServer.tunables.endedMatchDetachMs = 400;
  await scuttle();
}

// ── 5. netcode-16 server half — the waiter ──────────────────────
console.log('\nThe friend refused at the door is called back:');
{
  const [a, b] = await crew('Anne', 'Bess');
  a.send('create_party');
  await sleep(120);
  const code = roster(a).code;
  b.send('join_party', { code });
  await sleep(150);
  LobbyServer.tunables.endedMatchDetachMs = 400;
  const match = await launch(a, b);
  const [c] = await crew('Cutty');
  c.send('join_party', { code });
  await sleep(150);
  expect('a code join while the crew is at sea is refused with a reason',
    /at sea/i.test(errorText(c)), `reason="${errorText(c)}"`);
  c.forget();
  forceEnd(match);
  await sleep(1_800);
  expect('the waiter is told the moment the crew is back (netcode-16)',
    c.of('party_available')?.payload?.code === code,
    JSON.stringify(c.msgs.map((m) => m.type)));
  await scuttle();
}

// ── 6. netcode-14 — no second match while the crew is at sea ────
console.log('\nNobody sails a second ship while the crew is still out:');
{
  const [a, b] = await crew('Anne', 'Bess');
  a.send('create_party');
  await sleep(120);
  b.send('join_party', { code: roster(a).code });
  await sleep(150);
  LobbyServer.tunables.endedMatchDetachMs = 60_000;
  const match = await launch(a, b);
  forceEnd(match);
  await sleep(150);
  a.send('play_again');
  await sleep(200);
  const before = liveMatches();
  a.forget();
  a.send('start_match');
  await sleep(500);
  expect('Start is refused while a crewmate is still at sea (netcode-14)',
    liveMatches() === before, `matches ${before} → ${liveMatches()}`);
  expect('and the refusal names the stragglers (netcode-14)', /at sea/i.test(errorText(a)),
    `reason="${errorText(a)}"`);
  expect('the roster shows who is still out (netcode-14)',
    Array.isArray(roster(a)?.membersAtSea) && roster(a).membersAtSea.length === 1,
    `membersAtSea=${JSON.stringify(roster(a)?.membersAtSea ?? null)}`);
  a.send('start_match', { force: true });
  await sleep(600);
  expect('the host may force the launch anyway (netcode-14)', liveMatches() === before + 1,
    `matches ${before} → ${liveMatches()}`);
  LobbyServer.tunables.endedMatchDetachMs = 400;
  await scuttle();
}

// ── 7. netcode-37 — the crown lands where somebody can press Start ─
console.log('\nThe crown lands on somebody who is in the room:');
{
  const [a, b, c] = await crew('Anne', 'Bess', 'Cutty');
  a.send('create_party');
  await sleep(120);
  const code = roster(a).code;
  b.send('join_party', { code });
  c.send('join_party', { code });
  await sleep(200);
  LobbyServer.tunables.endedMatchDetachMs = 60_000;
  const match = await launch(a, b, c);
  forceEnd(match);
  await sleep(150);
  c.send('play_again');       // only C is back in the panel
  await sleep(200);
  c.forget();
  a.send('return_to_menu');   // the host leaves for the main menu
  await sleep(250);
  const party = server.parties.get(code);
  expect('the crown goes to the member sitting in the lobby, not the one at sea (netcode-37)',
    party?.hostId === c.clientId,
    `hostId=${party?.hostId} B=${b.clientId} C=${c.clientId}`);
  expect('and the new host is told (lobby_update isHost)',
    roster(c)?.members?.find((m) => m.clientId === c.clientId)?.isHost === true,
    JSON.stringify(roster(c)?.members ?? null));
  LobbyServer.tunables.endedMatchDetachMs = 400;
  await scuttle();
}

// ── 8. netcode-38 — a reap is a full detach ─────────────────────
console.log('\nA reaped match sends its crew home properly:');
{
  const [a, b] = await crew('Anne', 'Bess');
  a.send('create_party');
  await sleep(120);
  const code = roster(a).code;
  b.send('join_party', { code });
  await sleep(150);
  LobbyServer.tunables.endedMatchDetachMs = 3_600_000; // the auto-detach must NOT do this job
  LobbyServer.tunables.matchGcAfterEndMs = 200;
  const match = await launch(a, b);
  forceEnd(match);
  a.forget(); b.forget();
  await sleep(1_800);
  expect('the match was reaped', liveMatches() === 0, `matches=${liveMatches()}`);
  expect('a reaped session is told it left the match (netcode-38)', a.saw('lobby_left') || a.saw('match_detached'),
    JSON.stringify(a.msgs.map((m) => m.type)));
  expect('a reaped session keeps its socket instead of being cut off (netcode-38)',
    a.ws.readyState === WebSocket.OPEN, `closeCode=${a.closeCode}`);
  expect('the reaped crew is back in its party panel, not locked at sea (netcode-38)',
    server.parties.get(code)?.members?.length === 2 && server.parties.get(code)?.inMatch === false,
    `party=${JSON.stringify(server.parties.get(code) ?? null)}`);
  LobbyServer.tunables.matchGcAfterEndMs = 60_000;
  LobbyServer.tunables.endedMatchDetachMs = 400;
  await scuttle();
}

// ── 9. netcode-15 — a closed socket gets no hull ────────────────
console.log('\nA socket that is already gone gets no ship:');
{
  const [a, b] = await crew('Anne', 'Bess');
  a.send('create_party');
  await sleep(120);
  b.send('join_party', { code: roster(a).code });
  await sleep(150);
  b.send('party_ready', { ready: true });
  await sleep(120);
  // B's tab closed in the same second the host pressed Start: the session is
  // still on the roster, its socket is not OPEN any more.
  const dead = { readyState: WebSocket.CLOSING, send() {}, close() {}, ping() {}, terminate() {}, on() {}, once() {}, removeListener() {} };
  b.session().ws = dead;
  a.send('start_match');
  await sleep(700);
  const match = onlyMatch();
  const humanNames = match ? match.state.players.filter((p) => !p.isBot).map((p) => p.name) : [];
  expect('a member whose socket is closed is not given a hull (netcode-15)',
    humanNames.length === 1 && humanNames[0] === 'Anne', `humans=${JSON.stringify(humanNames)}`);
  await scuttle();
}

// ── 9. The public queue pools CREWS (MODE-01: netcode-11, gameplay-31) ──
//
// Before this, six friends who each pressed Play within 20 s of one another got
// THREE separate matches of two humans and eight bots: the launch rule was "2
// humans once 5 s have elapsed" over a 15 s timer that started at the FIRST
// joiner and was never reset (LobbyServer 640-646, 472-474). The north star
// asks that the game be easy to run online with only real players, and the
// queue actively prevented it. The soft wait now holds the door open for a real
// minimum of crews; the hard wait is the empty-server fallback that still fills
// with bots so a lone captain is never stranded in a lobby.
console.log('\nThe queue pools crews instead of firing in pairs:');
LobbyServer.tunables.queueSoftWaitSeconds = 1.6;
LobbyServer.tunables.queueHardWaitSeconds = 3.2;
{
  const six = await crew('Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6');
  for (const c of six) { c.send('queue_join', { mode: 'solo' }); await sleep(180); }
  // Still inside the soft wait: nobody has sailed without the others.
  expect('the queue does not fire in pairs while friends are still arriving (gameplay-31)',
    liveMatches() === 0, `matches=${liveMatches()}`);
  await sleep(1_600);
  expect('six captains 180 ms apart land in ONE match (netcode-11)',
    liveMatches() === 1, `matches=${liveMatches()}`);
  const match = onlyMatch();
  const humans = match ? match.state.players.filter((p) => !p.isBot).length : 0;
  expect('all six are in it', humans === 6, `humans=${humans}`);
  const start = six[0].of('match_start')?.payload ?? {};
  expect('match_start.expectedHumans is the real cohort, not "so far" (netcode-17)',
    start.expectedHumans === 6, JSON.stringify(start));
  const botsAboard = match ? match.state.players.filter((p) => p.isBot).length : -1;
  expect('match_start.botCount is the real bot fill, not the literal 0 (netcode-17)',
    typeof start.botCount === 'number' && start.botCount > 0 && start.botCount === botsAboard,
    `botCount=${start.botCount} bots=${botsAboard}`);
  const q = six[0].of('queue_update')?.payload ?? {};
  expect('the queue line promises the number it actually waits for (netcode-11)',
    q.needed === 6, JSON.stringify(q));
  await scuttle();
}

{
  // The empty server: one captain, nobody else coming. The hard wait still
  // launches her with a bot fleet — "every human still gets a hull in Solo".
  const [lone] = await crew('Alone');
  lone.send('queue_join', { mode: 'solo' });
  await sleep(2_000);
  expect('one captain does not sail before the soft wait has passed',
    liveMatches() === 0, `matches=${liveMatches()}`);
  // The dispatcher runs on the lobby's 1 s tick, so allow one tick past the
  // hard wait rather than sampling exactly on it.
  await sleep(2_600);
  expect('the hard wait still launches a lone captain with bots',
    liveMatches() === 1, `matches=${liveMatches()}`);
  const match = onlyMatch();
  expect('she is not alone in the world',
    !!match && match.state.players.filter((p) => p.isBot).length >= 8,
    `bots=${match ? match.state.players.filter((p) => p.isBot).length : 0}`);
  await scuttle();
}

{
  // Backfill: a crew that presses Play during the pre-horn countdown joins the
  // match that is standing off the dock, instead of opening a second lobby.
  const four = await crew('B1', 'B2', 'B3', 'B4');
  for (const c of four) c.send('queue_join', { mode: 'solo' });
  await sleep(2_000);
  await sleep(2_600);
  expect('the four sailed', liveMatches() === 1, `matches=${liveMatches()}`);
  const first = onlyMatch();
  const late = await pirate('Late');
  crews.push([late]);
  late.send('queue_join', { mode: 'solo' });
  await sleep(400);
  expect('a late captain backfills the match still in its countdown, not a new one',
    liveMatches() === 1, `matches=${liveMatches()}`);
  expect('and she is really aboard that same match',
    !!first && first.state.players.some((p) => !p.isBot && p.name === 'Late'),
    first ? first.state.players.filter((p) => !p.isBot).map((p) => p.name).join(',') : 'no match');
  await scuttle();
}

{
  // A party queues as ONE crew, and the roster rules of PLAN 2.1 are enforced
  // at the door rather than at the dock.
  const [host, mate, third] = await crew('Cap', 'Mate', 'Third');
  host.send('create_party');
  await sleep(120);
  const code = roster(host).code;
  mate.send('join_party', { code });
  third.send('join_party', { code });
  await sleep(200);
  host.send('update_party_settings', { mode: 'duos' });
  await sleep(120);
  host.forget();
  host.send('queue_join', { mode: 'duos' });
  await sleep(200);
  expect('a party of three is refused Duos with the mode that fits (PLAN 2.1)',
    /duos takes 2/i.test(errorText(host)), `reason="${errorText(host)}"`);
  expect('and nothing was launched', liveMatches() === 0, `matches=${liveMatches()}`);
  host.forget();
  host.send('queue_join', { mode: 'squads' });
  await sleep(200);
  expect('squads is refused while it is behind WIRE-01, in words a player understands',
    /squads/i.test(errorText(host)) && /not open|soon|yet/i.test(errorText(host)),
    `reason="${errorText(host)}"`);
  await scuttle();
}
{
  // ── 10. ONE CREW, ONE HULL (MODE-01 slice c, netcode-21's lobby half) ─────
  // CREW-01 built the crew: one ship for a party of N, DBNO, revive, the
  // station arbiter, crewGold, a crew-keyed win check. NOTHING in production
  // reached it: LobbyServer placed every session on its own through
  // createHumanClient, so a party of two sailed out as TWO ENEMY SLOOPS and a
  // duos queue of nine crews would have put eighteen hulls to sea.
  const [cap, mate] = await crew('Pair1', 'Pair2');
  cap.send('create_party');
  await sleep(120);
  const code = roster(cap).code;
  mate.send('join_party', { code });
  await sleep(200);
  cap.send('update_party_settings', { mode: 'duos', botFill: 3 });
  await sleep(120);
  mate.send('party_ready', { ready: true });
  await sleep(160);
  cap.send('start_match', { force: true });
  await sleep(600);
  const match = onlyMatch();
  const humans = match ? match.state.players.filter((p) => !p.isBot) : [];
  expect('a party of two sails ONE hull, not two enemy sloops',
    humans.length === 2 && new Set(humans.map((p) => p.shipId)).size === 1,
    `humans=${humans.length} hulls=${new Set(humans.map((p) => p.shipId)).size}`);
  const hull = match?.state.ships.find((sh) => sh.id === humans[0]?.shipId);
  expect('and she is the Corsair a pair is handed (hullForCrewSize(2))',
    hull?.type === 'brigantine', `type=${hull?.type}`);
  expect('the hull knows her whole crew, so a crewmate\'s pistol passes through',
    !!hull && humans.every((p) => hull.crewIds.includes(p.id)),
    `crewIds=${hull?.crewIds?.length}`);
  expect('both mates are in the same crew record',
    !!match && (match.state.crews ?? []).some((cw) => humans.every((p) => cw.memberIds.includes(p.id))),
    `crews=${(match?.state.crews ?? []).length}`);
  expect('the bot fleet she meets is crewed for the mode too (Corsairs, two hands)',
    !!match && match.state.ships.filter((sh) => sh.id !== hull?.id)
      .every((sh) => sh.type === 'brigantine'),
    (match?.state.ships ?? []).map((sh) => sh.type).join(','));
  await scuttle();
}

{
  // The same rule through the PUBLIC queue: two crews of two are two hulls in
  // one duos match, and the fleet never exceeds the mode's size.
  const [a1, a2] = await crew('Qa1', 'Qa2');
  const [b1, b2] = await crew('Qb1', 'Qb2');
  for (const [host, mate] of [[a1, a2], [b1, b2]]) {
    host.send('create_party');
    await sleep(120);
    mate.send('join_party', { code: roster(host).code });
    await sleep(160);
    host.send('update_party_settings', { mode: 'duos' });
    await sleep(120);
    host.send('queue_join', { mode: 'duos' });
    await sleep(120);
  }
  await sleep(4_200);
  expect('two duos crews land in ONE match', liveMatches() === 1, `matches=${liveMatches()}`);
  const qm = onlyMatch();
  const qHumans = qm ? qm.state.players.filter((p) => !p.isBot) : [];
  expect('all four sailed, on TWO hulls (not four)',
    qHumans.length === 4 && new Set(qHumans.map((p) => p.shipId)).size === 2,
    `humans=${qHumans.length} hulls=${new Set(qHumans.map((p) => p.shipId)).size}`);
  expect('the fleet is the mode\'s fleet, never bigger (duos = 9 hulls)',
    !!qm && qm.state.ships.length <= 9, `ships=${qm?.state.ships.length}`);
  await scuttle();
}

LobbyServer.tunables.queueSoftWaitSeconds = 45;
LobbyServer.tunables.queueHardWaitSeconds = 90;

await sleep(200);
if (failures > 0) {
  console.error(`\n${failures} lobby-flow assertion(s) failed.`);
  process.exit(1);
}
console.log('\nAll lobby-flow assertions passed.');
process.exit(0);
