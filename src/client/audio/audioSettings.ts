/**
 * Audio settings (b2.4h; audio-11, D14): Master / Music / Effects / Ambience / UI sliders, mute,
 * mute when the window loses focus, and iOS "Mix with other audio". One pure parse/serialise
 * pair so the round trip is testable without a DOM; MenuController owns the controls.
 */
import type { AudioBusName } from './AudioCore.js';

export interface AudioSettings {
  volume: number;
  muted: boolean;
  music: number;
  effects: number;
  ambience: number;
  ui: number;
  muteUnfocused: boolean;
  mixWithOthers: boolean;
}

export const AUDIO_SETTINGS_DEFAULTS: Readonly<AudioSettings> = {
  volume: 0.55, muted: false, music: 0.8, effects: 1, ambience: 1, ui: 0.8, muteUnfocused: true, mixWithOthers: false,
};

/** Slider id -> engine bus. 'effects' is the sfx bus (cannons, foley, footsteps, reverb tail). */
export const AUDIO_SLIDER_BUS: Readonly<Record<'music' | 'effects' | 'ambience' | 'ui', AudioBusName>> = {
  music: 'music', effects: 'sfx', ambience: 'ambience', ui: 'ui',
};

const unit = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fb);
const bool = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb);

/** Any stored value (string, object, garbage, null) -> a complete, clamped settings object. */
export function parseAudioSettings(raw: unknown): AudioSettings {
  let o: Record<string, unknown> = {};
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch { /* garbage -> defaults */ }
  const d = AUDIO_SETTINGS_DEFAULTS;
  return {
    volume: unit(o.volume, d.volume),
    muted: o.muted === undefined ? d.muted : !!o.muted,
    music: unit(o.music, d.music),
    effects: unit(o.effects, d.effects),
    ambience: unit(o.ambience, d.ambience),
    ui: unit(o.ui, d.ui),
    muteUnfocused: bool(o.muteUnfocused, d.muteUnfocused),
    mixWithOthers: bool(o.mixWithOthers, d.mixWithOthers),
  };
}

export function serializeAudioSettings(s: AudioSettings): string {
  return JSON.stringify(parseAudioSettings(s));
}

export interface AudioSettingsSink {
  setVolume(v: number): void;
  setMuted(m: boolean): void;
  setBusVolume(bus: AudioBusName, v: number): void;
  setMuteWhenUnfocused(on: boolean): void;
  setMixWithOthers(mix: boolean): void;
}

/** Push every field to the engine (safe before the first gesture: the engine holds the values). */
export function applyAudioSettings(engine: AudioSettingsSink, s: AudioSettings): void {
  engine.setVolume(s.volume);
  engine.setMuted(s.muted);
  for (const [k, bus] of Object.entries(AUDIO_SLIDER_BUS)) engine.setBusVolume(bus, s[k as keyof typeof AUDIO_SLIDER_BUS]);
  engine.setMuteWhenUnfocused(s.muteUnfocused);
  engine.setMixWithOthers(s.mixWithOthers);
}
