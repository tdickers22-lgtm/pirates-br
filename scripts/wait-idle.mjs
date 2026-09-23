#!/usr/bin/env node
// WAIT FOR AN IDLE HOST BEFORE A DEPLOY (online-11, b1.3b).
//
// A deploy restarts the one machine, and every live match on it ends as a no
// contest (the drain notice makes that honest, not free). So deploy.yml asks
// first: poll /health until no match is running, then deploy. A host that stays
// busy past the cap is deployed anyway (the 10 s drain + server_notice is the
// fallback), and a host that does not answer at all (first deploy, stopped app)
// has nothing to protect, so the deploy proceeds at once.
//
//   node scripts/wait-idle.mjs [--url https://pirates-br.fly.dev] [--cap-min 20] [--interval-sec 15]
//
// Always exits 0 when it has decided (idle | cap | unreachable); 2 on bad args.
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { flyPublicUrl } from './smoke-online.mjs';

function getHealth(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(`${url.replace(/\/+$/, '')}/health`, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Returns { decision: 'idle'|'cap'|'unreachable', polls, lastMatches }. */
export async function waitIdle({ url, capMs = 20 * 60_000, intervalMs = 15_000, log = () => {}, health = getHealth, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const start = now();
  let polls = 0; let lastMatches = null; let failures = 0;
  for (;;) {
    polls += 1;
    try {
      const h = await health(url);
      failures = 0;
      lastMatches = Number(h.body?.matches ?? NaN);
      if (h.status === 200 && lastMatches === 0) { log(`  idle: 0 matches (${polls} poll(s))`); return { decision: 'idle', polls, lastMatches }; }
      log(`  busy: ${h.body?.matches} match(es), ${h.body?.clients} client(s), status ${h.status}`);
    } catch (e) {
      failures += 1;
      // Two misses in a row, not one: a single dropped GET is not "no app".
      if (failures >= 2) { log(`  unreachable (${e.message}): nothing to protect, deploying`); return { decision: 'unreachable', polls, lastMatches }; }
    }
    if (now() - start >= capMs) { log(`  cap ${Math.round(capMs / 60_000)} min reached with ${lastMatches} match(es): deploying, the drain notice covers them`); return { decision: 'cap', polls, lastMatches }; }
    await sleep(failures ? 2000 : intervalMs);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const url = arg('--url', process.env.SMOKE_URL ?? flyPublicUrl());
  if (!url) { console.error('wait-idle: no --url and no fly.toml PIRATES_BR_PUBLIC_URL'); process.exit(2); }
  console.log(`wait-idle ${url}`);
  const r = await waitIdle({ url, capMs: Number(arg('--cap-min', 20)) * 60_000, intervalMs: Number(arg('--interval-sec', 15)) * 1000, log: (l) => console.log(l) });
  console.log(`wait-idle: ${r.decision}`);
  process.exit(0);
}
