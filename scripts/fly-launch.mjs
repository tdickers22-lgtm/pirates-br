#!/usr/bin/env node
// SOFT LAUNCH ON FLY (b1.3c, online-01/04, correctness-09). DEPLOY.md steps 2-8 as ONE
// resumable script, so the launch is a program that grades its own side effects rather
// than a list of commands somebody pastes and eyeballs.
//
//   node scripts/fly-launch.mjs                 # every step, in order, idempotent
//   node scripts/fly-launch.mjs --from deploy   # resume at a step
//   node scripts/fly-launch.mjs --only deploy,status,smoke   # the redeploy after a stamp
//   node scripts/fly-launch.mjs --dry-run       # print the plan, run nothing
//   node scripts/fly-launch.mjs --self-test     # the pure parts, no network (logic tier)
//
// Steps: preflight app volume secrets deploy status smoke soak stamp
//   preflight  fly auth whoami (owner step O1), git clean on the deploy files,
//              test-deploy-config green
//   app        fly apps create <fly.toml app>; if the name is taken, the fallback named in
//              fly.toml's comment ("fallback: <name>"), and fly.toml app + PUBLIC_URL +
//              ALLOWED_ORIGINS + DEPLOY.md rewritten together (test-deploy-config checks)
//   volume     pirates_data, fly.toml primary_region, 1 GB, once
//   secrets    HEALTH_KEY + BUGSNAP_KEY, generated once, kept in
//              ~/.config/pirates-br/fly-<app>.env (0600) because the soak needs HEALTH_KEY
//              back; handed to fly on stdin (`fly secrets import`), never on argv
//   deploy     fly deploy --remote-only --ha=false --build-arg BUILD_ID=<HEAD 12>
//   status     fly machine list --json: exactly 1 machine, fly.toml's VM size, started,
//              every check passing; the volume attached to it
//   smoke      scripts/smoke-online.mjs --url <PUBLIC_URL> --build-id <HEAD 12>
//   soak       the machine's ceiling is lifted for the probe (fly machine update --env,
//              undone by the next deploy); N = 1, 2, ... parallel copies of
//              `smoke-online --soak` (one full solo match each) for --ramp-seconds, while
//              /health (X-Health-Key) is polled for worstSimLagSec and droppedTicks. The
//              largest N with worstSimLagSec < 0.1 and dropped ticks < 1% of ticks is then
//              held for --soak-seconds (600 = the 10-minute remote soak). A red
//              confirmation steps N down and holds again.
//   stamp      fly.toml PIRATES_BR_MAX_MATCHES = max(1, floor(N / 1.3)) (30% headroom),
//              test-capacity-sim for the humans figure, a new top Capacity record row in
//              DEPLOY.md at the deployed sha, then test-deploy-config --require-measured.
//              Commit fly.toml + DEPLOY.md and redeploy (--only deploy,status,smoke).
//
// Exit 0 green, 1 a gate is red, 2 usage, 3 an owner step is needed (O1 sign-in, O2 billing).
// The URL stays unannounced until the b1 gate: nothing here posts it anywhere.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import http from 'node:http';
import https from 'node:https';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STEPS = ['preflight', 'app', 'volume', 'secrets', 'deploy', 'status', 'smoke', 'soak', 'stamp'];
const SERVER_TICK_HZ = 1000 / 16; // SERVER_TICK_MS = 16 in src/shared/constants
const LAG_BUDGET_SEC = 0.1;
const DROP_BUDGET = 0.01;
const D8_BAR_MATCHES = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pure helpers

export function tomlString(toml, key) {
  const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

/** The fallback app name lives in fly.toml's own comment, never in this script. */
export function fallbackAppName(toml) {
  const m = toml.match(/fallback:\s*([a-z0-9][a-z0-9-]*[a-z0-9])/);
  return m ? m[1] : null;
}

/** Rename the app everywhere the gate compares: app, PUBLIC_URL, ALLOWED_ORIGINS, -a flags. */
export function renameAppInToml(toml, from, to) {
  const esc = from.replace(/[-.]/g, '\\$&');
  return toml
    .replace(new RegExp(`^app\\s*=\\s*"${esc}"`, 'm'), `app = "${to}"`)
    .replace(new RegExp(`https://${esc}\\.fly\\.dev`, 'g'), `https://${to}.fly.dev`)
    .replace(new RegExp(`-a ${esc}(?![\\w-])`, 'g'), `-a ${to}`);
}

export function renameAppInDeployMd(md, from, to) {
  const esc = from.replace(/[-.]/g, '\\$&');
  return md
    .replace(new RegExp(`app \`${esc}\``, 'g'), `app \`${to}\``)
    .replace(new RegExp(`https://${esc}\\.fly\\.dev`, 'g'), `https://${to}.fly.dev`)
    .replace(new RegExp(`-a ${esc}(?![\\w-])`, 'g'), `-a ${to}`)
    .replace(new RegExp(`fly apps create ${esc}(?![\\w-])`, 'g'), `fly apps create ${to}`);
}

/** What a failed `fly apps create` means. */
export function classifyCreateError(text) {
  if (/billing|payment|credit card|add a card/i.test(text)) return 'billing';
  if (/already (been )?taken|already exists|name .* is taken|not available/i.test(text)) return 'taken';
  if (/no access token|not logged in|flyctl auth login/i.test(text)) return 'auth';
  return 'other';
}

export function vmSpecOf(size) {
  const m = /^(shared|performance)-(\d+)x$/.exec(size ?? '');
  return m ? { cpuKind: m[1], cpus: Number(m[2]) } : null;
}

/** Grade `fly machine list --json` against fly.toml's [[vm]]. */
export function gradeMachines(machines, { size, memoryMb }) {
  const bad = [];
  const list = Array.isArray(machines) ? machines : [];
  if (list.length !== 1) bad.push(`${list.length} machines (exactly 1 required: one process holds parties, resume tokens and the queue)`);
  const want = vmSpecOf(size);
  for (const m of list) {
    const g = m.config?.guest ?? {};
    if (m.state !== 'started') bad.push(`machine ${m.id} state ${m.state}`);
    if (want && (g.cpu_kind !== want.cpuKind || g.cpus !== want.cpus)) bad.push(`machine ${m.id} is ${g.cpu_kind}-${g.cpus}x, fly.toml says ${size}`);
    if (memoryMb && g.memory_mb !== memoryMb) bad.push(`machine ${m.id} has ${g.memory_mb} MB, fly.toml says ${memoryMb}`);
    const checks = m.checks ?? [];
    if (checks.length === 0) bad.push(`machine ${m.id} reports no health check`);
    for (const c of checks) if (c.status !== 'passing') bad.push(`check ${c.name} is ${c.status}`);
  }
  return { ok: bad.length === 0, bad };
}

export function memoryMbOf(mem) {
  const m = /^(\d+)\s*(gb|mb)$/i.exec(String(mem ?? '').trim());
  if (!m) return null;
  return m[2].toLowerCase() === 'gb' ? Number(m[1]) * 1024 : Number(m[1]);
}

/** 30% headroom: the measured N must be at least 1.3x the ceiling we set. */
export function headroomMatches(n) {
  return Math.max(1, Math.floor(n / 1.3));
}

/** One probe window's verdict. */
export function gradeWindow({ n, seconds, worstLag, droppedDelta, childFails }) {
  const ticks = n * seconds * SERVER_TICK_HZ;
  const dropFrac = ticks > 0 ? droppedDelta / ticks : 1;
  const why = [];
  if (childFails > 0) why.push(`${childFails} smoke copy(ies) red`);
  if (!(typeof worstLag === 'number' && worstLag < LAG_BUDGET_SEC)) why.push(`worstSimLagSec ${worstLag}`);
  if (!(dropFrac < DROP_BUDGET)) why.push(`dropped ${(dropFrac * 100).toFixed(2)}% of ticks`);
  return { ok: why.length === 0, dropFrac, why };
}

/** Rows of test-capacity-sim's markdown table. */
export function parseSimTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|$/.exec(line.trim());
    if (m) rows.push({ lam: Number(m[1]), M: Number(m[2]), p95: Number(m[3]), mean: Number(m[4]), peak: Number(m[5]), errors: Number(m[6]) });
  }
  return rows;
}

/** Mean humans at the highest arrival rate with p95 <= 30 s, from the largest tabulated
 *  MAX_MATCHES not above ours (the sim tabulates 2/4/6; rounding down never flatters). */
export function humansAt(rows, maxMatches) {
  const Ms = [...new Set(rows.map((r) => r.M))].filter((M) => M <= maxMatches).sort((a, b) => b - a);
  if (Ms.length === 0) return { humans: 0, fromM: null, lam: null };
  const fromM = Ms[0];
  const ok = rows.filter((r) => r.M === fromM && r.p95 <= 30).sort((a, b) => b.lam - a.lam);
  return ok.length ? { humans: ok[0].mean, fromM, lam: ok[0].lam } : { humans: 0, fromM, lam: null };
}

export function stampToml(toml, maxMatches, sha) {
  return toml
    .replace(/PIRATES_BR_MAX_MATCHES\s*=\s*"\d+"/, `PIRATES_BR_MAX_MATCHES = "${maxMatches}"`)
    .replace(/# PROVISIONAL until b1\.3c's remote 10-minute soak measures this machine size/, `# MEASURED by scripts/fly-launch.mjs (remote soak at ${sha}) on this machine size`);
}

/** A new top row under "## Capacity record"; older rows stay below as history. */
export function stampDeployMd(md, cells) {
  const out = md.replace(/(## Capacity record[\s\S]*?\n\|[^\n]*\n\|[-| ]+\|\n)/, `$1| ${cells.join(' | ')} |\n`);
  if (out === md) throw new Error('DEPLOY.md: no "## Capacity record" table to stamp');
  return out;
}

// ---------------------------------------------------------------- self-test

function selfTest() {
  let fails = 0;
  const expect = (label, cond, detail = '') => {
    console.log(`  ${cond ? '✓' : '✗ FAIL:'} ${label}${cond ? '' : `  [${detail}]`}`);
    if (!cond) fails += 1;
  };
  const toml = readFileSync(join(ROOT, 'fly.toml'), 'utf8');
  const md = readFileSync(join(ROOT, 'DEPLOY.md'), 'utf8');
  const app = tomlString(toml, 'app');
  const fb = fallbackAppName(toml);
  expect('fly.toml names its fallback app in a comment', fb && fb !== app, fb);
  const r = renameAppInToml(toml, app, fb);
  expect('rename: app, PUBLIC_URL and ALLOWED_ORIGINS move together', tomlString(r, 'app') === fb
    && tomlString(r, 'PIRATES_BR_PUBLIC_URL') === `https://${fb}.fly.dev`
    && tomlString(r, 'PIRATES_BR_ALLOWED_ORIGINS') === `https://${fb}.fly.dev`, tomlString(r, 'PIRATES_BR_ALLOWED_ORIGINS'));
  expect('rename: no old origin left in fly.toml', !r.includes(`https://${app}.fly.dev`) && !/-a pirates-br(?![\w-])/.test(r));
  const rm = renameAppInDeployMd(md, app, fb);
  expect('rename: DEPLOY.md keeps no `-a <old>` or old URL', !rm.includes(`https://${app}.fly.dev`) && !new RegExp(`-a ${app}(?![\\w-])`).test(rm));
  expect('rename is idempotent on a renamed file', renameAppInToml(r, app, fb) === r);
  expect('classify: taken', classifyCreateError('Error: Validation failed: Name has already been taken') === 'taken');
  expect('classify: billing is owner step O2', classifyCreateError('Error: We need your payment information to continue! Add a credit card') === 'billing');
  expect('classify: auth is owner step O1', classifyCreateError('Error: no access token available. Please login with \'flyctl auth login\'') === 'auth');
  const good = { id: 'm1', state: 'started', config: { guest: { cpu_kind: 'performance', cpus: 1, memory_mb: 2048 } }, checks: [{ name: 'servicecheck-00-http-8090', status: 'passing' }] };
  const vmBlock = toml.slice(toml.indexOf('[[vm]]'));
  const spec = { size: tomlString(vmBlock, 'size'), memoryMb: memoryMbOf(tomlString(vmBlock, 'memory')) };
  expect('fly.toml [[vm]] parses to performance-1x / 2048 MB', spec.size === 'performance-1x' && spec.memoryMb === 2048, JSON.stringify(spec));
  expect('status: one started performance-1x with a passing check is green', gradeMachines([good], spec).ok, gradeMachines([good], spec).bad.join('; '));
  expect('status: TWO machines is red', !gradeMachines([good, { ...good, id: 'm2' }], spec).ok);
  expect('status: zero machines is red', !gradeMachines([], spec).ok);
  expect('status: shared-cpu is red', !gradeMachines([{ ...good, config: { guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 2048 } } }], spec).ok);
  expect('status: a critical check is red', !gradeMachines([{ ...good, checks: [{ name: 'c', status: 'critical' }] }], spec).ok);
  expect('status: a warning check is red', !gradeMachines([{ ...good, checks: [{ name: 'c', status: 'warning' }] }], spec).ok);
  expect('status: no check at all is red', !gradeMachines([{ ...good, checks: [] }], spec).ok);
  expect('status: stopped is red', !gradeMachines([{ ...good, state: 'stopped' }], spec).ok);
  expect('headroom: 4 -> 3, 5 -> 3, 6 -> 4, 8 -> 6, 1 -> 1', [4, 5, 6, 8, 1].map(headroomMatches).join() === '3,3,4,6,1');
  expect('window: 0.05 s lag, 0 drops, all copies green -> green', gradeWindow({ n: 3, seconds: 120, worstLag: 0.05, droppedDelta: 0, childFails: 0 }).ok);
  expect('window: lag 0.1 is red (budget is strict)', !gradeWindow({ n: 3, seconds: 120, worstLag: 0.1, droppedDelta: 0, childFails: 0 }).ok);
  expect('window: no lag number (no HEALTH_KEY) is red', !gradeWindow({ n: 3, seconds: 120, worstLag: undefined, droppedDelta: 0, childFails: 0 }).ok);
  expect('window: 1% dropped ticks is red', !gradeWindow({ n: 1, seconds: 100, worstLag: 0.01, droppedDelta: 63, childFails: 0 }).ok);
  expect('window: a red smoke copy is red', !gradeWindow({ n: 2, seconds: 120, worstLag: 0.01, droppedDelta: 0, childFails: 1 }).ok);
  const sim = parseSimTable(md);
  expect('sim table parses from DEPLOY.md (9 rows)', sim.length === 9, sim.length);
  const h4 = humansAt(sim, 4); const h5 = humansAt(sim, 5); const h2 = humansAt(sim, 2); const h1 = humansAt(sim, 1);
  expect('humans @4 = the 1/min row (p95 20 s) of M=4', h4.fromM === 4 && h4.lam === 1 && h4.humans === 6.8, JSON.stringify(h4));
  expect('humans @5 rounds DOWN to the M=4 rows', h5.fromM === 4, JSON.stringify(h5));
  expect('humans @2 = 0 (p95 239 s misses the bar)', h2.humans === 0, JSON.stringify(h2));
  expect('humans @1 = 0 (no tabulated row)', h1.humans === 0 && h1.fromM === null, JSON.stringify(h1));
  const st = stampToml(toml, 3, 'abcdef123456');
  expect('stamp: fly.toml MAX_MATCHES written', tomlString(st, 'PIRATES_BR_MAX_MATCHES') === '3');
  const sm = stampDeployMd(md, ['performance-1x', '3', 'abcdef123456', '0.04', '6.8', '2026-09-23', 'x']);
  const top = sm.slice(sm.indexOf('## Capacity record')).split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| machine') && !l.startsWith('|---'))[0];
  expect('stamp: the new row is the TOP row, the old one survives below', top.includes('abcdef123456') && sm.includes('| unmeasured |'), top);
  console.log(fails ? `\nFAIL fly-launch self-test (${fails})` : '\nPASS fly-launch self-test');
  return fails === 0;
}

// ---------------------------------------------------------------- effects

class OwnerStep extends Error {}

function sh(cmd, args, { input, allowFail = false, quiet = false } = {}) {
  if (!quiet) console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 && !allowFail) {
    const kind = classifyCreateError(out);
    if (kind === 'auth') throw new OwnerStep('owner step O1: run `fly auth login` in Terminal');
    if (kind === 'billing') throw new OwnerStep('owner step O2: add a card at https://fly.io/dashboard/personal/billing');
    throw new Error(`${cmd} ${args[0]} exited ${r.status}: ${out.trim().slice(-800)}`);
  }
  return { status: r.status, stdout: r.stdout ?? '', out };
}

function streamed(cmd, args, { env, timeoutMs = 30 * 60_000 } = {}) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
    const t = setTimeout(() => p.kill('SIGTERM'), timeoutMs);
    p.on('exit', (code) => { clearTimeout(t); resolve(code ?? 1); });
  });
}

const fly = (args, o) => sh('fly', args, o);
const flyJson = (args) => JSON.parse(fly([...args, '--json'], { quiet: true }).stdout || 'null');

function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': 'pirates-br-launch', ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch (e) { reject(e); } });
    });
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function ctxFromFiles() {
  const toml = readFileSync(join(ROOT, 'fly.toml'), 'utf8');
  const vm = toml.slice(toml.indexOf('[[vm]]'));
  return {
    app: tomlString(toml, 'app'),
    region: tomlString(toml, 'primary_region'),
    url: tomlString(toml, 'PIRATES_BR_PUBLIC_URL'),
    size: tomlString(vm, 'size'),
    memoryMb: memoryMbOf(tomlString(vm, 'memory')),
    sha: sh('git', ['rev-parse', '--short=12', 'HEAD'], { quiet: true }).stdout.trim(),
  };
}

const secretsPath = (app) => join(homedir(), '.config', 'pirates-br', `fly-${app}.env`);
function readSecrets(app) {
  const p = secretsPath(app);
  if (!existsSync(p)) return null;
  return Object.fromEntries(readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

async function waitHealthy(ctx, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try { const r = await getJson(`${ctx.url}/health`); if (r.status === 200 && r.body.ok) return r.body; } catch { /* booting */ }
    await sleep(3000);
  }
  throw new Error(`${ctx.url}/health never answered ok`);
}

const steps = {
  async preflight(ctx) {
    const who = fly(['auth', 'whoami'], { quiet: true }).stdout.trim();
    console.log(`  signed in as ${who}`);
    const dirty = sh('git', ['status', '--porcelain', '--', 'fly.toml', 'Dockerfile', 'DEPLOY.md', 'scripts/docker-entrypoint.sh', 'src'], { quiet: true }).stdout.trim();
    if (dirty) throw new Error(`uncommitted deploy inputs (the build id would lie):\n${dirty}`);
    const code = await streamed('node', ['scripts/test-deploy-config.mjs']);
    if (code !== 0) throw new Error('test-deploy-config is red');
  },
  async app(ctx) {
    const mine = (flyJson(['apps', 'list']) ?? []).map((a) => a.Name ?? a.name);
    if (mine.includes(ctx.app)) { console.log(`  app ${ctx.app} exists in this account`); return; }
    const r = fly(['apps', 'create', ctx.app, '--org', 'personal'], { allowFail: true });
    if (r.status === 0) return;
    const kind = classifyCreateError(r.out);
    if (kind === 'billing') throw new OwnerStep('owner step O2: add a card at https://fly.io/dashboard/personal/billing, then re-run');
    if (kind !== 'taken') throw new Error(`fly apps create ${ctx.app}: ${r.out.trim()}`);
    const toml = readFileSync(join(ROOT, 'fly.toml'), 'utf8');
    const fb = fallbackAppName(toml);
    if (!fb || fb === ctx.app) throw new Error(`${ctx.app} is taken and fly.toml names no other fallback`);
    console.log(`  ${ctx.app} is taken; falling back to ${fb}`);
    if (!mine.includes(fb)) fly(['apps', 'create', fb, '--org', 'personal']);
    writeFileSync(join(ROOT, 'fly.toml'), renameAppInToml(toml, ctx.app, fb));
    writeFileSync(join(ROOT, 'DEPLOY.md'), renameAppInDeployMd(readFileSync(join(ROOT, 'DEPLOY.md'), 'utf8'), ctx.app, fb));
    Object.assign(ctx, ctxFromFiles());
    const code = await streamed('node', ['scripts/test-deploy-config.mjs']);
    if (code !== 0) throw new Error('test-deploy-config red after the rename');
    console.log('  COMMIT fly.toml + DEPLOY.md (renamed app) before the deploy step; preflight refuses a dirty tree');
    throw new OwnerStep('commit the app rename, then re-run with --from volume');
  },
  async volume(ctx) {
    const vols = flyJson(['volumes', 'list', '-a', ctx.app]) ?? [];
    if (vols.some((v) => v.name === 'pirates_data')) { console.log('  pirates_data exists'); return; }
    fly(['volumes', 'create', 'pirates_data', '--region', ctx.region, '--size', '1', '--yes', '-a', ctx.app]);
  },
  async secrets(ctx) {
    const have = new Set((flyJson(['secrets', 'list', '-a', ctx.app]) ?? []).map((s) => s.Name ?? s.name));
    let local = readSecrets(ctx.app);
    const need = !local || !have.has('HEALTH_KEY') || !have.has('BUGSNAP_KEY');
    if (!need) { console.log(`  HEALTH_KEY + BUGSNAP_KEY set on fly and kept in ${secretsPath(ctx.app)}`); return; }
    // fly never gives a secret back, so a key we do not hold locally is rotated.
    local = { HEALTH_KEY: local?.HEALTH_KEY ?? randomBytes(16).toString('hex'), BUGSNAP_KEY: local?.BUGSNAP_KEY ?? randomBytes(24).toString('hex') };
    mkdirSync(dirname(secretsPath(ctx.app)), { recursive: true });
    writeFileSync(secretsPath(ctx.app), `HEALTH_KEY=${local.HEALTH_KEY}\nBUGSNAP_KEY=${local.BUGSNAP_KEY}\n`, { mode: 0o600 });
    chmodSync(secretsPath(ctx.app), 0o600);
    const machines = flyJson(['machine', 'list', '-a', ctx.app]) ?? [];
    fly(['secrets', 'import', '-a', ctx.app, ...(machines.length ? [] : ['--stage'])], { input: `HEALTH_KEY=${local.HEALTH_KEY}\nBUGSNAP_KEY=${local.BUGSNAP_KEY}\n` });
  },
  async deploy(ctx) {
    const code = await streamed('fly', ['deploy', '--remote-only', '--ha=false', '--build-arg', `BUILD_ID=${ctx.sha}`, '-a', ctx.app]);
    if (code !== 0) throw new Error(`fly deploy exited ${code}`);
    await waitHealthy(ctx);
  },
  async status(ctx) {
    let g;
    for (let i = 0; i < 10; i += 1) { // checks turn passing a grace period after start
      g = gradeMachines(flyJson(['machine', 'list', '-a', ctx.app]), ctx);
      if (g.ok) break;
      await sleep(6000);
    }
    if (!g.ok) throw new Error(`fly status: ${g.bad.join('; ')}`);
    const machine = flyJson(['machine', 'list', '-a', ctx.app])[0];
    const vol = (flyJson(['volumes', 'list', '-a', ctx.app]) ?? []).find((v) => v.name === 'pirates_data');
    if (!vol || vol.attached_machine_id !== machine.id) throw new Error(`pirates_data not attached to ${machine.id}`);
    ctx.machineId = machine.id;
    console.log(`  1 machine ${machine.id} ${ctx.size} started, checks passing, pirates_data attached; image ${machine.config?.image}`);
  },
  async smoke(ctx) {
    const code = await streamed('node', ['scripts/smoke-online.mjs', '--url', ctx.url, '--build-id', ctx.sha], { env: { HEALTH_KEY: readSecrets(ctx.app)?.HEALTH_KEY ?? '' } });
    if (code !== 0) throw new Error('smoke-online is red');
  },
  async soak(ctx) {
    const key = readSecrets(ctx.app)?.HEALTH_KEY;
    if (!key) throw new Error('no local HEALTH_KEY: run the secrets step (the soak grades /health detail)');
    const machineId = ctx.machineId ?? flyJson(['machine', 'list', '-a', ctx.app])[0].id;
    // Lift the ceiling for the probe only (2 per copy: each smoke copy's join stage leaves
    // a solo match that the lobby reaps later). The next deploy restores fly.toml's value.
    fly(['machine', 'update', machineId, '--env', `PIRATES_BR_MAX_MATCHES=${2 * ctx.maxProbe + 2}`, '--yes', '-a', ctx.app]);
    await waitHealthy(ctx);
    const probe = async (n, seconds) => {
      console.log(`\n  probe: ${n} concurrent full solo match(es) for ${seconds} s`);
      const health = async () => (await getJson(`${ctx.url}/health`, { 'x-health-key': key })).body;
      const kids = Array.from({ length: n }, () => new Promise((resolve) => {
        const p = spawn('node', ['scripts/smoke-online.mjs', '--url', ctx.url, '--build-id', ctx.sha, '--skip-queue', '--soak', String(seconds)],
          { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HEALTH_KEY: key } });
        let tail = '';
        p.stdout.on('data', (c) => { tail = (tail + c).slice(-1500); });
        p.stderr.on('data', (c) => { tail = (tail + c).slice(-1500); });
        p.on('exit', (code) => resolve({ code, tail }));
      }));
      let done = false;
      const all = Promise.all(kids).then((r) => { done = true; return r; });
      let worstLag = 0; let dropMin = Infinity; let dropMax = 0;
      const t0 = Date.now();
      while (!done) {
        await sleep(5000);
        try {
          const h = await health();
          // Only while every copy is inside its soak window (join stages take ~20-40 s).
          if (Date.now() - t0 > 45_000 && typeof h.worstSimLagSec === 'number') worstLag = Math.max(worstLag, h.worstSimLagSec);
          dropMin = Math.min(dropMin, h.droppedTicks ?? 0); dropMax = Math.max(dropMax, h.droppedTicks ?? 0);
        } catch { worstLag = Infinity; }
      }
      const res = await all;
      const childFails = res.filter((r) => r.code !== 0).length;
      for (const r of res) if (r.code !== 0) console.log(r.tail.split('\n').filter((l) => /FAIL/.test(l)).join('\n'));
      const g = gradeWindow({ n, seconds, worstLag, droppedDelta: dropMax - (Number.isFinite(dropMin) ? dropMin : 0), childFails });
      console.log(`  N=${n}: worstSimLagSec ${worstLag}, dropped ${(g.dropFrac * 100).toFixed(3)}%, ${g.ok ? 'GREEN' : `RED (${g.why.join('; ')})`}`);
      return { n, worstLag, dropFrac: g.dropFrac, ok: g.ok };
    };
    let best = null;
    for (let n = 1; n <= ctx.maxProbe; n += 1) {
      const r = await probe(n, ctx.rampSeconds);
      if (!r.ok) break;
      best = r;
    }
    if (!best) throw new Error('not even ONE match holds the budget on this machine');
    let held = null;
    for (let n = best.n; n >= 1 && !held; n -= 1) {
      const r = await probe(n, ctx.soakSeconds);
      if (r.ok) held = r;
    }
    if (!held) throw new Error(`the ${ctx.soakSeconds} s hold failed at every N`);
    ctx.soakResult = { ...held, capped: best.n === ctx.maxProbe, seconds: ctx.soakSeconds };
    mkdirSync(join(ROOT, 'data'), { recursive: true });
    writeFileSync(join(ROOT, 'data', 'fly-soak.json'), `${JSON.stringify({ app: ctx.app, sha: ctx.sha, ...ctx.soakResult, at: new Date().toISOString() }, null, 2)}\n`);
    console.log(`\n  SOAK held N=${held.n} for ${ctx.soakSeconds} s: worstSimLagSec ${held.worstLag}, dropped ${(held.dropFrac * 100).toFixed(3)}%`);
  },
  async stamp(ctx) {
    const soak = ctx.soakResult ?? JSON.parse(readFileSync(join(ROOT, 'data', 'fly-soak.json'), 'utf8'));
    if (soak.app !== undefined && soak.app !== ctx.app) throw new Error(`soak was measured on ${soak.app}, not ${ctx.app}`);
    const sha = soak.sha ?? ctx.sha;
    const M = headroomMatches(soak.n);
    const sim = sh('node', ['--import', 'tsx', 'scripts/test-capacity-sim.mjs'], { quiet: true });
    const h = humansAt(parseSimTable(sim.out), M);
    const note = [
      `remote soak on ${ctx.app} (${ctx.url}): ${soak.n} concurrent full solo match(es) held ${soak.seconds ?? ctx.soakSeconds} s, worst lag ${soak.worstLag} s, dropped ${(soak.dropFrac * 100).toFixed(2)}% of ticks${soak.capped ? `, probe capped at ${ctx.maxProbe}` : ''}; MAX_MATCHES = floor(${soak.n} / 1.3)`,
      h.fromM === null ? 'humans 0: the sim tabulates MAX_MATCHES 2/4/6 only' : `humans from test-capacity-sim M=${h.fromM}${h.lam ? `, ${h.lam}/min` : ', no arrival rate meets p95 <= 30 s'}`,
      M < D8_BAR_MATCHES ? `Shortfall: below the D8 bar (MAX_MATCHES >= ${D8_BAR_MATCHES}); b2.0b-c are mandatory (lever ladder)` : null,
    ].filter(Boolean).join('. ');
    const cells = [ctx.size, String(M), sha, Number(soak.worstLag).toFixed(2), h.humans.toFixed(1), new Date().toISOString().slice(0, 10), `${note}.`];
    writeFileSync(join(ROOT, 'fly.toml'), stampToml(readFileSync(join(ROOT, 'fly.toml'), 'utf8'), M, sha));
    writeFileSync(join(ROOT, 'DEPLOY.md'), stampDeployMd(readFileSync(join(ROOT, 'DEPLOY.md'), 'utf8'), cells));
    console.log(`  stamped MAX_MATCHES ${M}, humans ${h.humans.toFixed(1)} at ${sha}`);
    const code = await streamed('node', ['scripts/test-deploy-config.mjs', '--require-measured']);
    if (code !== 0) throw new Error('test-deploy-config --require-measured is red after the stamp');
    console.log('  NEXT: commit fly.toml + DEPLOY.md, then node scripts/fly-launch.mjs --only preflight,deploy,status,smoke');
  },
};

function parseArgs(argv) {
  const o = { maxProbe: 8, rampSeconds: 120, soakSeconds: 600 };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i]; const v = () => argv[++i];
    if (k === '--dry-run') o.dryRun = true;
    else if (k === '--self-test') o.selfTest = true;
    else if (k === '--from') o.from = v();
    else if (k === '--only') o.only = v().split(',');
    else if (k === '--max-probe') o.maxProbe = Number(v());
    else if (k === '--ramp-seconds') o.rampSeconds = Number(v());
    else if (k === '--soak-seconds') o.soakSeconds = Number(v());
    else throw new Error(`unknown arg ${k}`);
  }
  for (const s of [...(o.only ?? []), ...(o.from ? [o.from] : [])]) if (!STEPS.includes(s)) throw new Error(`unknown step ${s} (${STEPS.join(' ')})`);
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`fly-launch: ${e.message}`); process.exit(2); }
  if (opts.selfTest) process.exit(selfTest() ? 0 : 1);
  const run = opts.only ?? STEPS.slice(opts.from ? STEPS.indexOf(opts.from) : 0);
  const ctx = { ...ctxFromFiles(), maxProbe: opts.maxProbe, rampSeconds: opts.rampSeconds, soakSeconds: opts.soakSeconds };
  console.log(`fly-launch ${ctx.app} (${ctx.url}) build ${ctx.sha}: ${run.join(' -> ')}`);
  if (opts.dryRun) {
    console.log(`  app ${ctx.app}, fallback ${fallbackAppName(readFileSync(join(ROOT, 'fly.toml'), 'utf8'))}, region ${ctx.region}, vm ${ctx.size}/${ctx.memoryMb} MB`);
    console.log(`  deploy: fly deploy --remote-only --ha=false --build-arg BUILD_ID=${ctx.sha} -a ${ctx.app}`);
    console.log(`  soak: ramp 1..${ctx.maxProbe} x ${ctx.rampSeconds} s, hold ${ctx.soakSeconds} s; secrets file ${secretsPath(ctx.app)}`);
    process.exit(0);
  }
  for (const s of run) {
    console.log(`\n== ${s}`);
    try { await steps[s](ctx); } catch (e) {
      console.error(`\n${e instanceof OwnerStep ? 'OWNER STEP' : 'FAIL'} at ${s}: ${e.message}`);
      process.exit(e instanceof OwnerStep ? 3 : 1);
    }
  }
  console.log('\nPASS fly-launch');
}
