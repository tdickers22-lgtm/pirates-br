#!/usr/bin/env node
// test-deploy-config — the Fly launch config cannot drift into a broken launch.
//
// Pure node, no network, no fly session. Reads fly.toml, Dockerfile,
// scripts/docker-entrypoint.sh, .dockerignore, DEPLOY.md and (when it exists)
// .github/workflows/deploy.yml, and fails on every way the 2026-09-22 online
// audit found the launch going wrong at step one:
//
//   online-01  a shared-cpu VM (pooled 12.5% of a core; one combat match needs ~25%)
//   online-02  a deploy line without --ha=false (Fly then creates TWO machines and
//              parties/resume/queue, which live in one process, split in half);
//              `fly launch` in the runbook (it regenerates the committed fly.toml)
//   online-08  no [[mounts]] pirates_data -> /app/data (stats wiped every deploy;
//              the volume is also the second belt that pins one machine)
//   online-19  an image that never drops root
//   D8         auto_stop_machines != false, kill_timeout < drain + 10 s,
//              MAX_MATCHES above what was measured on THIS machine size
//   gap 8      the DEPLOY.md capacity row {machine, MAX_MATCHES, measuredAtCommit,
//              worstSimLagSec, humans at p95 wait <= 30 s} must exist and must not be
//              older than the last commit touching src/server or src/shared.
//
// An `unmeasured` capacity row is allowed ONLY at the provisional MAX_MATCHES (2)
// and only without --require-measured; the batch gate's live block passes
// --require-measured after it re-measured on the live machine (PLAN rule 11).
//
// Every clause is also run against an in-memory mutation of the real files and
// must FAIL there, so the gate proves on each run that it can fail.
//
//   node scripts/test-deploy-config.mjs [--require-measured]

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRE_MEASURED = process.argv.includes('--require-measured');
const PROVISIONAL_MAX_MATCHES = 2;
const SIM_LAG_BUDGET_SEC = 0.1;

// ── tiny TOML subset reader (what fly.toml uses: tables, arrays of tables,
//    dotted sub-tables, strings, numbers, booleans, # comments) ──────────────
export function parseToml(src) {
  const root = {};
  let cur = root;
  const stripComment = (line) => {
    let q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '#') return line.slice(0, i);
    }
    return line;
  };
  const walk = (path, arrayLast) => {
    let o = root;
    path.forEach((k, i) => {
      const last = i === path.length - 1;
      if (last && arrayLast) {
        if (!Array.isArray(o[k])) o[k] = [];
        o[k].push({});
        o = o[k][o[k].length - 1];
      } else {
        if (o[k] === undefined) o[k] = {};
        o = Array.isArray(o[k]) ? o[k][o[k].length - 1] : o[k];
      }
    });
    return o;
  };
  for (const raw of src.split('\n')) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    let m;
    if ((m = line.match(/^\[\[([^\]]+)\]\]$/))) cur = walk(m[1].trim().split('.'), true);
    else if ((m = line.match(/^\[([^\]]+)\]$/))) cur = walk(m[1].trim().split('.'), false);
    else if ((m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/))) {
      const v = m[2].trim();
      let val;
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) val = v.slice(1, -1);
      else if (v === 'true' || v === 'false') val = v === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(v)) val = Number(v);
      else val = v;
      cur[m[1]] = val;
    }
  }
  return root;
}

const seconds = (v) => {
  if (typeof v === 'number') return v;
  const m = String(v ?? '').match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === 'ms' ? n / 1000 : m[2] === 'm' ? n * 60 : n;
};

/** The first data row of the table under "## Capacity record" in DEPLOY.md. */
export function parseCapacityRow(md) {
  const at = md.search(/^## Capacity record\s*$/m);
  if (at < 0) return null;
  const rows = md.slice(at).split('\n').filter((l) => /^\|.*\|\s*$/.test(l.trim()));
  if (rows.length < 3) return null;
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim().replace(/`/g, ''));
  const head = cells(rows[0]).map((h) => h.toLowerCase());
  const data = cells(rows[2]);
  const col = (re) => { const i = head.findIndex((h) => re.test(h)); return i < 0 ? undefined : data[i]; };
  return {
    machine: col(/^machine/),
    maxMatches: col(/^max_matches/),
    measuredAtCommit: col(/^measuredatcommit/),
    worstSimLagSec: col(/^worstsimlagsec/),
    humansAtP95: col(/^humans/),
  };
}

const realGit = {
  lastSrcCommit() {
    return execFileSync('git', ['log', '-1', '--format=%H', '--', 'src/server', 'src/shared'], { cwd: ROOT }).toString().trim();
  },
  resolve(sha) {
    try { return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
    catch { return null; }
  },
  isAncestor(a, b) {
    try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: ROOT, stdio: 'ignore' }); return true; }
    catch { return false; }
  },
};

/** Final stage of a multi-stage Dockerfile (text after the last FROM). */
const finalStage = (df) => df.slice(df.lastIndexOf('\nFROM ') >= 0 ? df.lastIndexOf('\nFROM ') : 0);
const deployLines = (text) => text.split('\n').filter((l) => /\b(fly|flyctl)\s+deploy\b/.test(l) && !/^\s*#/.test(l));

/** Every clause; returns [{clause, ok, detail}]. `f` = file texts, `git` = injectable. */
export function check(f, git, { requireMeasured = false } = {}) {
  const out = [];
  const expect = (clause, ok, detail = '') => out.push({ clause, ok: !!ok, detail });
  const toml = parseToml(f.flyToml);
  const env = toml.env ?? {};
  const vm = (toml.vm ?? [])[0] ?? {};
  const svc = toml.http_service ?? {};
  const mounts = toml.mounts ?? [];

  // online-01: dedicated CPU
  const size = String(vm.size ?? '');
  expect('vm: a performance-* size, never shared-cpu (online-01)', /^performance-\d+x$/.test(size), `size=${size || '(none)'}`);
  const memMb = /gb$/i.test(String(vm.memory)) ? parseFloat(vm.memory) * 1024 : parseFloat(vm.memory);
  expect('vm: memory >= 2 GB', memMb >= 2048, `memory=${vm.memory}`);

  // online-02 / online-08: one machine, stats volume
  const mount = mounts.find((m) => m.destination === '/app/data');
  expect('[[mounts]] pirates_data -> /app/data (online-08, pins one machine)', mount && mount.source === 'pirates_data', JSON.stringify(mounts));

  // D8: never stopped mid-match, drain has room
  expect('http_service.auto_stop_machines = false', svc.auto_stop_machines === false, `auto_stop_machines=${svc.auto_stop_machines}`);
  expect('http_service.min_machines_running >= 1', Number(svc.min_machines_running) >= 1, `min=${svc.min_machines_running}`);
  expect('http_service.internal_port matches env PORT', String(svc.internal_port) === String(env.PORT), `${svc.internal_port} vs ${env.PORT}`);
  const drain = Number(env.PIRATES_BR_DRAIN_SECONDS ?? 10);
  const kill = seconds(toml.kill_timeout ?? '5s');
  expect('kill_timeout >= PIRATES_BR_DRAIN_SECONDS + 10 s', kill >= drain + 10, `kill_timeout=${kill} s, drain=${drain} s`);
  expect('kill_signal = SIGTERM (starts the graceful drain)', toml.kill_signal === 'SIGTERM', `kill_signal=${toml.kill_signal}`);

  // env: public URL + origin allowlist from fly.toml, proxy trust, no dev switches
  const app = String(toml.app ?? '');
  const pub = String(env.PIRATES_BR_PUBLIC_URL ?? '');
  expect('env PIRATES_BR_PUBLIC_URL = https://<app>.fly.dev', app && pub === `https://${app}.fly.dev`, `app=${app} url=${pub}`);
  const origins = String(env.PIRATES_BR_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
  expect('env PIRATES_BR_ALLOWED_ORIGINS contains the public URL', pub && origins.includes(pub.toLowerCase()), `origins=${origins.join(',') || '(none)'}`);
  expect('env PIRATES_BR_TRUST_PROXY = 1 (behind the Fly edge)', String(env.PIRATES_BR_TRUST_PROXY) === '1');
  expect('env has no PIRATES_BR_DEV / PIRATES_BR_DEV_HOOKS', !('PIRATES_BR_DEV' in env) && !('PIRATES_BR_DEV_HOOKS' in env));

  // MAX_MATCHES vs the capacity record (D8 + critique gap 8)
  const mm = Number(env.PIRATES_BR_MAX_MATCHES);
  expect('env PIRATES_BR_MAX_MATCHES is a positive integer', Number.isInteger(mm) && mm >= 1, `MAX_MATCHES=${env.PIRATES_BR_MAX_MATCHES}`);
  const row = parseCapacityRow(f.deployMd);
  expect('DEPLOY.md "## Capacity record" row {machine, MAX_MATCHES, measuredAtCommit, worstSimLagSec, humans}',
    row && row.machine && row.maxMatches && row.measuredAtCommit && row.worstSimLagSec && row.humansAtP95 !== undefined && row.humansAtP95 !== '',
    JSON.stringify(row));
  if (row) {
    expect('capacity row machine = fly.toml vm size', row.machine === size, `${row.machine} vs ${size}`);
    expect('fly.toml MAX_MATCHES <= the recorded measurement', Number.isFinite(Number(row.maxMatches)) && mm <= Number(row.maxMatches), `fly.toml ${mm} vs row ${row.maxMatches}`);
    expect('capacity row humans at p95 <= 30 s is a number (test-capacity-sim)', /^\d+(\.\d+)?$/.test(String(row.humansAtP95)), `humans=${row.humansAtP95}`);
    if (row.measuredAtCommit === 'unmeasured') {
      expect(`unmeasured capacity: MAX_MATCHES stays at the provisional ${PROVISIONAL_MAX_MATCHES}`, mm <= PROVISIONAL_MAX_MATCHES && Number(row.maxMatches) <= PROVISIONAL_MAX_MATCHES, `MAX_MATCHES=${mm}`);
      expect('a measured capacity row (--require-measured, the live block)', !requireMeasured, 'measuredAtCommit=unmeasured');
    } else {
      const sha = git.resolve(row.measuredAtCommit);
      expect('measuredAtCommit resolves to a commit', sha, row.measuredAtCommit);
      const lag = Number(row.worstSimLagSec);
      expect(`recorded worstSimLagSec < ${SIM_LAG_BUDGET_SEC}`, Number.isFinite(lag) && lag < SIM_LAG_BUDGET_SEC, `worstSimLagSec=${row.worstSimLagSec}`);
      if (sha) {
        const last = git.lastSrcCommit();
        expect('measuredAtCommit is not older than the last src/server|src/shared commit', !last || git.isAncestor(last, sha),
          `measured ${row.measuredAtCommit}, last src commit ${last.slice(0, 12)}`);
      }
    }
  }

  // runbook + CI: one machine on every deploy, no fly launch
  const mdDeploys = deployLines(f.deployMd);
  const badMd = mdDeploys.filter((l) => !/--ha=false/.test(l));
  expect('DEPLOY.md has at least one fly deploy line', mdDeploys.length > 0, `${mdDeploys.length} lines`);
  expect('every DEPLOY.md fly deploy line carries --ha=false (online-02)', badMd.length === 0, badMd.join(' || '));
  expect("DEPLOY.md never says 'fly launch' (it regenerates fly.toml)", !/\b(fly|flyctl)\s+launch\b/.test(f.deployMd));
  // b1.3b (online-04): the CI deploy path. The workflow must exist from here on.
  expect('.github/workflows/deploy.yml exists (online-04)', f.deployYml != null);
  const yml = f.deployYml ?? '';
  const ymlDeploys = deployLines(yml);
  const badYml = ymlDeploys.filter((l) => !/--ha=false/.test(l));
  expect('every deploy.yml fly deploy line carries --ha=false', ymlDeploys.length > 0 && badYml.length === 0, badYml.join(' || ') || `${ymlDeploys.length} lines`);
  const ylines = yml.split('\n').filter((l) => !/^\s*#/.test(l));
  const tokenSets = ylines.filter((l) => /FLY_API_TOKEN\s*[:=]/.test(l));
  const badTok = tokenSets.filter((l) => !/FLY_API_TOKEN\s*[:=]\s*\$\{\{\s*secrets\.FLY_API_TOKEN\s*\}\}\s*$/.test(l));
  const literal = /FlyV1\s+\S|\bf[mo][12]_[A-Za-z0-9]{8}/.test(yml);
  expect('deploy.yml: FLY_API_TOKEN only from ${{ secrets.FLY_API_TOKEN }}, never a literal',
    tokenSets.length > 0 && badTok.length === 0 && !literal, `${badTok.join(' || ')}${literal ? ' literal token in file' : ''}` || `${tokenSets.length} set(s)`);
  const idx = (re) => ylines.findIndex((l) => re.test(l));
  const firstDeploy = idx(/\b(fly|flyctl)\s+deploy\b(?!.*--image)/);
  const waitAt = idx(/node\s+scripts\/wait-idle\.mjs/);
  const smokeAt = ylines.findIndex((l, i) => i > firstDeploy && /node\s+scripts\/smoke-online\.mjs/.test(l));
  expect('deploy.yml: wait-idle runs before the deploy (online-11)', waitAt >= 0 && firstDeploy >= 0 && waitAt < firstDeploy, `wait-idle@${waitAt} deploy@${firstDeploy}`);
  expect('deploy.yml: smoke-online runs after the deploy, against the deployed build id', firstDeploy >= 0 && smokeAt > firstDeploy && /--build-id\s+\$\{\{\s*github\.sha\s*\}\}/.test(ylines[smokeAt] ?? ''), `deploy@${firstDeploy} smoke@${smokeAt}`);
  const rbAt = ylines.findIndex((l, i) => i > smokeAt && smokeAt >= 0 && /\b(fly|flyctl)\s+deploy\b.*--image/.test(l));
  const rbIf = rbAt > 0 ? ylines.slice(Math.max(0, rbAt - 4), rbAt).some((l) => /if:.*failure\(\)/.test(l) && /steps\.smoke\.outcome/.test(l)) : false;
  expect('deploy.yml: a red smoke redeploys the previous image (if: failure() on the smoke step)', rbAt > 0 && rbIf, `rollback@${rbAt}`);
  expect("deploy.yml: concurrency group 'deploy', never cancelled mid-deploy", /concurrency:\s*\n\s+group:\s*deploy\s*\n\s+cancel-in-progress:\s*false/.test(yml));
  expect('deploy.yml: triggers are workflow_dispatch + push to release', /workflow_dispatch:/.test(yml) && /push:\s*\n\s+branches:\s*\[\s*release\s*\]/.test(yml));

  // image: build-arg, playwright skip, root dropped by the entrypoint
  const df = f.dockerfile;
  const build = df.slice(0, df.lastIndexOf('\nFROM ') >= 0 ? df.lastIndexOf('\nFROM ') : df.length);
  const buildIdx = build.search(/RUN npm run build/);
  expect('Dockerfile build stage: ARG BUILD_ID + ENV BUILD_ID before npm run build', buildIdx > 0 && /ARG BUILD_ID/.test(build.slice(0, buildIdx)) && /ENV BUILD_ID=\$\{?BUILD_ID\}?/.test(build.slice(0, buildIdx)));
  const ciIdx = build.search(/RUN npm ci/);
  expect('Dockerfile build stage: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 before npm ci', ciIdx > 0 && /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1/.test(build.slice(0, ciIdx)));
  const fin = finalStage(df);
  const userLines = [...fin.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
  const lastUser = userLines[userLines.length - 1];
  const entry = fin.match(/^ENTRYPOINT\s+(.+)$/m)?.[1] ?? '';
  const ep = f.entrypoint ?? '';
  const epDrops = /docker-entrypoint\.sh/.test(entry)
    && /chown[^\n]*node:node[^\n]*\/app\/data|chown[^\n]*node:node[^\n]*"\$DATA_DIR"/.test(ep)
    && /exec\s+setpriv\s+--reuid[= ]node\s+--regid[= ]node\s+--init-groups/.test(ep)
    && /exit 1/.test(ep);
  expect('image drops root: final USER node, or an ENTRYPOINT that chowns /app/data and execs setpriv to node (online-19)',
    (lastUser && lastUser !== 'root' && lastUser !== '0') || epDrops, `USER=${lastUser ?? '(none)'} ENTRYPOINT=${entry || '(none)'}`);
  expect('Dockerfile runtime: NODE_ENV=production, no PIRATES_BR_DEV', /ENV NODE_ENV=production/.test(fin) && !/PIRATES_BR_DEV/.test(df));
  const ign = f.dockerignore.split('\n').map((s) => s.trim());
  expect('.dockerignore keeps node_modules, data and .env out of the context', ['node_modules', 'data', '.env'].every((x) => ign.includes(x)));
  return out;
}

// ── run ───────────────────────────────────────────────────────────────────
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const opt = (p) => (existsSync(join(ROOT, p)) ? read(p) : null);
const files = {
  flyToml: read('fly.toml'),
  dockerfile: read('Dockerfile'),
  entrypoint: opt('scripts/docker-entrypoint.sh'),
  dockerignore: read('.dockerignore'),
  deployMd: read('DEPLOY.md'),
  deployYml: opt('.github/workflows/deploy.yml'),
};

let failed = 0;
console.log(`test-deploy-config${REQUIRE_MEASURED ? ' --require-measured' : ''}`);
for (const r of check(files, realGit, { requireMeasured: REQUIRE_MEASURED })) {
  if (r.ok) console.log(`  ✓ ${r.clause}`);
  else { failed++; console.log(`  ✗ ${r.clause}${r.detail ? `  [${r.detail}]` : ''}`); }
}
const row = parseCapacityRow(files.deployMd);
if (row?.measuredAtCommit === 'unmeasured' && !REQUIRE_MEASURED) {
  console.log(`  WARN capacity is UNMEASURED on Fly: MAX_MATCHES held at ${PROVISIONAL_MAX_MATCHES}; b1.3c's remote soak must stamp the row`);
}

// Mutations: each must turn at least one clause red, or the gate is vacuous.
const fakeGit = (fresh) => ({
  lastSrcCommit: () => 'b'.repeat(40),
  resolve: (s) => (/^[0-9a-f]{7,40}$/.test(s) ? s : null),
  isAncestor: () => fresh,
});
const measuredRow = (md, cells) => md.replace(/(## Capacity record[\s\S]*?\n\|[^\n]*\n\|[^\n]*\n)\|[^\n]*\n/, `$1| ${cells.join(' | ')} |\n`);
const size = String((parseToml(files.flyToml).vm ?? [])[0]?.size ?? 'performance-1x');
const MUTATIONS = [
  ['shared-cpu VM', { flyToml: files.flyToml.replace(/size = "[^"]+"/, 'size = "shared-cpu-2x"') }],
  ['[[mounts]] removed', { flyToml: files.flyToml.replace(/^\[\[mounts\]\][\s\S]*?destination = "\/app\/data"/m, '') }],
  ['auto_stop_machines = true', { flyToml: files.flyToml.replace(/auto_stop_machines = \S+/, 'auto_stop_machines = true') }],
  ['kill_timeout 15s with a 10 s drain', { flyToml: files.flyToml.replace(/kill_timeout = "[^"]+"/, 'kill_timeout = "15s"') }],
  ['MAX_MATCHES 3 while unmeasured', { flyToml: files.flyToml.replace(/PIRATES_BR_MAX_MATCHES = "\d+"/, 'PIRATES_BR_MAX_MATCHES = "3"') }],
  ['MAX_MATCHES above a measured row', {
    flyToml: files.flyToml.replace(/PIRATES_BR_MAX_MATCHES = "\d+"/, 'PIRATES_BR_MAX_MATCHES = "5"'),
    deployMd: measuredRow(files.deployMd, [size, '4', 'a'.repeat(12), '0.04', '7', '2026-09-23']),
  }, fakeGit(true)],
  ['measured row older than the last src commit', { deployMd: measuredRow(files.deployMd, [size, '2', 'a'.repeat(12), '0.04', '0', '2026-09-23']) }, fakeGit(false)],
  ['measured row over the lag budget', { deployMd: measuredRow(files.deployMd, [size, '2', 'a'.repeat(12), '0.2', '0', '2026-09-23']) }, fakeGit(true)],
  ['capacity row removed', { deployMd: files.deployMd.replace(/## Capacity record/, '## Capacity notes') }],
  ["'fly deploy' without --ha=false in DEPLOY.md", { deployMd: `${files.deployMd}\n    fly deploy --remote-only\n` }],
  ["'fly launch' in DEPLOY.md", { deployMd: `${files.deployMd}\nfly launch --no-deploy\n` }],
  ['deploy.yml deploy without --ha=false', { deployYml: '      - run: flyctl deploy --remote-only --build-arg BUILD_ID=${{ github.sha }}\n' }],
  ['deploy.yml deleted', { deployYml: null }],
  ['literal fly token in deploy.yml', { deployYml: (files.deployYml ?? '').replace(/FLY_API_TOKEN: \$\{\{ secrets\.FLY_API_TOKEN \}\}/, 'FLY_API_TOKEN: FlyV1 fm2_lJPECAAAAAAAAAAA') }],
  ['fly token from repo vars, not secrets', { deployYml: (files.deployYml ?? '').replace(/secrets\.FLY_API_TOKEN/, 'vars.FLY_API_TOKEN') }],
  ['no smoke after the deploy', { deployYml: (files.deployYml ?? '').replace(/^.*node scripts\/smoke-online\.mjs --build-id.*$/m, '        run: echo deployed') }],
  ['no wait-idle before the deploy', { deployYml: (files.deployYml ?? '').replace(/^.*node scripts\/wait-idle\.mjs.*$/m, '        run: echo go') }],
  ['no rollback on a red smoke', { deployYml: (files.deployYml ?? '').replace(/^.*--image.*$/m, '          echo no rollback') }],
  ['deploys can cancel each other', { deployYml: (files.deployYml ?? '').replace(/cancel-in-progress: false/, 'cancel-in-progress: true') }],
  ['Dockerfile never drops root', { dockerfile: files.dockerfile.replace(/^ENTRYPOINT.*$/m, '').replace(/^USER.*$/gm, '') }],
  ['entrypoint falls back to root', { entrypoint: (files.entrypoint ?? '').replace(/exec\s+setpriv[^\n]*/g, 'exec "$@"') }],
  ['no BUILD_ID build-arg', { dockerfile: files.dockerfile.replace(/^ARG BUILD_ID.*$/m, '') }],
  ['PIRATES_BR_DEV in fly.toml env', { flyToml: files.flyToml.replace(/\[env\]/, '[env]\n  PIRATES_BR_DEV = "1"') }],
  ['public URL not in the origin allowlist', { flyToml: files.flyToml.replace(/PIRATES_BR_ALLOWED_ORIGINS = "[^"]*"/, 'PIRATES_BR_ALLOWED_ORIGINS = "https://example.com"') }],
];
// A mutation counts only if it turns a clause red that is NOT already red on the
// real files (green there, or not evaluated there), so a red HEAD cannot pass for it.
let vacuous = 0;
for (const [name, patch, git] of MUTATIONS) {
  const alreadyRed = new Set(check(files, git ?? realGit).filter((r) => !r.ok).map((r) => r.clause));
  const res = check({ ...files, ...patch }, git ?? realGit, { requireMeasured: false });
  const red = res.filter((r) => !r.ok && !alreadyRed.has(r.clause));
  if (red.length) console.log(`  ✓ MUTATION ${name} -> FAIL (${red[0].clause})`);
  else { vacuous++; console.log(`  ✗ MUTATION ${name} stayed green: that clause cannot fail`); }
}
if (!REQUIRE_MEASURED && row?.measuredAtCommit === 'unmeasured') {
  const res = check(files, realGit, { requireMeasured: true });
  const ok = res.some((r) => !r.ok);
  console.log(ok ? '  ✓ MUTATION --require-measured on an unmeasured row -> FAIL' : '  ✗ MUTATION --require-measured on an unmeasured row stayed green');
  if (!ok) vacuous++;
}

if (failed || vacuous) {
  console.log(`\nFAIL test-deploy-config: ${failed} clause(s) red, ${vacuous} vacuous mutation(s)`);
  process.exit(1);
}
console.log('\nPASS test-deploy-config');
