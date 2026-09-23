#!/usr/bin/env node
// ci-rollback-dryrun (b1.3d, online-04): proves the CI deploy path of
// .github/workflows/deploy.yml, offline and live.
//
//   node scripts/ci-rollback-dryrun.mjs              # offline: runs the REAL step scripts of
//                                                    # deploy.yml under bash with fake flyctl/node/npm
//                                                    # for 7 scenarios (no network, no Fly, < 2 s)
//   node scripts/ci-rollback-dryrun.mjs --run <id>   # live: grades a GitHub run of deploy.yml
//        [--repo tdickers22-lgtm/pirates-br]         # dry run -> forced red smoke, NO deploy, rollback
//                                                    # names the image that was serving; real run ->
//                                                    # deploy + smoke green, rollback skipped
//   node scripts/ci-rollback-dryrun.mjs --file <yml> # offline, against another copy (mutation runs)
//
// Why a harness and not a regex: the rollback only matters on the day the smoke is red, and a
// workflow that "looks right" (test-deploy-config lints the shape) can still pick the wrong
// image, deploy during a dry run, or skip the rollback on a first deploy. Here the step `if:`
// expressions are evaluated with GitHub's step-status semantics and the `run:` scripts are
// executed exactly as written, so the outcome is observed, not inferred.
//
// Exit 0 = every clause PASS, 1 = a clause FAIL, 2 = bad args / unreadable workflow.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'tdickers22-lgtm/pirates-br';

// ---------------------------------------------------------------- workflow parsing
/** Minimal parser for the one workflow we own: job env + steps (name, id, if, run, uses). */
export function parseWorkflow(text) {
  const lines = text.split('\n');
  const env = {};
  const steps = [];
  let inEnv = false; let inSteps = false; let cur = null; let block = null;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue;
    const ind = raw.search(/\S/);
    if (block) {
      if (ind === -1 || ind >= block.indent) { cur.run += `${raw.slice(block.indent)}\n`; continue; }
      block = null;
    }
    if (ind === -1) continue;
    if (/^ {4}env:\s*$/.test(raw)) { inEnv = true; inSteps = false; continue; }
    if (/^ {4}steps:\s*$/.test(raw)) { inSteps = true; inEnv = false; continue; }
    if (ind <= 4) { inEnv = false; if (ind < 4) inSteps = false; continue; }
    if (inEnv && ind === 6) {
      const m = raw.match(/^\s+([A-Z_][A-Z0-9_]*):\s*(.*)$/);
      if (m) env[m[1]] = unquote(m[2]);
      continue;
    }
    if (!inSteps) continue;
    const item = raw.match(/^ {6}- (.*)$/);
    if (item) { cur = { run: null }; steps.push(cur); keyval(cur, item[1], 10); continue; }
    if (cur && ind === 8) keyval(cur, raw.trim(), 10);
  }
  function keyval(step, s, blockIndent) {
    const m = s.match(/^([a-z-]+):\s*(.*)$/);
    if (!m) return;
    if (m[1] === 'run' && /^[|>]-?\s*$/.test(m[2])) { step.run = ''; block = { indent: blockIndent }; return; }
    step[m[1]] = m[1] === 'run' ? m[2] : unquote(m[2]);
  }
  return { env, steps };
}
const unquote = (v) => v.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');

// ---------------------------------------------------------------- expressions
/** GitHub expression -> JS, evaluated against a context. Covers what deploy.yml uses. */
export function evalExpr(expr, ctx) {
  const js = expr.trim()
    .replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, '($1)')
    .replace(/!=/g, '!==').replace(/([^=!])==(?!=)/g, '$1===');
  const fns = {
    success: () => !ctx.failed, failure: () => ctx.failed, always: () => true, cancelled: () => false,
    startsWith: (a, b) => String(a ?? '').toLowerCase().startsWith(String(b ?? '').toLowerCase()),
    contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b ?? '').toLowerCase()),
  };
  const f = new Function(...Object.keys(fns), 'github', 'inputs', 'env', 'secrets', 'steps', `return (${js});`);
  return f(...Object.values(fns), ctx.github, ctx.inputs, ctx.env, ctx.secrets, ctx.steps);
}
const interpolate = (s, ctx) => String(s).replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_, e) => {
  const v = evalExpr(e, ctx); return v == null || v === false ? '' : String(v);
});
/** GitHub's rule: a step with no status function in its `if:` gets an implicit success(). */
function stepRuns(step, ctx) {
  if (step.if == null) return !ctx.failed;
  const expr = step.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '');
  const hasStatus = /\b(success|failure|always|cancelled)\(\)/.test(expr);
  return Boolean(evalExpr(hasStatus ? expr : `success() && (${expr})`, ctx));
}

// ---------------------------------------------------------------- simulated job
const FAKE_FLYCTL = `#!/bin/bash
echo "flyctl $*" >> "$SIM_DIR/flyctl.log"
if [ "$1 $2" = "machine list" ]; then cat "$SIM_DIR/machines.json"; exit 0; fi
if [ "$1" = "deploy" ]; then exit "\${SIM_DEPLOY_EXIT:-0}"; fi
exit 0
`;
const FAKE_NODE = `#!/bin/bash
echo "node $* HEALTH_KEY=\${HEALTH_KEY:-}" >> "$SIM_DIR/node.log"
case "$*" in
  *smoke-online.mjs*--skip-queue*) exit 0 ;;
  *smoke-online.mjs*) exit "\${SIM_SMOKE_EXIT:-0}" ;;
esac
exit 0
`;
const FAKE_NPM = '#!/bin/bash\necho "npm $*" >> "$SIM_DIR/npm.log"\nexit 0\n';

/** Runs the job: every `run:` step under bash with the fakes first on PATH. */
export function simulate(wf, sc) {
  const dir = mkdtempSync(join(tmpdir(), 'pbr-ci-sim-'));
  try {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    for (const [n, body] of [['flyctl', FAKE_FLYCTL], ['node', FAKE_NODE], ['npm', FAKE_NPM]]) {
      writeFileSync(join(bin, n), body); chmodSync(join(bin, n), 0o755);
    }
    writeFileSync(join(dir, 'machines.json'), JSON.stringify(sc.machines));
    for (const f of ['flyctl.log', 'node.log', 'npm.log', 'out', 'envfile']) writeFileSync(join(dir, f), '');
    const ctx = {
      github: { sha: sc.sha, ref: sc.ref, event_name: sc.event },
      inputs: sc.inputs ?? {}, secrets: sc.secrets ?? {}, steps: {}, env: {}, failed: false,
    };
    for (const [k, v] of Object.entries(wf.env)) ctx.env[k] = interpolate(v, ctx);
    const trace = [];
    for (const step of wf.steps) {
      const label = step.name ?? step.uses ?? step.run?.split('\n')[0];
      if (!stepRuns(step, ctx)) {
        trace.push({ label, id: step.id, outcome: 'skipped', out: '' });
        if (step.id) ctx.steps[step.id] = { outcome: 'skipped', outputs: {} };
        continue;
      }
      if (step.run == null) { trace.push({ label, id: step.id, outcome: 'success', out: '' }); continue; }
      writeFileSync(join(dir, 'out'), '');
      const script = interpolate(step.run, ctx);
      const r = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
        cwd: ROOT, encoding: 'utf8', timeout: 20_000,
        env: {
          PATH: `${bin}:${process.env.PATH}`, HOME: dir, SIM_DIR: dir,
          SIM_SMOKE_EXIT: String(sc.smokeExit ?? 0), SIM_DEPLOY_EXIT: String(sc.deployExit ?? 0),
          GITHUB_OUTPUT: join(dir, 'out'), GITHUB_ENV: join(dir, 'envfile'), ...ctx.env,
        },
      });
      const outcome = r.status === 0 ? 'success' : 'failure';
      const outputs = Object.fromEntries(readFileSync(join(dir, 'out'), 'utf8').split('\n')
        .filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      for (const l of readFileSync(join(dir, 'envfile'), 'utf8').split('\n')) {
        if (l.includes('=')) ctx.env[l.slice(0, l.indexOf('='))] = l.slice(l.indexOf('=') + 1);
      }
      writeFileSync(join(dir, 'envfile'), '');
      if (step.id) ctx.steps[step.id] = { outcome, outputs };
      if (outcome === 'failure') ctx.failed = true;
      trace.push({ label, id: step.id, outcome, out: `${r.stdout ?? ''}${r.stderr ?? ''}` });
    }
    const read = (f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean);
    return { trace, fly: read('flyctl.log'), node: read('node.log'), steps: ctx.steps, env: ctx.env, conclusion: ctx.failed ? 'failure' : 'success' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- offline gate
const PREV = 'registry.fly.io/pirates-br:deployment-01J8PREVIOUSRELEASE';
const OLD = 'registry.fly.io/pirates-br:deployment-01J7DESTROYEDMACHINE';
const serving = [{ id: 'e784', state: 'started', config: { image: PREV } }];
const SHA = '0123456789abcdef0123456789abcdef01234567';
const SCENARIOS = {
  dispatchDry: { event: 'workflow_dispatch', ref: 'refs/heads/release', inputs: { dry_run: true }, machines: serving, smokeExit: 0 },
  tagDry: { event: 'push', ref: 'refs/tags/deploy-dryrun-0123abcd', machines: serving, smokeExit: 0 },
  realRed: { event: 'push', ref: 'refs/heads/release', machines: serving, smokeExit: 1, secrets: { HEALTH_KEY: 'hk-test' } },
  realGreen: { event: 'push', ref: 'refs/heads/release', machines: serving, smokeExit: 0, secrets: { HEALTH_KEY: 'hk-test' } },
  dispatchReal: { event: 'workflow_dispatch', ref: 'refs/heads/release', inputs: { dry_run: false }, machines: serving, smokeExit: 0 },
  firstDeployRed: { event: 'push', ref: 'refs/heads/release', machines: [], smokeExit: 1 },
  destroyedFirst: { event: 'push', ref: 'refs/heads/release', machines: [{ id: 'd1', state: 'destroyed', config: { image: OLD } }, ...serving], smokeExit: 1 },
};

export function offlineClauses(wf) {
  const rows = [];
  const expect = (name, ok, detail = '') => rows.push({ name, ok: Boolean(ok), detail });
  const run = (k) => simulate(wf, { sha: SHA, ...SCENARIOS[k] });
  const realDeploys = (r) => r.fly.filter((l) => /^flyctl deploy\b/.test(l) && !/--image/.test(l));
  const rollbacks = (r) => r.fly.filter((l) => /^flyctl deploy\b.*--image/.test(l));
  const step = (r, re) => r.trace.find((t) => re.test(t.label ?? ''));
  const rbStep = (r) => step(r, /^Roll back/);

  for (const k of ['dispatchDry', 'tagDry']) {
    const r = run(k);
    const rb = rbStep(r);
    expect(`${k}: DRY_RUN resolves to 1`, r.env.DRY_RUN === '1', `DRY_RUN=${JSON.stringify(r.env.DRY_RUN)}`);
    expect(`${k}: records the serving image as the rollback target`, r.steps.prev?.outputs?.image === PREV, r.steps.prev?.outputs?.image ?? '(no prev step output)');
    expect(`${k}: never deploys (no flyctl deploy call at all)`, realDeploys(r).length === 0 && rollbacks(r).length === 0, r.fly.join(' | '));
    expect(`${k}: the smoke is forced red without touching the live URL`, r.steps.smoke?.outcome === 'failure' && !r.node.some((l) => /smoke-online/.test(l)), `${r.steps.smoke?.outcome} ${r.node.join(' | ')}`);
    expect(`${k}: the rollback step runs and names the previous release image`, rb?.outcome === 'success' && rb.out.includes(PREV), `${rb?.outcome} ${rb?.out.trim().split('\n').pop() ?? ''}`);
  }
  {
    const r = run('realRed');
    const d = realDeploys(r);
    expect('realRed: one real deploy, --ha=false, BUILD_ID = the pushed sha', d.length === 1 && /--ha=false/.test(d[0]) && d[0].includes(`BUILD_ID=${SHA}`) && /-a pirates-br\b/.test(d[0]), d.join(' | '));
    expect('realRed: the smoke gets the deployed build id and HEALTH_KEY', r.node.some((l) => /smoke-online\.mjs --build-id/.test(l) && l.includes(SHA) && /HEALTH_KEY=hk-test/.test(l)), r.node.join(' | '));
    expect('realRed: a red smoke redeploys exactly the previous image, --ha=false', rollbacks(r).length === 1 && rollbacks(r)[0].includes(`--image ${PREV}`) && /--ha=false/.test(rollbacks(r)[0]), rollbacks(r).join(' | '));
    expect('realRed: the rolled-back build is smoked again', r.node.some((l) => /smoke-online\.mjs.*--skip-queue/.test(l)), r.node.join(' | '));
    expect('realRed: the run still concludes failure (a rollback is not a green deploy)', r.conclusion === 'failure', r.conclusion);
  }
  {
    const r = run('realGreen');
    expect('realGreen: deploy + smoke green, no rollback, conclusion success', realDeploys(r).length === 1 && rollbacks(r).length === 0 && r.conclusion === 'success' && rbStep(r)?.outcome === 'skipped', `${r.conclusion} ${r.fly.join(' | ')}`);
    expect('realGreen: a real push is never a dry run', r.env.DRY_RUN === '' || r.env.DRY_RUN == null, JSON.stringify(r.env.DRY_RUN));
  }
  {
    const r = run('dispatchReal');
    expect('dispatchReal (dry_run=false): deploys for real', realDeploys(r).length === 1 && r.conclusion === 'success', r.fly.join(' | '));
  }
  {
    const r = run('firstDeployRed');
    expect('firstDeployRed: no machine yet -> no rollback target, rollback skipped (no deploy --image "")', rollbacks(r).length === 0 && rbStep(r)?.outcome === 'skipped', `${rbStep(r)?.outcome} ${r.fly.join(' | ')}`);
  }
  {
    const r = run('destroyedFirst');
    expect('destroyedFirst: a destroyed machine listed first is never the rollback target', r.steps.prev?.outputs?.image === PREV && rollbacks(r).every((l) => l.includes(PREV)), `${r.steps.prev?.outputs?.image} ${rollbacks(r).join(' | ')}`);
  }
  return rows;
}

// ---------------------------------------------------------------- live grading
function gh(args) { return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }); }
export function liveClauses(runId, repo) {
  const rows = [];
  const expect = (name, ok, detail = '') => rows.push({ name, ok: Boolean(ok), detail });
  const meta = JSON.parse(gh(['run', 'view', String(runId), '-R', repo, '--json', 'conclusion,status,headSha,headBranch,event,jobs,workflowName']));
  const log = gh(['run', 'view', String(runId), '-R', repo, '--log']);
  const steps = meta.jobs?.[0]?.steps ?? [];
  const st = (re) => steps.find((s) => re.test(s.name));
  // Log lines are "<job>\t<step>\t<timestamp> <text>"; the echoed script sits under ##[group]Run.
  const out = (re) => log.split('\n').filter((l) => re.test(l.split('\t')[1] ?? '')).map((l) => l.split('\t').slice(2).join('\t').replace(/^\S+Z /, ''))
    .filter((l) => !/^##\[group\]|^\s{2}\S|^##\[endgroup\]/.test(l) || /^##\[error\]/.test(l));
  expect(`run ${runId} is deploy.yml and completed`, meta.workflowName === 'deploy' && meta.status === 'completed', `${meta.workflowName} ${meta.status}`);
  const prevLine = out(/Record the image/).find((l) => /previous image:/.test(l)) ?? '';
  const prev = prevLine.replace(/.*previous image:\s*/, '').trim();
  const dry = out(/Smoke/).some((l) => /DRY-RUN: forced smoke failure/.test(l));
  if (dry) {
    expect('dry run: the serving image was recorded', /^registry\.fly\.io\/\S+(:|@sha256:)\S+$/.test(prev), prevLine || '(no "previous image:" line)');
    expect('dry run: the deploy step did not build or release anything', !/Visit your newly deployed app|==> Building image|Updating existing machines/.test(out(/^Deploy/).join('\n')), st(/^Deploy/)?.conclusion);
    const rb = out(/Roll back/).join('\n');
    expect('dry run: the rollback step ran on the forced red smoke', st(/Roll back/)?.conclusion === 'success', st(/Roll back/)?.conclusion);
    expect('dry run: the rollback selects the previous release image', prev && rb.includes(`would run: flyctl deploy --image ${prev}`), rb.split('\n').find((l) => /would run/.test(l)) ?? '(no would-run line)');
  } else {
    expect('real run: conclusion success', meta.conclusion === 'success', meta.conclusion);
    expect('real run: deploy step success', st(/^Deploy/)?.conclusion === 'success', st(/^Deploy/)?.conclusion);
    expect('real run: smoke-online green against the deployed sha', st(/Smoke/)?.conclusion === 'success' && out(/Smoke/).some((l) => /PASS smoke-online/.test(l)) && out(/Smoke/).some((l) => l.includes(`expecting build ${meta.headSha}`)), st(/Smoke/)?.conclusion);
    expect('real run: rollback skipped', st(/Roll back/)?.conclusion === 'skipped', st(/Roll back/)?.conclusion);
  }
  return rows;
}

// ---------------------------------------------------------------- main
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const file = resolve(arg('--file') ?? join(ROOT, '.github/workflows/deploy.yml'));
  let rows;
  if (arg('--run')) {
    rows = liveClauses(arg('--run'), arg('--repo') ?? REPO);
  } else {
    if (!existsSync(file)) { console.error(`ci-rollback-dryrun: ${file} not found`); process.exit(2); }
    rows = offlineClauses(parseWorkflow(readFileSync(file, 'utf8')));
  }
  for (const r of rows) console.log(`${r.ok ? '  ✓' : '  ✗'} ${r.name}${r.ok ? '' : `  [${r.detail}]`}`);
  const bad = rows.filter((r) => !r.ok).length;
  console.log(bad ? `\nFAIL ci-rollback-dryrun (${bad}/${rows.length} clause(s) red)` : `\nPASS ci-rollback-dryrun (${rows.length} clauses)`);
  process.exit(bad ? 1 : 0);
}
