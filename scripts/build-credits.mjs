#!/usr/bin/env node
/**
 * BUILD CREDITS (b1.5b: vm:online:5, vm:audio:6, D3 licensing hygiene).
 *
 * Every third-party file we ship gets a row in a LICENSES.md next to it
 * (public/assets/audio/LICENSES.md is the D3 one; models, textures and fonts
 * follow the same shape). This script reads EVERY LICENSES.md in the repo,
 * parses every markdown table in it by header name, and writes one
 * public/credits.json that the menu's Credits panel renders. No timestamp in
 * the output: the same inputs always give the same bytes, so
 * scripts/test-front-door.mjs can fail a stale file.
 *
 *   node scripts/build-credits.mjs          # rewrite public/credits.json
 *   node scripts/build-credits.mjs --check  # exit 1 if it is stale
 *
 * Column names are matched loosely (File/Asset/Name, Source/URL, Author/Creator/
 * By, License/Licence). A CC-BY row with no author, or any NC / personal-use /
 * non-commercial / "all rights reserved" row, is a licence problem: the gate
 * fails it, because D3 allows neither.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const HEADER_ALIASES = {
  file: ['file', 'files', 'asset', 'name', 'item', 'sound', 'model', 'texture', 'font'],
  source: ['source', 'url', 'link', 'origin', 'source url'],
  author: ['author', 'authors', 'creator', 'by', 'artist', 'credit'],
  license: ['license', 'licence', 'licensing'],
  notes: ['notes', 'note', 'use', 'used for', 'changes'],
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'test-results', 'pirates-br', '.vite', 'coverage']);

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}
function fieldFor(header) {
  const h = header.toLowerCase().replace(/[`*_]/g, '').trim();
  for (const [field, names] of Object.entries(HEADER_ALIASES)) if (names.includes(h)) return field;
  return null;
}
function clean(v) {
  // [text](url) -> url for sources, text elsewhere; strip code ticks and emphasis.
  return v.replace(/`/g, '').replace(/\*\*?/g, '').trim();
}
function linkTarget(v) {
  return v.match(/\]\(([^)]+)\)/)?.[1] ?? v.match(/<(https?:[^>]+)>/)?.[1] ?? v;
}
function linkText(v) {
  return v.match(/\[([^\]]*)\]\(/)?.[1] ?? v;
}

/** Every data row of every markdown table in `text`, keyed by header name. */
export function parseLicensesMd(text, from) {
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) continue;
    const fields = cells(lines[i]).map(fieldFor);
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j += 1) {
      const vals = cells(lines[j]);
      if (vals.every((v) => v === '')) continue;
      const row = { file: '', source: '', author: '', license: '', notes: '', from };
      fields.forEach((f, k) => {
        if (!f || vals[k] === undefined) return;
        const raw = vals[k];
        row[f] = clean(f === 'source' ? linkTarget(raw) : linkText(raw));
      });
      rows.push(row);
    }
    i = j - 1;
  }
  return rows;
}

/** Rows D3 forbids: NC / personal-use / all-rights-reserved, CC-BY without a credit, no licence at all. */
export function licenseProblems(rows) {
  const out = [];
  for (const r of rows) {
    const lic = String(r.license ?? '');
    if (!lic) out.push({ file: r.file, why: 'no licence' });
    else if (/\bNC\b|non-?commercial|personal|all rights reserved|editorial/i.test(lic)) out.push({ file: r.file, why: `forbidden licence: ${lic}` });
    else if (/CC[\s-]*BY/i.test(lic) && !String(r.author ?? '').trim()) out.push({ file: r.file, why: 'CC-BY row without an author to credit' });
  }
  return out;
}

export function findLicenseFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/^LICEN[CS]ES?\.md$/i.test(name)) found.push(relative(root, p));
    }
  };
  walk(root);
  return found.sort();
}

export function buildCredits(root) {
  const sources = findLicenseFiles(root);
  const rows = [];
  for (const src of sources) rows.push(...parseLicensesMd(readFileSync(join(root, src), 'utf8'), src));
  return {
    generatedBy: 'scripts/build-credits.mjs (do not hand-edit; add rows to a LICENSES.md and rerun)',
    engine: [
      { name: 'three.js', license: 'MIT', source: 'https://threejs.org' },
      { name: 'ws', license: 'MIT', source: 'https://github.com/websockets/ws' },
    ],
    sources,
    rows,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = new URL('..', import.meta.url).pathname;
  const built = buildCredits(root);
  const out = join(root, 'public/credits.json');
  const text = `${JSON.stringify(built, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    let cur = '';
    try { cur = readFileSync(out, 'utf8'); } catch { /* missing = stale */ }
    if (cur !== text) { console.error('build-credits: public/credits.json is stale; run node scripts/build-credits.mjs'); process.exit(1); }
    console.log(`build-credits: fresh (${built.sources.length} files, ${built.rows.length} rows)`);
  } else {
    writeFileSync(out, text);
    const problems = licenseProblems(built.rows);
    console.log(`build-credits: wrote public/credits.json (${built.sources.length} LICENSES files, ${built.rows.length} rows)`);
    if (problems.length) { console.error('build-credits: licence problems:', JSON.stringify(problems, null, 2)); process.exit(1); }
  }
}
