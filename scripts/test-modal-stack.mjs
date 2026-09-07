#!/usr/bin/env node
/**
 * ONE ESCAPE KEY (hud-22) — graded on the stack, not on a screenshot.
 *
 * Three overlays, three conventions, and two of them unreachable by keyboard:
 * the onboarding cards took neither Escape nor Enter (mouse only, over a deck
 * whose pointer lock you had just broken to click them); Settings and How to
 * Play were left by a Back button that sits below the fold at 540 px of
 * viewport height; the stats modal alone took Escape, via a `document`
 * listener that fired regardless of what was on top of it.
 *
 * The property that matters most here is the NEGATIVE one. A key router that
 * eats Escape when nothing is open takes away the pointer-lock release, and one
 * that eats Enter takes away the pirate-name field. So an empty stack must
 * consume nothing, and a text field must keep Enter.
 *
 * The last block reads index.html: the Back button being on screen at all is a
 * CSS fact (max-height + overflow on .menu-panel, sticky footer), not a
 * keyboard one.
 *
 * node --import tsx scripts/test-modal-stack.mjs   (~0.3 s, no stack)
 */
import { readFileSync } from 'node:fs';
import { ModalStack } from '../src/client/ui/ModalStack.ts';

const ROOT = new URL('..', import.meta.url).pathname;
let failures = 0;
function expect(label, condition, detail = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ FAIL: ${label}${detail ? `\n     ${detail}` : ''}`); failures += 1; }
}

const log = [];
const entry = (id, extra = {}) => ({
  id, close: () => log.push(`close:${id}`), confirm: () => log.push(`confirm:${id}`), ...extra,
});

console.log('\nAn empty stack is deaf — the game keeps its keys');
{
  const s = new ModalStack();
  expect('Escape falls through to the browser (pointer lock)', s.handleKey('Escape') === false);
  expect('Enter falls through to the name field', s.handleKey('Enter') === false);
  expect('so does everything else', s.handleKey('KeyW') === false);
  expect('nothing is reported open', s.isOpen() === false && s.topId() === null);
}

console.log('\nEscape closes the TOP, one layer at a time');
{
  const s = new ModalStack();
  log.length = 0;
  s.open(entry('settings'));
  s.open(entry('cards'));
  expect('the last thing opened is the top', s.topId() === 'cards');
  expect('Escape is consumed', s.handleKey('Escape') === true);
  expect('and it closed the cards, not the panel behind them',
    log.join(',') === 'close:cards', `log: ${log.join(',')}`);
  expect('the panel behind is still up', s.topId() === 'settings' && s.depth() === 1);
  expect('a second Escape closes it', s.handleKey('Escape') === true && s.depth() === 0);
  expect('a third falls through', s.handleKey('Escape') === false);
}

console.log('\nEnter confirms the top, and never the field you are typing in');
{
  const s = new ModalStack();
  log.length = 0;
  s.open(entry('cards'));
  expect('Enter runs the top\'s confirm', s.handleKey('Enter') === true);
  expect('and it was the top\'s', log.join(',') === 'confirm:cards', `log: ${log.join(',')}`);
  expect('Enter typed into a text field is left alone',
    s.handleKey('Enter', { inTextField: true }) === false);
  const bare = new ModalStack();
  bare.open({ id: 'plain', close: () => log.push('close:plain') });
  expect('a modal with no confirm lets Enter through', bare.handleKey('Enter') === false);
  expect('but still takes Escape', bare.handleKey('Escape') === true);
}

console.log('\nRe-opening, self-closing and sticky layers');
{
  const s = new ModalStack();
  log.length = 0;
  s.open(entry('cards'));
  s.open(entry('stats'));
  s.open(entry('cards'));
  expect('opening the same id twice does not stack two copies', s.depth() === 2,
    `depth ${s.depth()}`);
  expect('it is raised to the top instead', s.topId() === 'cards');
  expect('an overlay that closed itself is dropped without a second close',
    s.notifyClosed('cards') === true && log.length === 0 && s.topId() === 'stats');
  expect('dropping something that is not up is a no-op', s.notifyClosed('cards') === false);
  expect('close(id) reaches a layer that is not on top',
    s.close('stats') === true && log.join(',') === 'close:stats');

  const blocking = new ModalStack();
  blocking.open(entry('cards'));
  blocking.open(entry('disconnect', { sticky: true }));
  expect('a sticky layer refuses Escape', blocking.handleKey('Escape') === false);
  expect('and shields the layer under it', blocking.depth() === 2);
  expect('reset() drops everything without firing a close',
    (() => { log.length = 0; blocking.reset(); return blocking.depth() === 0 && log.length === 0; })());
}

console.log('\nThe Back button is on screen at 540 px (hud-22)');
{
  const html = readFileSync(`${ROOT}index.html`, 'utf8');
  const panel = html.match(/\.menu-panel \{[^}]*\}/)?.[0] ?? '';
  expect('.menu-panel is height-capped', /max-height:/.test(panel), `rule: ${panel.replace(/\s+/g, ' ')}`);
  expect('.menu-panel scrolls rather than spilling off the screen',
    /overflow-y:\s*auto/.test(panel), `rule: ${panel.replace(/\s+/g, ' ')}`);
  const footer = html.match(/\.menu-panel-footer \{[^}]*\}/)?.[0] ?? '';
  expect('and the footer holding Back is sticky',
    /position:\s*sticky/.test(footer), `rule: ${footer.replace(/\s+/g, ' ') || '(no .menu-panel-footer rule)'}`);
  expect('Settings uses it', /id="settings-back-btn"/.test(html)
    && /menu-panel-footer[^>]*>\s*<button[^>]*id="settings-back-btn"/.test(html.replace(/\n\s*/g, ' ')));
  expect('How to Play uses it', /menu-panel-footer[^>]*>\s*<button[^>]*id="howto-back-btn"/
    .test(html.replace(/\n\s*/g, ' ')));
}

console.log(failures === 0 ? '\nPASS — one stack, one Escape key' : `\nFAIL — ${failures} assertion(s)`);
process.exit(failures === 0 ? 0 : 1);
