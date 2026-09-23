/**
 * HAPTICS (b1.4e; crossdevice-17). Cheap feel for the two devices that can do
 * it from a browser: a Standard gamepad's dual-rumble actuator
 * (gp.vibrationActuator.playEffect('dual-rumble')) and navigator.vibrate on
 * Android touch. iOS Safari exposes neither, so a phone there stays silent.
 *
 * One table, one switch: `HAPTIC_TABLE` is what every kind plays, and the
 * "Vibration" setting (localStorage piratesBR.haptics = 'off') turns every
 * call into a no-op. DOM-free apart from the default ports, so
 * scripts/test-gamepad-curves.mjs drives it with stubs.
 */
export type HapticKind = 'fire' | 'hitTaken' | 'breach' | 'cannonFire';

export interface HapticSpec {
  /** Pulse length, ms (also the Android vibrate duration). */
  readonly ms: number;
  /** Low-frequency (heavy) motor 0..1. */
  readonly strong: number;
  /** High-frequency (light) motor 0..1. */
  readonly weak: number;
}

export const HAPTIC_TABLE: Readonly<Record<HapticKind, HapticSpec>> = {
  fire: { ms: 12, strong: 0.2, weak: 0.5 },
  hitTaken: { ms: 30, strong: 0.5, weak: 0.7 },
  breach: { ms: 60, strong: 0.8, weak: 0.4 },
  cannonFire: { ms: 40, strong: 0.6, weak: 0.3 },
};

export const HAPTICS_STORAGE_KEY = 'piratesBR.haptics';

type RumblePad = { vibrationActuator?: { playEffect?: (type: string, params: Record<string, number>) => unknown } | null } | null;

export interface HapticsPorts {
  /** The pad in use (null when none). */
  pad: () => RumblePad;
  /** navigator.vibrate, when the platform has it. */
  vibrate: ((ms: number) => unknown) | null;
  /** Which scheme the player is on: pads rumble, fingers vibrate, mice do nothing. */
  scheme: () => 'mouse' | 'gamepad' | 'touch';
}

function readSetting(): boolean {
  try { return typeof localStorage === 'undefined' || localStorage.getItem(HAPTICS_STORAGE_KEY) !== 'off'; } catch { return true; }
}

export class Haptics {
  private enabled: boolean;

  constructor(private readonly ports: HapticsPorts, enabled: boolean = readSetting()) {
    this.enabled = enabled;
  }

  isEnabled() { return this.enabled; }

  /** The settings toggle (persists). */
  setEnabled(on: boolean) {
    this.enabled = on;
    try { localStorage?.setItem(HAPTICS_STORAGE_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
  }

  /** Play one kind. Returns which device took it (for tests and probes). */
  pulse(kind: HapticKind): 'pad' | 'vibrate' | null {
    if (!this.enabled) return null;
    const spec = HAPTIC_TABLE[kind];
    const scheme = this.ports.scheme();
    if (scheme === 'gamepad') {
      const actuator = this.ports.pad()?.vibrationActuator;
      if (!actuator?.playEffect) return null;
      try {
        const done = actuator.playEffect('dual-rumble', {
          startDelay: 0, duration: spec.ms, strongMagnitude: spec.strong, weakMagnitude: spec.weak,
        });
        // A pad that rejects (unplugged mid-pulse) must not surface as an error.
        (done as Promise<unknown> | undefined)?.catch?.(() => {});
      } catch { return null; }
      return 'pad';
    }
    if (scheme === 'touch' && this.ports.vibrate) {
      try { this.ports.vibrate(spec.ms); } catch { return null; }
      return 'vibrate';
    }
    return null;
  }
}
