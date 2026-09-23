#!/usr/bin/env node
// NO KEYBOARD KEY IS HARD-CODED IN PLAYER COPY (b1.4f; mechanicshud-05,
// crossdevice-08, crossdevice-18, vm:mechanicshud:3).
//
// Every prompt, card, legend, How to Play line and objective used to name a
// keyboard key ("[X] Take Helm", "hold W", "LMB · Fire"), so a phone or pad
// player was told to press keys they do not have. The copy now asks
// src/client/ui/InputGlyphs.ts for the glyph of an ACTION on the active scheme
// ('[X]' keyboard, '(X)' pad, '‹Fire›' touch), built from src/shared/bindings.ts.
//
//  1. The copy census: every string literal / template text in src/**/*.ts and
//     every visible text node / attribute of index.html (comments, <script> and
//     <style> stripped) is searched for the verifier's key pattern (bracketed
//     key letters and digit sets, LMB/RMB, "hold W", WASD). bindings.ts and
//     InputGlyphs.ts are the only files allowed to spell a key. Must be 0.
//     (Code comments are not copy: they are reported as an advisory count.)
//  2. The glyph layer itself: glyph() differs per scheme for every action the
//     prompts use, pad tokens read as the face button, touch reads the on-screen
//     button, n/a rows never render an empty glyph, a keyboard layout map
//     relabels letters (AZERTY), and the generated legend names every live
//     keyboard key the table binds.
//  3. The win copy: the number in How to Play and in the legend is
//     GOLD_WIN_TARGET, generated, never typed (crossdevice-18: 9,000 vs 8000).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}
const tryImport = async (path) => {
  try { return await import(path); } catch (err) { expect(`import ${path}`, false, String(err?.message ?? err).split('\n')[0]); return null; }
};

const ROOT = new URL('..', import.meta.url).pathname;
/** The verifier's pattern (mechanicshud-05 re-grep), anchored to copy. */
export const KEY_PATTERN = /\[(?:[A-Z]|[0-9](?:\/[0-9])+|[A-Z]\/[A-Z]|LMB|RMB|MMB|SPACE|Space|SHIFT|Shift|ESC|Esc|TAB|Tab|F8)\]|\bLMB\b|\bRMB\b|\b[Hh]old [WXASDIGPQF]\b|\bWASD\b/g;
const ALLOWED = new Set(['src/shared/bindings.ts', 'src/client/ui/InputGlyphs.ts']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** String-literal and template texts of a TS file (what can reach a player). */
function copyStrings(file) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // Import specifiers are paths, not copy.
      if (!(node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent)))) {
        out.push({ line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { src, out };
}

/** Visible text + attribute values of index.html. */
function htmlCopy(file) {
  const raw = readFileSync(file, 'utf8');
  const lines = [];
  const stripped = raw
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' '));
  stripped.split('\n').forEach((text, i) => lines.push({ line: i + 1, text }));
  return lines;
}

// ── 1. The copy census ────────────────────────────────────────────────────
console.log('\nKey literals in player copy (src/**/*.ts string literals + index.html)');
const hits = [];
let commentHits = 0;
for (const file of walk(join(ROOT, 'src'))) {
  const rel = relative(ROOT, file);
  if (ALLOWED.has(rel)) continue;
  const { src, out } = copyStrings(file);
  let inCopy = 0;
  for (const s of out) {
    for (const m of s.text.matchAll(KEY_PATTERN)) { hits.push(`${rel}:${s.line} ${JSON.stringify(m[0])} in ${JSON.stringify(s.text.slice(0, 70))}`); inCopy += 1; }
  }
  commentHits += Math.max(0, [...src.matchAll(KEY_PATTERN)].length - inCopy);
}
for (const l of htmlCopy(join(ROOT, 'index.html'))) {
  for (const m of l.text.matchAll(KEY_PATTERN)) hits.push(`index.html:${l.line} ${JSON.stringify(m[0])} in ${JSON.stringify(l.text.trim().slice(0, 70))}`);
}
const byFile = {};
for (const h of hits) { const f = h.split(':')[0]; byFile[f] = (byFile[f] ?? 0) + 1; }
console.log(`    ${hits.length} copy hits ${JSON.stringify(byFile)}; ${commentHits} more in code comments (advisory, not copy)`);
expect('0 hard-coded key literals in player copy outside bindings.ts / InputGlyphs.ts', hits.length === 0,
  hits.slice(0, 200).join('\n     '));

// ── 2. The glyph layer ────────────────────────────────────────────────────
console.log('\nInputGlyphs');
const G = await tryImport('../src/client/ui/InputGlyphs.ts');
const B = await tryImport('../src/shared/bindings.ts');
const C = await tryImport('../src/shared/constants/index.ts');
if (G && B) {
  const { glyph, keyLabel, legendLines, setKeyboardLayout, winCopy } = G;
  expect("glyph('interact','mouse') = [X]", glyph('interact', 'mouse') === '[X]', glyph('interact', 'mouse'));
  expect("glyph('interact','gamepad') = (X)", glyph('interact', 'gamepad') === '(X)', glyph('interact', 'gamepad'));
  const t = glyph('interact', 'touch');
  expect(`glyph('interact','touch') is a touch token, not a key (${t})`, /^‹.+›$/.test(t) && t !== '[X]');
  expect("glyph('fire','gamepad') = (RT)", glyph('fire', 'gamepad') === '(RT)', glyph('fire', 'gamepad'));
  expect("glyph('fire','touch') = ‹Fire›", glyph('fire', 'touch') === '‹Fire›', glyph('fire', 'touch'));
  expect("glyph('fire','mouse') reads as a click (trackpad-honest)", /Click/.test(glyph('fire', 'mouse')), glyph('fire', 'mouse'));
  expect("glyph('supplyWheel','touch') names the Satchel button", glyph('supplyWheel', 'touch') === '‹Satchel›', glyph('supplyWheel', 'touch'));
  // Every action the copy uses renders a non-empty, per-scheme-distinct glyph.
  const USED = ['interact', 'fire', 'aim', 'reload', 'special', 'keg', 'dropChest', 'supplyWheel', 'jump', 'swimDown', 'sailsOut', 'sailsIn', 'map', 'legend', 'wheelPage', 'spyglass', 'ammoRound', 'pause'];
  const bad = [];
  for (const a of USED) {
    const gs = ['mouse', 'gamepad', 'touch'].map((s) => glyph(a, s));
    if (gs.some((g) => !g || !g.trim())) bad.push(`${a}: empty ${JSON.stringify(gs)}`);
    if (new Set(gs).size < 2) bad.push(`${a}: same on every scheme ${JSON.stringify(gs)}`);
  }
  expect(`${USED.length} copy actions: non-empty and scheme-specific glyphs`, bad.length === 0, bad.join('\n     '));
  // n/a rows still say something a player can act on.
  expect("glyph('legend','gamepad') falls back to the pause route, never ''", glyph('legend', 'gamepad') === '(Menu)', glyph('legend', 'gamepad'));
  // Keyboard layout: AZERTY puts A on KeyQ; the label follows the physical key's character.
  setKeyboardLayout(new Map([['KeyQ', 'a'], ['KeyW', 'z'], ['KeyA', 'q']]));
  expect('a layout map relabels KeyQ as A (AZERTY)', keyLabel('KeyQ') === 'A' && glyph('trimLeft', 'mouse') === '[A]', `${keyLabel('KeyQ')} ${glyph('trimLeft', 'mouse')}`);
  setKeyboardLayout(null);
  expect('without a layout map KeyQ is Q', keyLabel('KeyQ') === 'Q');
  // The generated legend names every live key the table binds.
  const legendMouse = legendLines('mouse').join(' \n ');
  const ranges = [...legendMouse.matchAll(/(\d)–(\d)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const covered = (code) => legendMouse.includes(keyLabel(code))
    || (/^Arrow/.test(code) && /arrow keys/.test(legendMouse))
    || (/^Digit\d$/.test(code) && ranges.some(([a, b]) => Number(code.slice(5)) >= a && Number(code.slice(5)) <= b));
  const missing = B.keyboardCodes().filter((code) => !covered(code));
  expect(`the mouse legend names every live table key (${B.keyboardCodes().length})`, missing.length === 0, `missing: ${missing.join(', ')}`);
  const legendPad = legendLines('gamepad').join(' ');
  const legendTouch = legendLines('touch').join(' ');
  expect('the pad legend speaks pad (RT, LB), not keys', /\(RT\)/.test(legendPad) && /\(LB\)/.test(legendPad) && !KEY_PATTERN.test(legendPad), legendPad.slice(0, 200));
  KEY_PATTERN.lastIndex = 0;
  expect('the touch legend has no WASD / LMB / RMB / "Click"', !/\b(WASD|LMB|RMB|Click)\b/.test(legendTouch), legendTouch.slice(0, 200));
  if (C) {
    const target = C.ECONOMY.GOLD_WIN_TARGET;
    const w = winCopy();
    const n = Number((w.match(/[\d,]+/) ?? ['NaN'])[0].replace(/,/g, ''));
    expect(`win copy number = GOLD_WIN_TARGET (${target})`, n === target, w);
  }
}

// ── 3. index.html no longer types the win number or the legend ─────────────
console.log('\nindex.html copy is generated');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
expect('no typed gold figure in index.html (win copy is generated)', !/\d[,.]?\d{3} gold/i.test(html), (html.match(/.{30}\d[,.]?\d{3} gold.{10}/i) ?? [''])[0]);

if (failures) { console.error(`\nFAIL test-no-hardcoded-keys (${failures})`); process.exit(1); }
console.log('\nPASS test-no-hardcoded-keys');
