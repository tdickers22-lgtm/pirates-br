#!/usr/bin/env node
// DEV HOOKS GATE (DEV-01) — are dev_grant_gold / dev_bot_peace refused unless
// the server opted in, and do lifetime stats ignore a dev-assisted match?
//
// Before DEV-01 both hooks were honoured on ANY server with one human in the
// match (a public-queue solo fallback included) and the 9000 g win they hand
// out went into the persistent stats file. Now Match honours them only with
// PIRATES_BR_DEV_HOOKS=1 (the test runner sets it) or MatchOptions.devHooks,
// marks the match devAssisted, and StatsStore.applyMatchResult skips such a
// match entirely.
//
// Can it fail? PIRATES_BR_DEV_HOOKS=1 node --import tsx scripts/test-dev-hooks.mjs
// turns the refusal checks red (the env default honours the hooks).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { Match } = await import('../src/server/core/Match.ts');
const { StatsStore } = await import('../src/server/core/StatsStore.ts');
const { ECONOMY } = await import('../src/shared/constants/index.ts');

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✓' : '✗'} ${msg}`); if (!cond) fails++; };
const envSet = process.env.PIRATES_BR_DEV_HOOKS === '1';
console.log(`PIRATES_BR_DEV_HOOKS is ${envSet ? 'SET (mutation: refusals must go red)' : 'unset'}`);

/** A one-human match driven straight through handleMessage — no socket. */
function soloMatch(opts) {
  const match = new Match({ matchId: `devhooks-${opts.devHooks ?? 'env'}`, botCount: 0, ...opts });
  const state = match['state'];
  state.phase = 'playing';
  const player = match['createPlayer']('human-1', 'Tester', null, false);
  state.players.push(player);
  match['playersById'].set(player.id, player);
  const client = { ws: null, playerId: player.id, name: 'Tester', lastInput: null, joinedAt: 0, killsAtJoin: 0, deathsAtJoin: 0 };
  const send = (type, payload) => match['handleMessage'](client, { type, ts: 0, payload });
  return { match, player, send };
}

// 1. Default (env decides): refused when unset.
{
  const { match, player, send } = soloMatch({});
  const before = player.gold;
  send('dev_grant_gold', { gold: 5000 });
  ok(player.gold === before, `env unset: dev_grant_gold leaves gold at ${before} (got ${player.gold})`);
  send('dev_bot_peace', { enabled: true });
  ok(match['botPeace'] === false, 'env unset: dev_bot_peace leaves botPeace false');
  ok(match['devAssisted'] === false, 'env unset: the match is not marked devAssisted');
}
// 2. Opted in via MatchOptions: honoured, clamped, and the match is marked.
{
  const { match, player, send } = soloMatch({ devHooks: true });
  send('dev_grant_gold', { gold: 5000 });
  ok(player.gold === 5000, `devHooks: dev_grant_gold sets gold to 5000 (got ${player.gold})`);
  send('dev_grant_gold', { gold: 1e9 });
  ok(player.gold === ECONOMY.GOLD_WIN_TARGET * 2, `devHooks: gold clamps to GOLD_WIN_TARGET*2 = ${ECONOMY.GOLD_WIN_TARGET * 2} (got ${player.gold})`);
  send('dev_bot_peace', { enabled: true });
  ok(match['botPeace'] === true, 'devHooks: dev_bot_peace flips botPeace on');
  ok(match['devAssisted'] === true, 'devHooks: the match is marked devAssisted');
}
// 3. Opted OUT explicitly beats the env (a production LobbyServer can pin false).
{
  const { player, send } = soloMatch({ devHooks: false });
  send('dev_grant_gold', { gold: 5000 });
  ok(player.gold === 0, `devHooks:false refuses even when the env is set (gold ${player.gold})`);
}
// 4. Lifetime stats ignore a dev-assisted match, count a real one.
{
  const dir = mkdtempSync(join(tmpdir(), 'pirates-stats-'));
  const store = new StatsStore(join(dir, 'stats.json'));
  const base = { name: 'Tester', kills: 3, deaths: 1, gold: 9000, placement: 1, isWinner: true };
  const assisted = store.applyMatchResult({ ...base, devAssisted: true });
  ok(assisted.totalGold === 0 && assisted.wins === 0 && assisted.matchesPlayed === 0 && assisted.kills === 0,
    `devAssisted match adds nothing (gold ${assisted.totalGold}, wins ${assisted.wins}, played ${assisted.matchesPlayed}, kills ${assisted.kills})`);
  const real = store.applyMatchResult({ ...base, devAssisted: false });
  ok(real.totalGold === 9000 && real.wins === 1 && real.matchesPlayed === 1,
    `a real match still counts (gold ${real.totalGold}, wins ${real.wins}, played ${real.matchesPlayed})`);
  store.flush();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fails ? `\nFAIL ${fails} check(s)` : '\nPASS test-dev-hooks');
process.exit(fails ? 1 : 0);
