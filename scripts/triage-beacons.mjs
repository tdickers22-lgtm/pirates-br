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
// the URL did not answer. It never writes anything anywhere.

export const FPS_LINES = { phone: 24, tablet: 24, desktop: 45 };

function parseArgs(argv) {
  const out = { url: process.env.PIRATES_BR_PUBLIC_URL || 'https://pirates-br.fly.dev', key: process.env.HEALTH_KEY || '', sinceDays: 14, minSessions: 3, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') out.url = argv[++i];
    else if (a === '--key') out.key = argv[++i];
    else if (a === '--since-days') out.sinceDays = Number(argv[++i]);
    else if (a === '--min-sessions') out.minSessions = Number(argv[++i]);
    else if (a === '--json') out.json = true;
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

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const r = await triage(args);
    console.log(args.json ? JSON.stringify(r, null, 2) : formatTriage(r));
  } catch (err) {
    console.error(`triage-beacons: ${err.message}`);
    process.exit(2);
  }
}
