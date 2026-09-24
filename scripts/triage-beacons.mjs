#!/usr/bin/env node
// TRIAGE BEACONS (b1.7c, D35, critique gap 14): the read-only pull every bN.0
// live-ops lane starts from. Fetches the key-protected /health/beacons and
// /health/telemetry from the live URL and prints
//   - every error signature seen in >= --min-sessions sessions (default 3),
//     with its builds and device classes (each one is a fix inside the batch),
//   - the fps share per device class: sessions whose rendered fps p50 holds
//     the D35 line (phone/tablet >= 24, desktop >= 45), plus n, completed
//     matches and reload-without-clean-exit (memory-kill) counts.
//
//   HEALTH_KEY=... node scripts/triage-beacons.mjs --url https://pirates-br.fly.dev [--since-days 14] [--min-sessions 3] [--json]
//
// Exit 0 = pulled and printed; 2 = the store refused (403: wrong/missing key) or
// the URL did not answer. The plain pull never writes anything anywhere.
//
// THE bN.0 TRIAGE REPORT AND ITS GATE (b2.0a, PLAN rule 14):
//   node scripts/triage-beacons.mjs --report --batch b2 [--fly] [--app pirates-br]
//     pulls as above (plus, with --fly, the read-only `fly status` and
//     `fly logs --no-tail`) and writes $D/batches/<batch>/triage.json: every
//     signature seen in >= --min-sessions sessions with a `fixCommit` and a
//     `prependedSlice` slot. The lane fills one of the two per signature; a
//     re-pull keeps what was filled (keyed by the store's stable `sig`). A pull
//     that cannot happen (app not created, key missing) is still written, with
//     pulled:false and blockedOn, and exits 3 (blocked on an owner step).
//   node scripts/triage-beacons.mjs --check --batch b2 [--self-test]
//     the batch-gate verdict: FAIL when the report is missing, is for another
//     batch, never pulled real data (VACUOUS: a gate over no sessions proves
//     nothing), or lists a signature with neither a fix commit that exists in
//     git and is tagged [<batch>.0-><lane>] nor a prepended <batch>.<lane>.z0
//     slice. --self-test first proves every one of those red cases is red.
//   $D = PIRATES_BR_CAMPAIGN_DIR or the 2026-09-22 campaign dir (--dir overrides).

export const FPS_LINES = { phone: 24, tablet: 24, desktop: 45 };

function parseArgs(argv) {
  const out = { url: process.env.PIRATES_BR_PUBLIC_URL || 'https://pirates-br.fly.dev', key: process.env.HEALTH_KEY || '', sinceDays: 14, minSessions: 3, json: false,
    report: false, check: false, selfTest: false, fly: false, batch: null, app: 'pirates-br',
    dir: process.env.PIRATES_BR_CAMPAIGN_DIR || '/Users/tobiasdicker/.claude/pirates-br-audit/2026-09-22' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--since-days') out.sinceDays = Number(argv[++i]);
    else if (a === '--min-sessions') out.minSessions = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--report') out.report = true;
    else if (a === '--check') out.check = true;
    else if (a === '--self-test') out.selfTest = true;
    else if (a === '--fly') out.fly = true;
    else if (a === '--batch') out.batch = argv[++i];
    else if (a === '--app') out.app = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
  }
  return out;
}

/** Pulls both reports and grades them. Throws on a refused or failed pull. */
export async function triage({ url, key, sinceDays = 14, minSessions = 3, fetchImpl = globalThis.fetch } = {}) {
  const base = String(url).replace(/\/+$/, '');
  const q = sinceDays > 0 ? `?sinceHours=${Math.round(sinceDays * 24)}` : '';
  const headers = key ? { 'x-health-key': key } : {};
  const pull = async (path) => {
    const res = await fetchImpl(`${base}${path}${q}`, { headers });
    if (res.status !== 200) throw new Error(`${path} answered ${res.status}${res.status === 403 ? ' (HEALTH_KEY missing or wrong)' : ''}`);
    return res.json();
  };
  const beacons = await pull('/health/beacons');
  const telemetry = await pull('/health/telemetry');
  const signatures = (beacons.signatures ?? [])
    .filter((g) => g.count >= minSessions)
    .sort((a, b) => b.count - a.count);
  const classes = {};
  for (const s of telemetry.recent ?? []) {
    const c = (classes[s.device] ??= { n: 0, graded: 0, holding: 0, completed: 0, killed: 0, contextLosses: 0 });
    c.n += 1;
    if (s.matchCompleted) c.completed += 1;
    if (s.reloadWithoutCleanExit) c.killed += 1;
    c.contextLosses += s.contextLosses ?? 0;
    const line = FPS_LINES[s.device];
    if (line !== undefined && s.frames > 0) {
      c.graded += 1;
      if (s.fpsP50 >= line) c.holding += 1;
    }
  }
  for (const [device, c] of Object.entries(classes)) {
    c.line = FPS_LINES[device] ?? null;
    c.share = c.graded > 0 ? c.holding / c.graded : null;
  }
  return { url: base, sinceDays, minSessions, sessions: telemetry.sessions ?? 0, errorsTotal: beacons.total ?? 0, signatures, classes };
}

export function formatTriage(r) {
  const lines = [];
  lines.push(`triage ${r.url} last ${r.sinceDays} d: ${r.sessions} session summaries, ${r.errorsTotal} error reports`);
  lines.push(`signatures seen in >= ${r.minSessions} sessions: ${r.signatures.length}`);
  for (const g of r.signatures) {
    const builds = Object.entries(g.builds ?? {}).map(([b, n]) => `${b}:${n}`).join(' ');
    const devices = Object.entries(g.devices ?? {}).map(([d, n]) => `${d}:${n}`).join(' ');
    lines.push(`  [${g.count}] ${g.kind} ${g.message}`);
    lines.push(`       at ${g.topFrame || '(no frame)'} | builds ${builds} | devices ${devices}`);
  }
  lines.push('fps share per device class (rendered fps p50 per session):');
  for (const [device, c] of Object.entries(r.classes)) {
    const share = c.share === null ? 'n/a' : `${(c.share * 100).toFixed(0)}%`;
    lines.push(`  ${device}: ${share} of ${c.graded} graded sessions >= ${c.line ?? '?'} fps (n=${c.n}, completed ${c.completed}, killed ${c.killed}, context losses ${c.contextLosses})`);
  }
  return lines.join('\n');
}

// ── the bN.0 triage report + gate ───────────────────────────────────────────

export const sigKey = (g) => g.sig ?? `${g.kind}|${g.message}|${g.topFrame}`;

/** Folds a fly log dump into what triage needs: lifecycle counts + error lines. */
export function summariseFlyLogs(text) {
  const lines = String(text ?? '').split('\n').filter((l) => l.trim());
  const events = {};
  for (const l of lines) {
    const m = /"(?:event|evt)"\s*:\s*"([\w-]+)"/.exec(l);
    if (m) events[m[1]] = (events[m[1]] ?? 0) + 1;
  }
  const errors = lines.filter((l) => /\b(error|uncaught|unhandled|panic|oom|out of memory|exited with code [1-9])/i.test(l));
  return { lines: lines.length, events, errorLines: errors.length, errorSamples: errors.slice(0, 8).map((l) => l.slice(0, 240)) };
}

/**
 * The report a bN.0 lane commits to the campaign dir. `pull` is triage()'s
 * result or null (then `blockedOn` says why). Resolutions already filled in
 * `previous` survive a re-pull.
 */
export function buildReport({ batch, pull = null, blockedOn = null, fly = null, previous = null, now = new Date() }) {
  const prior = new Map((previous?.signatures ?? []).map((g) => [g.key, g]));
  const signatures = (pull?.signatures ?? []).map((g) => {
    const key = sigKey(g);
    const was = prior.get(key) ?? {};
    return { key, count: g.count, kind: g.kind, message: g.message, topFrame: g.topFrame ?? '', builds: g.builds ?? {}, devices: g.devices ?? {},
      fixCommit: was.fixCommit ?? null, prependedSlice: was.prependedSlice ?? null, note: was.note ?? null };
  });
  return {
    batch, generatedAt: now.toISOString(), pulled: !!pull, blockedOn: pull ? null : (blockedOn ?? 'unknown'),
    url: pull?.url ?? null, sinceDays: pull?.sinceDays ?? null, minSessions: pull?.minSessions ?? 3,
    sessions: pull?.sessions ?? 0, errorsTotal: pull?.errorsTotal ?? 0, fly, classes: pull?.classes ?? {}, signatures,
  };
}

/**
 * Gate verdict over a triage report. `commitSubject(sha)` returns the commit's
 * subject line or null when git does not know it. Returns { ok, lines }.
 */
export function checkTriage(report, { batch, commitSubject }) {
  const lines = [];
  const bad = (m) => { lines.push(`✗ ${m}`); };
  if (!report) { bad(`no triage report for ${batch} (run --report --batch ${batch})`); return { ok: false, lines }; }
  if (report.batch !== batch) bad(`report is for ${report.batch}, the gate is ${batch}`);
  if (!report.pulled) bad(`VACUOUS: the report never pulled real sessions (blockedOn: ${report.blockedOn ?? 'unknown'})`);
  const min = report.minSessions ?? 3;
  const n = batch.replace(/^b/, '');
  const hookTag = new RegExp(`\\[b${n}\\.0->b${n}\\.\\d+\\]`);
  const sliceId = new RegExp(`^b${n}\\.\\d+\\.z0$`);
  for (const g of report.signatures ?? []) {
    if (g.count < min) continue;
    const label = `[${g.count}] ${g.kind} ${String(g.message).slice(0, 80)}`;
    if (g.fixCommit) {
      const subj = commitSubject(g.fixCommit);
      if (subj === null) { bad(`${label}: fixCommit ${g.fixCommit} is not in git`); continue; }
      if (!hookTag.test(subj)) { bad(`${label}: fixCommit ${g.fixCommit} is not tagged [${batch}.0-><lane>] ("${subj.slice(0, 60)}")`); continue; }
      lines.push(`✓ ${label}: fixed in ${g.fixCommit}`);
    } else if (g.prependedSlice) {
      if (!sliceId.test(g.prependedSlice)) { bad(`${label}: prependedSlice ${g.prependedSlice} is not a ${batch}.<lane>.z0 slice`); continue; }
      lines.push(`✓ ${label}: handed to ${g.prependedSlice}`);
    } else bad(`${label}: neither a fix commit nor a prepended slice`);
  }
  const ok = !lines.some((l) => l.startsWith('✗'));
  if (ok) lines.push(`✓ ${batch} triage: ${report.sessions} sessions, ${(report.signatures ?? []).filter((g) => g.count >= min).length} signature(s) >= ${min} sessions, all resolved`);
  return { ok, lines };
}

/** Every red case of checkTriage must be red, the green ones green. */
export function selfTest() {
  const out = [];
  const subjects = { aaa1111: '[b2.0->b2.3] a: guard hold mesh dispose', bbb2222: '[b2.3] c: something else' };
  const commitSubject = (sha) => subjects[sha] ?? null;
  const sig = (count, extra = {}) => ({ sig: `s${count}${extra.fixCommit ?? ''}${extra.prependedSlice ?? ''}`, count, kind: 'error', message: 'TypeError: x', topFrame: 'a.js:1', ...extra });
  const pulled = (sigs) => ({ ...buildReport({ batch: 'b2', pull: { url: 'u', sinceDays: 14, minSessions: 3, sessions: 40, errorsTotal: 9, signatures: sigs, classes: {} } }), signatures: sigs.map((g) => ({ ...g, key: sigKey(g) })) });
  const cases = [
    ['missing report', null, false],
    ['report for another batch', { ...pulled([]), batch: 'b3' }, false],
    ['never pulled (app not deployed)', buildReport({ batch: 'b2', blockedOn: 'O2' }), false],
    ['signature with neither', pulled([sig(3)]), false],
    ['fixCommit unknown to git', pulled([sig(4, { fixCommit: 'deadbee' })]), false],
    ['fixCommit without the [b2.0->lane] tag', pulled([sig(4, { fixCommit: 'bbb2222' })]), false],
    ['prepended slice of another batch', pulled([sig(5, { prependedSlice: 'b3.1.z0' })]), false],
    ['prepended slice that is not a z0', pulled([sig(5, { prependedSlice: 'b2.1.a' })]), false],
    ['pulled, no signatures', pulled([]), true],
    ['2-session signature needs nothing', pulled([sig(2)]), true],
    ['hook commit + prepended slice', pulled([sig(3, { fixCommit: 'aaa1111' }), sig(7, { prependedSlice: 'b2.4.z0' })]), true],
  ];
  for (const [name, rep, want] of cases) {
    const got = checkTriage(rep, { batch: 'b2', commitSubject }).ok;
    out.push(`${got === want ? '✓' : '✗'} self-test: ${name} -> ${got ? 'green' : 'red'} (want ${want ? 'green' : 'red'})`);
  }
  const prev = { signatures: [{ key: 'k1', fixCommit: 'aaa1111' }] };
  const carried = buildReport({ batch: 'b2', pull: { signatures: [{ sig: 'k1', count: 3 }, { sig: 'k2', count: 3 }] }, previous: prev });
  const keep = carried.signatures[0].fixCommit === 'aaa1111' && carried.signatures[1].fixCommit === null;
  out.push(`${keep ? '✓' : '✗'} self-test: a re-pull keeps the filled resolution and adds the new signature open`);
  const fl = summariseFlyLogs('x {"event":"match_end"}\ny {"event":"match_end"}\nz Uncaught TypeError: q\n');
  const flOk = fl.lines === 3 && fl.events.match_end === 2 && fl.errorLines === 1;
  out.push(`${flOk ? '✓' : '✗'} self-test: fly log summary counts lifecycle events and error lines`);
  return { ok: !out.some((l) => l.startsWith('✗')), lines: out };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest || args.check || args.report) await gateMain(args);
  try {
    const r = await triage(args);
    console.log(args.json ? JSON.stringify(r, null, 2) : formatTriage(r));
  } catch (err) {
    console.error(`triage-beacons: ${err.message}`);
    process.exit(2);
  }
}

async function gateMain(args) {
  const { execFileSync, spawnSync } = await import('node:child_process');
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const path = await import('node:path');
  let ok = true;
  if (args.selfTest) {
    const st = selfTest();
    for (const l of st.lines) console.log(l);
    ok = st.ok;
    if (!args.check && !args.report) { console.log(ok ? 'PASS triage self-test' : 'FAIL triage self-test'); process.exit(ok ? 0 : 1); }
  }
  if (!args.batch || !/^b\d+$/.test(args.batch)) { console.error('triage-beacons: --report/--check need --batch bN'); process.exit(2); }
  const file = path.join(args.dir, 'batches', args.batch, 'triage.json');
  const previous = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (args.report) {
    let fly = null;
    let blockedOn = null;
    if (args.fly) {
      const run = (a) => spawnSync('fly', a, { encoding: 'utf8', timeout: 60_000 });
      const st = run(['status', '-a', args.app]);
      const txt = `${st.stdout ?? ''}${st.stderr ?? ''}`;
      const missing = /Could not find App/i.test(txt);
      fly = { app: args.app, status: st.status === 0 ? 'ok' : missing ? 'app-missing' : `exit ${st.status}`, statusText: txt.split('\n').filter((l) => l.trim() && !/^Warning: Metrics token/.test(l)).slice(0, 12) };
      if (st.status === 0) { const lg = run(['logs', '-a', args.app, '--no-tail']); fly.logs = summariseFlyLogs(`${lg.stdout ?? ''}`); }
      if (missing) blockedOn = `O2: Fly app "${args.app}" does not exist (never deployed; app creation refused on overdue invoices, OD4)`;
    }
    let pull = null;
    if (!blockedOn) {
      try { pull = await triage(args); } catch (err) { blockedOn = `pull failed: ${err.message}${args.key ? '' : ' (HEALTH_KEY unset: ~/.config/pirates-br/fly-<app>.env)'}`; }
    }
    const rep = buildReport({ batch: args.batch, pull, blockedOn, fly, previous });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(rep, null, 1)}\n`);
    console.log(`wrote ${file}: pulled=${rep.pulled} sessions=${rep.sessions} signatures>=${rep.minSessions}=${rep.signatures.filter((g) => g.count >= rep.minSessions).length}${rep.blockedOn ? ` blockedOn=${rep.blockedOn}` : ''}`);
    if (pull) console.log(formatTriage(pull));
    if (!args.check) process.exit(rep.pulled ? 0 : 3);
  }
  const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const commitSubject = (sha) => { try { return execFileSync('git', ['log', '-1', '--format=%s', sha], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  const v = checkTriage(report, { batch: args.batch, commitSubject });
  for (const l of v.lines) console.log(l);
  ok = ok && v.ok;
  console.log(ok ? `PASS ${args.batch} triage gate` : `FAIL ${args.batch} triage gate (${file})`);
  process.exit(ok ? 0 : 1);
}
