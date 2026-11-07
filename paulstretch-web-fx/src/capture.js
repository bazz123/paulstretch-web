// Capture a sound: freeze one moment of the source and turn it into a
// one-shot, a seamless loop or a long drone, with the current spectral
// modules and effects. Plain JS (no browser APIs): runs in the worker,
// on the main thread (snapshot display) and in Node tests.
import { Stretcher, RealFFT, makeRng } from './dsp.js';
import { FxChain } from './effects.js';

// ---------------------------------------------------------------- frozen source

// Plays one moment forever, exactly like Freeze, but centred on `pos`
// (0..1 of the file). Same interface as Engine: renderFrame(), finished.
export class FrozenSource {
  constructor(channels, sampleRate, params, pos, seedBase = 101) {
    this.params = params;
    const b = params.bufsize;
    const nOut = channels.length === 1 && params.monoToStereo ? 2 : channels.length;
    const len = channels[0].length;
    const centre = Math.round(Math.min(1, Math.max(0, pos)) * len);
    this.stretchers = [];
    for (let c = 0; c < nOut; c++) {
      const src = channels[c % channels.length];
      const seg = new Float32Array(2 * b);
      for (let i = 0; i < 2 * b; i++) {
        const j = centre - b + i;
        seg[i] = j >= 0 && j < len ? src[j] : 0;
      }
      const s = new Stretcher(b, sampleRate, seedBase + c);
      s.veryOld.set(seg.subarray(0, b));
      s.oldS.set(seg.subarray(b));
      s.freezing = true;
      s.rap = 1;
      s.onsetSens = 0;
      this.stretchers.push(s);
    }
    this.dummy = new Float32Array(2 * b);
    this.pos = pos;
  }
  get finished() { return false; }
  renderFrame() {
    for (const s of this.stretchers) s.process(this.dummy, 0, this.params);
    return { out: this.stretchers.map((s) => s.out), inPos: this.pos };
  }
  // processed magnitude spectrum per channel (after spectral modules)
  spectra() {
    for (const s of this.stretchers) s.process(this.dummy, 0, this.params);
    return this.stretchers.map((s) => Float32Array.from(s.freq.subarray(0, s.bufsize)));
  }
}

// ---------------------------------------------------------------- snapshot + pitch

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function describePitch(hz) {
  const midi = 69 + 12 * Math.log2(hz / 440);
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = `${NOTE_NAMES[((nearest % 12) + 12) % 12]}${Math.floor(nearest / 12) - 1}`;
  return { hz, midi, note: name, cents, label: `${name}${cents ? ` ${cents > 0 ? '+' : '−'}${Math.abs(cents)}c` : ''}` };
}

// Harmonic-sum pitch estimate on a magnitude spectrum (bins 0..sr/2).
// Returns null when the sound has no clear pitch.
export function detectPitch(mag, sampleRate) {
  const n = mag.length;
  const binHz = sampleRate / 2 / n;
  // light smoothing of the magnitude for peak lookups
  const peakAt = (f) => {
    const k = f / binHz;
    if (k < 1 || k >= n - 2) return 0;
    const i = Math.round(k);
    return Math.max(mag[i - 1], mag[i], mag[i + 1]);
  };
  let total = 0, maxMag = 0;
  for (let i = 1; i < n; i++) { total += mag[i]; if (mag[i] > maxMag) maxMag = mag[i]; }
  if (maxMag <= 1e-12) return null;
  const H = 10;
  let best = 0, bestF = 0;
  for (let f = 30; f <= 2000; f *= 1.003) {
    let s = 0;
    for (let h = 1; h <= H; h++) s += peakAt(f * h) / Math.pow(h, 0.8);
    if (s > best) { best = s; bestF = f; }
  }
  // refine: average the parabolic-interpolated harmonic peaks
  let num = 0, den = 0, harmonicEnergy = 0;
  for (let h = 1; h <= H; h++) {
    const k0 = Math.round((bestF * h) / binHz);
    if (k0 < 2 || k0 >= n - 2) break;
    let k = k0;
    for (let j = k0 - 2; j <= k0 + 2; j++) if (mag[j] > mag[k]) k = j;
    const a = mag[k - 1], b = mag[k], c = mag[k + 1];
    const d = a - 2 * b + c;
    const off = d !== 0 ? (0.5 * (a - c)) / d : 0;
    const fh = (k + Math.max(-0.5, Math.min(0.5, off))) * binHz;
    const w = b / Math.pow(h, 0.5);
    num += (fh / h) * w; den += w;
    for (let j = k - 2; j <= k + 2; j++) harmonicEnergy += mag[j];
  }
  if (den <= 0) return null;
  const hz = num / den;
  // confidence: how much of the spectrum sits on the harmonics
  const confidence = harmonicEnergy / total;
  if (confidence < 0.25) return null;
  return { ...describePitch(hz), confidence };
}

// What the capture panel shows: processed spectrum (mono mix) and pitch.
export function captureSnapshot(channels, sampleRate, params, pos) {
  const src = new FrozenSource(channels, sampleRate, params, pos);
  const spectra = src.spectra();
  const mono = new Float32Array(spectra[0].length);
  for (const s of spectra) for (let i = 0; i < mono.length; i++) mono[i] += s[i] / spectra.length;
  return { mono, pitch: detectPitch(mono, sampleRate) };
}

// ---------------------------------------------------------------- helpers

function rms(x, from = 0, to = x.length) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function makeFx(sampleRate, fxParams, loopSeconds) {
  const fx = new FxChain(sampleRate, 8192);
  if (loopSeconds) fx.setLoopPeriod(loopSeconds);
  fx.setParams(fxParams);
  for (const k of Object.keys(fx.en)) fx.en[k].jump(fxParams && fxParams.enabled && fxParams.enabled[k] ? 1 : 0);
  return fx;
}

const fxWithout = (fx) => ({ ...fx, enabled: { binaural: false, eq3: false, chorus: false, reverb: false } });

function finish(channels, { gain, normalize }) {
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
  const g = normalize ? (peak > 1e-9 ? Math.pow(10, -1 / 20) / peak : 1) : gain;
  if (g !== 1) for (const c of channels) for (let i = 0; i < c.length; i++) c[i] *= g;
  return { peak: peak * g };
}

// ---------------------------------------------------------------- seamless loop

// Builds an exactly periodic signal of L samples from frozen magnitudes:
// circular overlap-add of random-phase frames with a power-complementary
// (sine) window, so the loop has no seam by construction.
function synthLoop(mag, L, seed, targetRms) {
  const b = mag.length;
  let N = 2 * b;
  while (N > 256 && N > L / 8) N /= 2;
  const m = N / 2;
  // resample the magnitude to m bins, keeping the power per bin
  let magN = mag;
  if (m !== b) {
    magN = new Float32Array(m);
    const r = b / m;
    for (let k = 0; k < m; k++) {
      let p = 0, cnt = 0;
      for (let j = Math.floor(k * r); j < Math.min(b, Math.floor((k + 1) * r)); j++) { p += mag[j] * mag[j]; cnt++; }
      magN[k] = Math.sqrt(cnt ? p / cnt : 0);
    }
  }
  const fft = new RealFFT(N);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = Math.sin((Math.PI * (i + 0.5)) / N);
  const K = Math.max(4, Math.round((2 * L) / N));
  const out = new Float32Array(L);
  const frame = new Float32Array(N);
  const rng = makeRng(seed);
  for (let k = 0; k < K; k++) {
    fft.inverseRandomPhase(magN, rng, frame);
    const p = Math.round((k * L) / K);
    for (let i = 0; i < N; i++) out[(p + i) % L] += frame[i] * w[i];
  }
  const r = rms(out);
  if (r > 1e-12 && targetRms > 0) { const g = targetRms / r; for (let i = 0; i < L; i++) out[i] *= g; }
  return out;
}

// The level a frozen voice really plays at, so loops match playback.
function frozenRms(src) {
  const per = src.stretchers.map(() => []);
  for (let f = 0; f < 10; f++) {
    const { out } = src.renderFrame();
    if (f >= 2) out.forEach((o, c) => per[c].push(rms(o)));
  }
  return per.map((v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length));
}

export function renderLoop({ channels, sampleRate, params, pos, seconds, includeFx = true, normalize = false, gain = 1, verify = false }) {
  const sr = sampleRate;
  const L = Math.max(256, Math.round(seconds * sr));
  const T = L / sr;
  const src = new FrozenSource(channels, sr, params, pos);
  const spectra = src.spectra();
  const levels = frozenRms(src);
  // binaural always gives stereo; otherwise follow the source
  const fxp = includeFx ? params.fx : fxWithout(params.fx);
  const stereo = spectra.length > 1 || (fxp && fxp.enabled && fxp.enabled.binaural);
  const dry = [synthLoop(spectra[0], L, 7001, levels[0])];
  dry.push(spectra.length > 1 ? synthLoop(spectra[1], L, 7002, levels[1]) : Float32Array.from(dry[0]));

  const fx = makeFx(sr, fxp, T);
  // pre-roll: run the loop through the effects until tails reach steady state
  const tail = fx.tailSeconds() + 0.5;
  const passes = fx.anyActive ? Math.ceil(tail / T) + 2 : 1;
  const L1 = new Float32Array(L), R1 = new Float32Array(L);
  let prevL = null;
  for (let p = 0; p < passes + (verify ? 1 : 0); p++) {
    if (p === passes) prevL = Float32Array.from(L1);
    L1.set(dry[0]); R1.set(dry[1]);
    if (fx.anyActive) fx.process(L1, R1, L, true);
  }
  let periodicError = 0;
  if (verify && prevL) for (let i = 0; i < L; i++) periodicError = Math.max(periodicError, Math.abs(prevL[i] - L1[i]));
  const out = stereo ? [L1, R1] : [L1];
  const { peak } = finish(out, { gain, normalize });
  return { channels: out, loopStart: 0, loopEnd: L - 1, frames: L, peak, periodicError, seconds: T };
}

// ---------------------------------------------------------------- one-shot

export function renderOneShot({ channels, sampleRate, params, pos, seconds, attack = 0.5, release = 2, includeFx = true, normalize = false, gain = 1 }) {
  const sr = sampleRate;
  const n = Math.max(1, Math.round(seconds * sr));
  const src = new FrozenSource(channels, sr, params, pos);
  const fxp = includeFx ? params.fx : fxWithout(params.fx);
  const fx = makeFx(sr, fxp, 0);
  const maxTail = Math.round(fx.tailSeconds() * sr);
  const total = n + maxTail;
  const L = new Float32Array(total), R = new Float32Array(total);
  let w = 0;
  while (w < n) {
    const { out } = src.renderFrame();
    const k = Math.min(out[0].length, n - w);
    L.set(out[0].subarray(0, k), w);
    R.set((out[1] || out[0]).subarray(0, k), w);
    w += k;
  }
  // envelope: smooth (raised-cosine) attack and release inside the length
  const a = Math.min(Math.round(attack * sr), Math.floor(n / 2));
  const r = Math.min(Math.round(release * sr), n - a);
  for (let i = 0; i < a; i++) { const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / a); L[i] *= g; R[i] *= g; }
  for (let i = 0; i < r; i++) { const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / r); L[n - 1 - i] *= g; R[n - 1 - i] *= g; }
  if (fx.anyActive) {
    // generated binaural tones follow the same envelope, then stop
    const env = (i) => (i >= n ? 0 : i < a ? 0.5 - 0.5 * Math.cos((Math.PI * i) / a) : i >= n - r ? 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / r) : 1);
    fx.units.binaural.gate.jump(env(0));
    for (let o = 0; o < total; o += 512) {
      const k = Math.min(512, total - o);
      fx.setToneGate(env(o + (k >> 1)));
      fx.process(L.subarray(o, o + k), R.subarray(o, o + k), k, true);
    }
  }
  // trim the tail once it is silent
  let end = total;
  while (end > n && Math.max(Math.abs(L[end - 1]), Math.abs(R[end - 1])) < 1e-5) end--;
  end = Math.min(total, end + Math.round(0.05 * sr));
  const stereo = src.stretchers.length > 1 || (fxp && fxp.enabled && fxp.enabled.binaural);
  const out = stereo ? [L.slice(0, end), R.slice(0, end)] : [L.slice(0, end)];
  const { peak } = finish(out, { gain, normalize });
  return { channels: out, frames: end, body: n, tail: end - n, peak };
}
