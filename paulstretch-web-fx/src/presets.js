// Presets: built-in sound settings plus user presets kept in localStorage.
// A preset only covers the sound. The file, play range, volume, Loop and
// Mono → wide stereo are never touched.
import { defaultParams, MODULES } from './dsp.js';
import { normalizeFx } from './effects.js';

// v1: stretch + spectral modules. v2: adds the spectral EQ curve and effects.
export const PRESET_VERSION = 2;
export const SOUND_KEYS = ['stretch', 'bufsize', 'windowType', 'onset', 'freeze', 'order', 'enabled', ...MODULES, 'drawEq', 'fx'];

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// Full sound settings: defaults, every module off, then the preset's overrides.
function settings(over) {
  const base = defaultParams();
  const s = {};
  for (const k of SOUND_KEYS) s[k] = clone(base[k]);
  for (const m of MODULES) s.enabled[m] = false;
  s.enabled.drawEq = false;
  s.drawEq = { points: [] };
  for (const [k, v] of Object.entries(over)) {
    if (k === 'fx') continue;
    if (k === 'enabled' || (MODULES.includes(k) && typeof v === 'object')) s[k] = { ...s[k], ...v };
    else s[k] = v;
  }
  s.fx = normalizeFx(over.fx);
  return s;
}

const levels = (o) => {
  const names = ['-2oct', '-1oct', 'orig', '+1oct', '+1oct5', '+2oct', '+5th', '-5th'];
  return names.map((n) => o[n] ?? 0);
};

// bufsize is half the analysis window: 2048 ≈ 85 ms, 4096 ≈ 170 ms,
// 16384 ≈ 0.7 s, 32768 ≈ 1.4 s, 65536 ≈ 2.7 s, 131072 ≈ 5.5 s (at 48 kHz).
export const PRESETS = [
  {
    id: 'classic', name: 'Classic PaulStretch',
    usage: 'The neutral starting point; a good first listen for any sound.',
    tip: 'A moderate stretch and a medium window: recognisable but smooth. Start here, then raise the stretch or window size for something more abstract.',
    settings: settings({ stretch: 8, bufsize: 16384, windowType: 'hamming' }),
  },
  {
    id: 'drone', name: 'Endless Drone',
    usage: 'Turns anything into a static, near-motionless drone.',
    tip: 'The huge window blurs everything into sustained tones and the extreme stretch makes it barely move. Blackman-Harris keeps the tones pure; a very long reverb with a touch of shimmer and slow chorus adds depth. Spectral settings respond slowly with a window this large.',
    settings: settings({
      stretch: 500, bufsize: 131072, windowType: 'blackman-harris', enabled: { spread: true }, spread: { amount: 0.25 },
      fx: {
        enabled: { chorus: true, reverb: true },
        chorus: { rate: 0.07, depth: 0.45, voices: 3, spread: 0.9, mix: 0.2 },
        reverb: { size: 1, decay: 25, damping: 0.55, predelay: 40, width: 1, mix: 0.45, shimmer: true, shimmerAmount: 0.15 },
      },
    }),
  },
  {
    id: 'pad', name: 'Ambient Pad',
    usage: 'Soft, slowly evolving pads from music or vocals.',
    tip: 'A 1.4 s window smooths out attacks while keeping the harmony. The quiet octave above adds air, the spread rounds off the partials, and a long shimmering reverb with moderate chorus widens it all.',
    settings: settings({
      stretch: 50, bufsize: 32768, windowType: 'hann',
      enabled: { spread: true, ratioMix: true }, spread: { amount: 0.15 }, ratioMix: { levels: levels({ orig: 1, '+1oct': 0.25 }) },
      fx: {
        enabled: { eq3: true, chorus: true, reverb: true },
        eq3: { low: 1.5, mid: -1, high: -2, midFreq: 600, midQ: 0.7 },
        chorus: { rate: 0.18, depth: 0.5, voices: 3, spread: 1, mix: 0.25 },
        reverb: { size: 0.8, decay: 12, damping: 0.45, predelay: 30, width: 1, mix: 0.4, shimmer: true, shimmerAmount: 0.35 },
      },
    }),
  },
  {
    id: 'ghost', name: 'Ghost Voice',
    usage: 'Slowed speech or singing where the words stay recognisable.',
    tip: "The short window keeps the shape of syllables, and onset detection jumps to each new sound so consonants aren't smeared away. Lower the stretch if the words get lost.",
    settings: settings({ stretch: 6, bufsize: 4096, windowType: 'hann', onset: 0.3 }),
  },
  {
    id: 'rhythm', name: 'Rhythmic Smear',
    usage: 'Drums and beats: stretched, but the hits survive.',
    tip: 'A very short window plus strong onset detection: each hit is played as it arrives, and the stretching happens in between. Raise onset sensitivity if hits still get smeared.',
    settings: settings({ stretch: 4, bufsize: 2048, windowType: 'hamming', onset: 0.6 }),
  },
  {
    id: 'choir', name: 'Octave Choir',
    usage: 'A wide, shimmering choir-like layer.',
    tip: 'Ratio mix layers copies an octave below, an octave above and a fifth up, which reads as many voices. Chorus widens them, a controlled reverb places them in a space, and the EQ gently softens the top. Works best on sustained sounds like vocals, strings or synths.',
    settings: settings({
      stretch: 30, bufsize: 32768, windowType: 'hann',
      enabled: { ratioMix: true }, ratioMix: { levels: levels({ '-1oct': 0.5, orig: 1, '+1oct': 0.4, '+5th': 0.2 }) },
      fx: {
        enabled: { eq3: true, chorus: true, reverb: true },
        eq3: { low: 0, mid: 0, high: -3, midFreq: 1000, midQ: 0.7 },
        chorus: { rate: 0.25, depth: 0.6, voices: 3, spread: 1, mix: 0.35 },
        reverb: { size: 0.6, decay: 5, damping: 0.5, predelay: 25, width: 1, mix: 0.28, shimmer: false, shimmerAmount: 0.3 },
      },
    }),
  },
  {
    id: 'noise2tone', name: 'Noise to Tone',
    usage: 'Field recordings, wind, traffic or noise turned into a pitched drone.',
    tip: 'Harmonics keeps only the frequencies of a 110 Hz harmonic series, so any noisy source rings at that pitch. Change the base frequency to tune the drone to your track.',
    settings: settings({
      stretch: 40, bufsize: 32768, windowType: 'hamming',
      enabled: { harmonics: true }, harmonics: { count: 12, freq: 110, bandwidth: 25, gauss: true },
    }),
  },
  {
    id: 'underwater', name: 'Deep Underwater',
    usage: 'Dark, muffled, submerged atmospheres.',
    tip: "An octave down, everything above 1.2 kHz removed and a 2.7 s window: deep, muffled and slow. Raise the filter's High value for a less muffled result.",
    settings: settings({
      stretch: 20, bufsize: 65536, windowType: 'hann',
      enabled: { pitchShift: true, filter: true }, pitchShift: { semitones: -12 }, filter: { low: 20, high: 1200, stop: false },
    }),
  },
  {
    id: 'bells', name: 'Metallic Bells',
    usage: 'Inharmonic, clangy, sci-fi textures.',
    tip: 'A frequency shift moves all partials by the same number of Hz, which breaks their harmonic relationship and makes them ring like metal. Small shifts sound detuned; large ones sound robotic.',
    settings: settings({
      stretch: 15, bufsize: 16384, windowType: 'hamming',
      enabled: { freqShift: true, ratioMix: true }, freqShift: { hz: 150 }, ratioMix: { levels: levels({ orig: 1, '+2oct': 0.2 }) },
    }),
  },
  {
    id: 'wash', name: 'Noise Wash',
    usage: 'Airy, breathy texture with the tones removed.',
    tip: 'Tonal vs noise on the negative side removes the tonal peaks and keeps the noise between them; spread and the compressor smooth it into an even wash.',
    settings: settings({
      stretch: 100, bufsize: 65536, windowType: 'hann',
      enabled: { tonalNoise: true, spread: true, compressor: true },
      tonalNoise: { preserve: -0.6, bandwidth: 0.74 }, spread: { amount: 0.5 }, compressor: { amount: 0.3 },
    }),
  },
  {
    id: 'binaural', name: 'Binaural Atmosphere',
    usage: 'A slow ambient bed with binaural beats that glide down over 20 minutes. Use headphones.',
    tip: 'The original PaulXStretch method shifts the music a few Hz apart between the ears, so the beat lives inside the sound. The glide starts at 10 Hz and eases down to 6 Hz; the subtle chorus and reverb keep left and right separate so the beat survives.',
    settings: settings({
      stretch: 60, bufsize: 32768, windowType: 'hann',
      fx: {
        enabled: { binaural: true, chorus: true, reverb: true },
        binaural: { mode: 'original', beat: 8, stereoMode: 'lr', amount: 0.5, glide: { enabled: true, start: 10, end: 6, duration: 1200, curve: 'exp', direction: 'decreasing' } },
        chorus: { rate: 0.12, depth: 0.4, voices: 3, spread: 0.8, mix: 0.15 },
        reverb: { size: 0.7, decay: 6, damping: 0.5, predelay: 20, width: 1, mix: 0.2, shimmer: false, shimmerAmount: 0.3 },
      },
    }),
  },
  {
    id: 'freeze', name: 'Freeze Frame',
    usage: 'Holds one moment endlessly. Click the waveform where you want it, then press Play.',
    tip: "With Freeze on, the play position doesn't move, so the moment under the playhead sustains forever. Click a different spot in the waveform to freeze another moment.",
    settings: settings({ stretch: 8, bufsize: 32768, windowType: 'hann', freeze: true, enabled: { spread: true }, spread: { amount: 0.1 } }),
  },
];

// Short human-readable list of what a preset sets, e.g. for the help page.
// Window lengths assume 48 kHz audio.
const RATIO_LABELS = ['−2 oct', '−1 oct', 'original', '+1 oct', '+1 oct +5th', '+2 oct', '+5th', '−5th'];
const WINDOW_NAMES = { rectangular: 'Rectangular', hamming: 'Hamming', hann: 'Hann', blackman: 'Blackman', 'blackman-harris': 'Blackman-Harris' };

export function describeSettings(s) {
  const fmtNum = (v) => String(+v.toFixed(2)).replace('-', '−');
  const signed = (v) => (v > 0 ? '+' : '') + fmtNum(v);
  const secs = (2 * s.bufsize) / 48000;
  const parts = [
    `Stretch ×${fmtNum(s.stretch)}`,
    `${secs < 1 ? `${Math.round(secs * 1000)} ms` : `${secs.toFixed(1)} s`} window`,
    WINDOW_NAMES[s.windowType] || s.windowType,
  ];
  if (s.onset > 0.001) parts.push(`Onset ${fmtNum(s.onset)}`);
  if (s.freeze) parts.push('Freeze on');
  for (const m of s.order) {
    if (!s.enabled[m]) continue;
    const p = s[m];
    switch (m) {
      case 'harmonics': parts.push(`Harmonics ${p.freq} Hz × ${p.count}, ${p.bandwidth} ¢${p.gauss ? ', Gaussian' : ''}`); break;
      case 'pitchShift': parts.push(`Pitch shift ${signed(p.semitones)} st`); break;
      case 'freqShift': parts.push(`Frequency shift ${signed(p.hz)} Hz`); break;
      case 'spread': parts.push(`Spread ${fmtNum(p.amount)}`); break;
      case 'tonalNoise': parts.push(`Tonal vs noise ${fmtNum(p.preserve)}`); break;
      case 'filter': parts.push(`${p.stop ? 'Band stop' : 'Filter'} ${p.low}–${p.high} Hz`); break;
      case 'compressor': parts.push(`Compressor ${fmtNum(p.amount)}`); break;
      case 'ratioMix': {
        const layers = p.levels.map((l, i) => (l > 0.001 && i !== 2 ? `${RATIO_LABELS[i]} ${fmtNum(l)}` : null)).filter(Boolean);
        parts.push(`Ratio mix: ${layers.join(', ') || 'original only'}`);
        break;
      }
    }
  }
  if (s.enabled.drawEq && s.drawEq && s.drawEq.points.length) parts.push(`EQ curve: ${s.drawEq.points.length} points`);
  const fx = normalizeFx(s.fx);
  if (fx.enabled.binaural) {
    const b = fx.binaural, g = b.glide;
    const beat = g.enabled ? `${fmtNum(g.direction === 'increasing' ? Math.min(g.start, g.end) : Math.max(g.start, g.end))}→${fmtNum(g.direction === 'increasing' ? Math.max(g.start, g.end) : Math.min(g.start, g.end))} Hz over ${Math.round(g.duration / 60)} min` : `${fmtNum(b.beat)} Hz`;
    const mode = b.mode === 'tones' ? 'tones' : b.mode === 'both' ? 'shift + tones' : 'shift';
    parts.push(`Binaural ${mode} ${beat}`);
  }
  for (const name of fx.order) {
    if (!fx.enabled[name]) continue;
    const p = fx[name];
    const sgn = (v) => (v > 0 ? '+' : '') + fmtNum(v);
    if (name === 'eq3') parts.push(`EQ low ${sgn(p.low)} / mid ${sgn(p.mid)} / high ${sgn(p.high)} dB`);
    if (name === 'chorus') parts.push(`Chorus ${p.voices} voices, ${fmtNum(p.rate)} Hz, mix ${Math.round(p.mix * 100)}%`);
    if (name === 'reverb') parts.push(`Reverb ${fmtNum(p.decay)} s, mix ${Math.round(p.mix * 100)}%${p.shimmer ? `, shimmer ${Math.round(p.shimmerAmount * 100)}%` : ''}`);
  }
  return parts;
}

// Copies a preset's sound settings into params, leaving everything else alone.
export function applySettings(params, s) {
  const full = settings({});
  for (const k of SOUND_KEYS) params[k] = clone(s[k] ?? full[k]);
  params.enabled = { ...full.enabled, ...params.enabled };
  if (!params.drawEq || !Array.isArray(params.drawEq.points)) params.drawEq = { points: [] };
  params.fx = normalizeFx(params.fx);
}

export function snapshot(params) {
  const s = {};
  for (const k of SOUND_KEYS) s[k] = clone(params[k]);
  return s;
}

// ---------------------------------------------------------------- user presets

const STORE = 'paulstretch-web.userPresets';

export function loadUserPresets() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) || '[]');
    return Array.isArray(list) ? list.filter((p) => p && typeof p.name === 'string' && p.settings) : [];
  } catch {
    return [];
  }
}

export function saveUserPresets(list) {
  try {
    localStorage.setItem(STORE, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
