/**
 * SETTINGS > CONTROLS (b1.4g; crossdevice-13, crossdevice-14).
 *
 * One page for every device: look speeds per scheme (mouse, aim multiplier,
 * touch, stick), invert Y per scheme, aim assist, vibration, raw mouse input
 * (Chromium), touch button size / left-handed / show mode, and rebinding for
 * keyboard and gamepad. Sliders take their min/max/step from CONTROL_RANGES,
 * the same table storage and InputManager clamp with, so the three can never
 * disagree again. Rebinds go through rebinding.ts (conflict = swap), land in
 * the live bindings table and re-render every generated legend.
 */
import { BINDING_ACTIONS, BINDINGS, setLiveBindings, type BindingAction } from '../../shared/bindings.js';
import {
  CONTROL_RANGES, clampSetting, isRebindable, loadControlSettings, padTokenForIndex, rebind,
  resetBindings, saveBindingTable, saveControlSettings,
  type ControlSettings, type RangedSetting, type RebindScheme,
} from '../input/rebinding.js';
import { keyLabel, renderGlyphs } from '../ui/InputGlyphs.js';

/** What the page needs from InputManager (a structural type keeps the page testable). */
export type ControlsSink = {
  applyControlSettings(next: Partial<ControlSettings>): void;
};

const ROW = 'display:flex;align-items:center;gap:8px;margin:4px 0;font-size:0.78rem;color:#c9d6e4;';
const LABEL = 'flex:0 0 42%;';
const VAL = 'font-family:monospace;color:#f4e2b2;min-width:44px;text-align:right;';
const KEYBTN = 'min-width:74px;padding:3px 8px;background:rgba(10,18,28,0.72);color:#f4e2b2;border:1px solid rgba(126,172,220,0.28);border-radius:4px;font:inherit;font-size:0.74rem;cursor:pointer;';

/** Raw mouse input is pointer lock's unadjustedMovement, which only Chromium ships. */
export function rawMouseSupported(nav: { userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  // Chrome, Edge, Opera and every other Blink browser carry "Chrome/"; iOS Chrome is WebKit ("CriOS/").
  return /(Chrome|Chromium)\//.test(nav?.userAgent ?? '');
}

/** The actions the rebind list shows (live rows a player can change on at least one scheme). */
export function rebindRows(): BindingAction[] {
  return BINDING_ACTIONS.filter((a) => !BINDINGS[a].reserved && (isRebindable(a, 'keyboard') || isRebindable(a, 'gamepad')));
}

export class ControlsSettings {
  private settings: ControlSettings;
  private root: HTMLDivElement;
  private status!: HTMLDivElement;
  private capture: { action: BindingAction; scheme: RebindScheme; btn: HTMLButtonElement; stop: () => void } | null = null;

  constructor(host: HTMLElement, private readonly sink: ControlsSink | undefined) {
    this.settings = loadControlSettings();
    // Persist once so a pre-b1.4g mouse speed migrated from the old menu key survives.
    saveControlSettings(this.settings);
    sink?.applyControlSettings(this.settings);
    this.root = document.createElement('div');
    this.root.id = 'controls-settings';
    this.root.style.cssText = 'max-height:42vh;overflow-y:auto;padding-right:4px;margin:4px 0 8px;';
    host.appendChild(this.root);
    this.render();
  }

  private update(patch: Partial<ControlSettings>) {
    this.settings = { ...this.settings, ...patch };
    saveControlSettings(this.settings);
    this.sink?.applyControlSettings(this.settings);
  }

  private heading(text: string) {
    const h = document.createElement('div');
    h.textContent = text;
    h.style.cssText = 'color:#9ec0e5;font-weight:600;font-size:0.74rem;letter-spacing:0.08em;text-transform:uppercase;margin:10px 0 2px;';
    this.root.appendChild(h);
  }

  private row(label: string): HTMLDivElement {
    const r = document.createElement('div');
    r.style.cssText = ROW;
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = LABEL;
    r.appendChild(l);
    this.root.appendChild(r);
    return r;
  }

  private slider(key: RangedSetting) {
    const spec = CONTROL_RANGES[key];
    const r = this.row(spec.label);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `controls-${key}`;
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(this.settings[key]);
    input.style.flex = '1';
    const val = document.createElement('span');
    val.style.cssText = VAL;
    const show = (v: number) => { val.textContent = key === 'touchButtonSize' ? `${Math.round(v * 100)}%` : `${v.toFixed(2)}x`; };
    show(this.settings[key]);
    input.addEventListener('input', () => {
      const v = clampSetting(key, Number(input.value));
      show(v);
      this.update({ [key]: v } as Partial<ControlSettings>);
    });
    r.append(input, val);
  }

  private toggle(id: string, label: string, get: () => boolean, set: (on: boolean) => void) {
    const r = this.row(label);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `controls-${id}`;
    box.checked = get();
    box.style.cssText = 'transform:scale(1.3);margin-left:8px;';
    box.addEventListener('change', () => set(box.checked));
    r.appendChild(box);
  }

  render() {
    this.stopCapture();
    this.root.replaceChildren();
    const s = () => this.settings;
    this.heading('Look');
    this.slider('mouseSens');
    this.slider('adsMult');
    this.slider('touchLook');
    this.slider('stickLook');
    this.toggle('invert-mouse', 'Invert Y (mouse / trackpad)', () => s().invertY.mouse, (on) => this.update({ invertY: { ...s().invertY, mouse: on } }));
    this.toggle('invert-gamepad', 'Invert Y (controller)', () => s().invertY.gamepad, (on) => this.update({ invertY: { ...s().invertY, gamepad: on } }));
    this.toggle('invert-touch', 'Invert Y (touch)', () => s().invertY.touch, (on) => this.update({ invertY: { ...s().invertY, touch: on } }));
    this.toggle('aim-assist', 'Aim assist (touch and controller)', () => s().aimAssist, (on) => this.update({ aimAssist: on }));
    this.toggle('vibration', 'Vibration', () => s().vibration, (on) => this.update({ vibration: on }));
    if (rawMouseSupported()) this.toggle('raw-mouse', 'Raw mouse input', () => s().rawMouse, (on) => this.update({ rawMouse: on }));

    this.heading('Touch');
    this.slider('touchButtonSize');
    this.toggle('left-handed', 'Left-handed layout', () => s().leftHanded, (on) => this.update({ leftHanded: on }));
    const modeRow = this.row('Show touch buttons');
    const mode = document.createElement('select');
    mode.id = 'controls-touch-buttons';
    mode.style.cssText = KEYBTN;
    for (const [v, t] of [['auto', 'Auto (when you touch)'], ['on', 'Always'], ['off', 'Never']] as const) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = t;
      mode.appendChild(o);
    }
    mode.value = s().touchButtons;
    mode.addEventListener('change', () => this.update({ touchButtons: mode.value as ControlSettings['touchButtons'] }));
    modeRow.appendChild(mode);

    this.heading('Bindings (keyboard / controller)');
    for (const action of rebindRows()) {
      const r = this.row(BINDINGS[action].label);
      for (const scheme of ['keyboard', 'gamepad'] as const) r.appendChild(this.bindButton(action, scheme));
    }
    this.status = document.createElement('div');
    this.status.id = 'controls-rebind-status';
    this.status.setAttribute('aria-live', 'polite');
    this.status.style.cssText = 'min-height:1.2em;font-size:0.72rem;color:#c9a84c;margin:4px 0;';
    const reset = document.createElement('button');
    reset.className = 'menu-btn';
    reset.id = 'controls-reset-bindings';
    reset.textContent = 'Reset bindings';
    reset.addEventListener('click', () => {
      this.commit(resetBindings());
      this.render();
      this.status.textContent = 'Bindings reset to the defaults.';
    });
    this.root.append(this.status, reset);
  }

  private bindButton(action: BindingAction, scheme: RebindScheme): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.style.cssText = KEYBTN;
    btn.dataset.rebind = `${action}:${scheme}`;
    const tokens = BINDINGS[action][scheme];
    const first = Array.isArray(tokens) ? tokens[0] : undefined;
    btn.textContent = first ? keyLabel(first) : 'n/a';
    if (!isRebindable(action, scheme, BINDINGS)) {
      btn.disabled = true;
      btn.style.opacity = '0.45';
      return btn;
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.startCapture(action, scheme, btn);
    });
    return btn;
  }

  /** Next key / mouse button (keyboard) or pad button (gamepad) becomes the binding; Escape cancels. */
  private startCapture(action: BindingAction, scheme: RebindScheme, btn: HTMLButtonElement) {
    this.stopCapture();
    btn.textContent = scheme === 'keyboard' ? 'Press a key' : 'Press a button';
    this.status.textContent = `${BINDINGS[action].label}: waiting (Escape cancels)`;
    const done = (token: string | null) => {
      this.stopCapture();
      if (token) this.apply(action, scheme, token);
      else this.render();
    };
    if (scheme === 'keyboard') {
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        done(e.code === 'Escape' ? null : e.code);
      };
      const onMouse = (e: MouseEvent) => {
        if (e.target === btn && e.button === 0 && e.detail === 0) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        done(`Mouse${e.button}`);
      };
      window.addEventListener('keydown', onKey, true);
      // Next tick, so the click that opened the capture is not the capture.
      const t = setTimeout(() => window.addEventListener('mousedown', onMouse, true), 0);
      this.capture = { action, scheme, btn, stop: () => {
        clearTimeout(t);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('mousedown', onMouse, true);
      } };
      return;
    }
    // Gamepad: wait for every button up, then take the first fresh press.
    let armed = false;
    let raf = 0;
    const poll = () => {
      let pads: ArrayLike<{ buttons: ArrayLike<{ pressed: boolean }> } | null> = [];
      try { pads = navigator.getGamepads?.() ?? []; } catch { /* no pads */ }
      let pressed: number | null = null;
      for (const p of Array.from(pads)) {
        if (!p) continue;
        for (let i = 0; i < p.buttons.length; i += 1) if (p.buttons[i]?.pressed) { pressed = i; break; }
        if (pressed !== null) break;
      }
      if (!armed) armed = pressed === null;
      else if (pressed !== null) { done(padTokenForIndex(pressed)); return; }
      raf = requestAnimationFrame(poll);
    };
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') { e.preventDefault(); done(null); } };
    window.addEventListener('keydown', onKey, true);
    raf = requestAnimationFrame(poll);
    this.capture = { action, scheme, btn, stop: () => { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey, true); } };
  }

  private stopCapture() {
    this.capture?.stop();
    this.capture = null;
  }

  private apply(action: BindingAction, scheme: RebindScheme, token: string) {
    const result = rebind(BINDINGS, action, scheme, token);
    if (!result.ok) {
      this.render();
      this.status.textContent = `Not bound: ${result.reason}`;
      return;
    }
    this.commit(result.table);
    this.render();
    const swaps = result.swapped.map((sw) => `${BINDINGS[sw.action].label} moved to ${sw.to ? keyLabel(sw.to) : 'its other binding'}`);
    this.status.textContent = `${BINDINGS[action].label}: ${keyLabel(token)}${swaps.length ? `. ${swaps.join('. ')}.` : '.'}`;
  }

  private commit(table: Parameters<typeof setLiveBindings>[0]) {
    setLiveBindings(table);
    saveBindingTable(table);
    try { renderGlyphs(document); } catch { /* no legend mounted */ }
  }
}

/** MenuController's mount point (Settings panel). */
export function mountControlsSettings(host: HTMLElement | null, sink: ControlsSink | undefined): ControlsSettings | null {
  if (!host) return null;
  return new ControlsSettings(host, sink);
}
