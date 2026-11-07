// PaulStretch DSP core — a from-scratch JavaScript port of the algorithm
// by Nasca Octavian Paul (and the PaulXStretch spectral modules by Xenakios).
// Runs anywhere: Web Worker, main thread, or Node (for tests).

export const WINDOW_TYPES = ['rectangular', 'hamming', 'hann', 'blackman', 'blackman-harris'];

export const MODULES = ['harmonics', 'pitchShift', 'freqShift', 'spread', 'tonalNoise', 'filter', 'ratioMix', 'compressor'];

export const RATIOS = [0.25, 0.5, 1.0, 2.0, 3.0, 4.0, 1.5, 1.0 / 1.5];

export function defaultParams() {
  return {
    stretch: 8,
    bufsize: 16384,          // half the analysis window (window = 2 * bufsize)
    windowType: 'hamming',
    onset: 0,                // 0..1 onset detection sensitivity
    freeze: false,
    loop: true,
    start: 0,                // play range, fractions of the file
    end: 1,
    volumeDb: -3,
    monoToStereo: true,      // run 2 decorrelated stretchers on mono input
    order: MODULES.slice(),
    enabled: { harmonics: false, pitchShift: true, freqShift: true, spread: false, tonalNoise: false, filter: false, ratioMix: false, compressor: false },
    harmonics: { count: 10, freq: 128, bandwidth: 25, gauss: false },
    pitchShift: { semitones: 0 },
    freqShift: { hz: 0 },
    spread: { amount: 0 },
    tonalNoise: { bandwidth: 0.74, preserve: 0.5 },
    filter: { low: 20, high: 20000, stop: false },
    ratioMix: { levels: [0, 0, 1, 0, 0, 0, 0, 0] },
    compressor: { amount: 0 },
  };
}

// ---------------------------------------------------------------- FFT

const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;

// Real FFT of size n (power of two) implemented as a complex FFT of size n/2.
export class RealFFT {
  constructor(n) {
    if (!isPow2(n) || n < 4) throw new Error('FFT size must be a power of two >= 4');
    this.n = n;
    const m = (this.m = n >> 1);
    this.re = new Float64Array(m);
    this.im = new Float64Array(m);
    this.Xr = new Float64Array(m + 1);
    this.Xi = new Float64Array(m + 1);
    let bits = 0;
    while ((1 << bits) < m) bits++;
    this.rev = new Uint32Array(m);
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    const h = Math.max(1, m >> 1);
    this.cos = new Float64Array(h);
    this.sin = new Float64Array(h);
    for (let k = 0; k < h; k++) {
      this.cos[k] = Math.cos((2 * Math.PI * k) / m);
      this.sin[k] = Math.sin((2 * Math.PI * k) / m);
    }
    this.twc = new Float64Array(m);
    this.tws = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      this.twc[k] = Math.cos((2 * Math.PI * k) / n);
      this.tws[k] = Math.sin((2 * Math.PI * k) / n);
    }
  }

  _complex(inverse) {
    const { re, im, rev, m } = this;
    for (let i = 0; i < m; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= m; size <<= 1) {
      const half = size >> 1;
      const step = m / size;
      for (let i = 0; i < m; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = this.cos[k], wi = sgn * this.sin[k];
          const a = i + j, b = a + half;
          const tr = wr * re[b] - wi * im[b];
          const ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // x: real input of length n -> mag[0..m-1] = |X[k]| (unnormalised, like FFTW R2HC)
  forwardMag(x, mag) {
    const { re, im, m, twc, tws } = this;
    for (let i = 0; i < m; i++) { re[i] = x[2 * i]; im[i] = x[2 * i + 1]; }
    this._complex(false);
    for (let k = 0; k < m; k++) {
      const k2 = k === 0 ? 0 : m - k;
      const zr = re[k], zi = im[k], cr = re[k2], ci = -im[k2];
      const fer = 0.5 * (zr + cr), fei = 0.5 * (zi + ci);
      const fOr = 0.5 * (zi - ci), fOi = -0.5 * (zr - cr);
      const c = twc[k], s = tws[k];
      const xr = fer + c * fOr + s * fOi;
      const xi = fei + c * fOi - s * fOr;
      mag[k] = Math.sqrt(xr * xr + xi * xi);
    }
  }

  // Builds a spectrum from magnitudes with random phases, inverse transforms
  // (normalised) into out[0..n-1]. DC and Nyquist are zeroed, as in the original.
  inverseRandomPhase(mag, rng, out) {
    const { re, im, m, Xr, Xi, twc, tws } = this;
    Xr[0] = Xi[0] = Xr[m] = Xi[m] = 0;
    const TWO_PI = 2 * Math.PI;
    for (let k = 1; k < m; k++) {
      const ph = rng() * TWO_PI;
      Xr[k] = mag[k] * Math.cos(ph);
      Xi[k] = mag[k] * Math.sin(ph);
    }
    for (let k = 0; k < m; k++) {
      const ar = Xr[k], ai = Xi[k], br = Xr[m - k], bi = -Xi[m - k];
      const fer = 0.5 * (ar + br), fei = 0.5 * (ai + bi);
      const dr = 0.5 * (ar - br), di = 0.5 * (ai - bi);
      const c = twc[k], s = tws[k];
      const fOr = dr * c - di * s, fOi = dr * s + di * c;
      re[k] = fer - fOi;
      im[k] = fei + fOr;
    }
    this._complex(true);
    const sc = 1 / m;
    for (let i = 0; i < m; i++) { out[2 * i] = re[i] * sc; out[2 * i + 1] = im[i] * sc; }
  }
}

export function makeWindow(type, n) {
  const w = new Float32Array(n);
  const P = Math.PI;
  for (let i = 0; i < n; i++) {
    switch (type) {
      case 'hamming': w[i] = 0.53836 - 0.46164 * Math.cos((2 * P * i) / (n + 1)); break;
      case 'hann': w[i] = 0.5 * (1 - Math.cos((2 * P * i) / (n - 1))); break;
      case 'blackman': w[i] = 0.42 - 0.5 * Math.cos((2 * P * i) / (n - 1)) + 0.08 * Math.cos((4 * P * i) / (n - 1)); break;
      case 'blackman-harris':
        w[i] = 0.35875 - 0.48829 * Math.cos((2 * P * i) / (n - 1)) + 0.14128 * Math.cos((4 * P * i) / (n - 1)) - 0.01168 * Math.cos((6 * P * i) / (n - 1));
        break;
      default: w[i] = 0.707;
    }
  }
  return w;
}

export function makeRng(seed) {
  // mulberry32
  let a = (seed * 0x9e3779b9) >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- spectral modules
// Each takes (input spectrum a, output spectrum b, nfreq, ...). a and b never alias.

function profile(fi, bwi) {
  let x = fi / bwi;
  x *= x;
  return x > 14.71280603 ? 0 : Math.exp(-x);
}

function spread(nfreq, sr, tmp, a, b, bandwidth) {
  const minf = 20, maxf = 0.5 * sr;
  const lmin = Math.log(minf), lmax = Math.log(maxf);
  for (let i = 0; i < nfreq; i++) {
    const x = (Math.exp(lmin + (i / nfreq) * (lmax - lmin)) / maxf) * nfreq;
    let x0 = Math.floor(x); if (x0 >= nfreq) x0 = nfreq - 1;
    let x1 = x0 + 1; if (x1 >= nfreq) x1 = nfreq - 1;
    const xp = x - x0;
    tmp[i] = x < nfreq ? a[x0] * (1 - xp) + a[x1] * xp : 0;
  }
  let k = 1 - Math.pow(2, -bandwidth * bandwidth * 10);
  k = Math.pow(k, (8192 / nfreq) * 2);
  for (let pass = 0; pass < 2; pass++) {
    tmp[0] = 0;
    for (let i = 1; i < nfreq; i++) tmp[i] = tmp[i - 1] * k + tmp[i] * (1 - k);
    tmp[nfreq - 1] = 0;
    for (let i = nfreq - 2; i > 0; i--) tmp[i] = tmp[i + 1] * k + tmp[i] * (1 - k);
  }
  b[0] = 0;
  const ld = Math.log(maxf / minf);
  for (let i = 1; i < nfreq; i++) {
    const x = (Math.log(((i / nfreq) * maxf) / minf) / ld) * nfreq;
    let y = 0;
    if (x > 0 && x < nfreq) {
      let x0 = Math.floor(x); if (x0 >= nfreq) x0 = nfreq - 1;
      let x1 = x0 + 1; if (x1 >= nfreq) x1 = nfreq - 1;
      const xp = x - x0;
      y = tmp[x0] * (1 - xp) + tmp[x1] * xp;
    }
    b[i] = y;
  }
}

function compressor(nfreq, a, b, power) {
  let rms = 0;
  for (let i = 0; i < nfreq; i++) rms += a[i] * a[i];
  rms = Math.sqrt(rms / nfreq) * 0.1;
  if (rms < 1e-3) rms = 1e-3;
  const g = Math.pow(rms, -power);
  for (let i = 0; i < nfreq; i++) b[i] = a[i] * g;
}

function tonalNoise(nfreq, sr, tmp, smooth, a, b, bandwidth, preserve) {
  spread(nfreq, sr, tmp, a, smooth, bandwidth);
  if (preserve >= 0) {
    const mul = Math.pow(10, preserve) - 1;
    for (let i = 0; i < nfreq; i++) {
      const r = a[i] - (smooth[i] + 1e-6) * mul;
      b[i] = r < 0 ? 0 : r;
    }
  } else {
    const mul = Math.pow(5, 1 + preserve) - 1;
    for (let i = 0; i < nfreq; i++) {
      const r = a[i] - (smooth[i] + 1e-6) * mul + 0.1 * mul;
      b[i] = r < 0 ? a[i] : 0;
    }
  }
}

function harmonics(nfreq, sr, amp, a, b, p) {
  const freq = Math.max(10, p.freq);
  amp.fill(0, 0, nfreq);
  const reach = Math.sqrt(14.71280603);
  for (let nh = 1; nh <= p.count; nh++) {
    const f = nh * freq;
    if (f >= sr / 2) break;
    const bwHz = (Math.pow(2, p.bandwidth / 1200) - 1) * f;
    const bwi = bwHz / (2 * sr);
    const fi = f / sr;
    // bins where the gaussian profile is non-zero: |i/(2 nfreq) - fi| < reach * bwi
    const lo = Math.max(1, Math.floor((fi - reach * bwi) * 2 * nfreq));
    const hi = Math.min(nfreq - 1, Math.ceil((fi + reach * bwi) * 2 * nfreq));
    for (let i = lo; i <= hi; i++) amp[i] += profile((i / nfreq) * 0.5 - fi, bwi);
  }
  let max = 0;
  for (let i = 1; i < nfreq; i++) if (amp[i] > max) max = amp[i];
  if (max < 1e-8) max = 1e-8;
  b[0] = a[0];
  for (let i = 1; i < nfreq; i++) {
    let g = amp[i] / max;
    if (!p.gauss) g = g < 0.368 ? 0 : 1;
    b[i] = a[i] * g;
  }
}

function freqShift(nfreq, sr, a, b, hz) {
  b.fill(0, 0, nfreq);
  const sh = Math.trunc((hz / (sr * 0.5)) * nfreq);
  for (let i = 0; i < nfreq; i++) {
    const i2 = sh + i;
    if (i2 > 0 && i2 < nfreq) b[i2] = a[i];
  }
}

function pitchShift(nfreq, a, b, rap) {
  b.fill(0, 0, nfreq);
  if (rap < 1) {
    for (let i = 0; i < nfreq; i++) {
      const i2 = Math.trunc(i * rap);
      if (i2 >= nfreq) break;
      b[i2] += a[i];
    }
  } else {
    const r = 1 / rap;
    for (let i = 0; i < nfreq; i++) b[i] = a[Math.trunc(i * r)];
  }
}

function ratioMix(nfreq, sum, tmp, a, b, levels) {
  sum.fill(0, 0, nfreq);
  let total = 0.01;
  for (let r = 0; r < RATIOS.length; r++) {
    const lvl = levels[r] || 0;
    total += lvl;
    if (lvl > 1e-3) {
      pitchShift(nfreq, a, tmp, RATIOS[r]);
      for (let i = 0; i < nfreq; i++) sum[i] += tmp[i] * lvl;
    }
  }
  if (total < 0.5) total = 0.5;
  for (let i = 0; i < nfreq; i++) b[i] = sum[i] / total;
}

function filter(nfreq, sr, a, b, p) {
  const low = Math.min(p.low, p.high), high = Math.max(p.low, p.high);
  const ilow = Math.trunc((low / sr) * nfreq * 2);
  const ihigh = Math.trunc((high / sr) * nfreq * 2);
  for (let i = 0; i < nfreq; i++) {
    let g = i >= ilow && i < ihigh ? 1 : 0;
    if (p.stop) g = 1 - g;
    b[i] = a[i] * g;
  }
}

// ---------------------------------------------------------------- Stretcher (one channel)

export class Stretcher {
  constructor(bufsize, sampleRate, seed = 1) {
    this.sr = sampleRate;
    this.rng = makeRng(seed);
    this.windowType = null;
    this.rap = 1;
    this.onsetSens = 0;
    this.freezing = false;
    this.remained = 0;
    this.requireNew = false;
    this.extraCredit = 0;
    this.skip = 0;
    this.setBufferSize(bufsize);
  }

  setBufferSize(b) {
    b = Math.max(8, b);
    this.bufsize = b;
    const n = 2 * b;
    this.fft = new RealFFT(n);
    this.window = null;
    this.windowType = null;
    this.out = new Float32Array(b);
    this.oldFreq = new Float32Array(b);
    this.inFreq = new Float32Array(b + 1);
    this.veryOld = new Float32Array(b);
    this.oldS = new Float32Array(b);
    this.newS = new Float32Array(b);
    this.oldOut = new Float32Array(n);
    this.work = new Float32Array(n);
    this.outSmp = new Float32Array(n);
    this.freq = new Float32Array(b + 1);
    this.specIn = new Float32Array(b);
    this.tmp1 = new Float32Array(b);
    this.tmp2 = new Float32Array(b);
    this.tmp3 = new Float32Array(b);
  }

  getMaxBufsize() { return this.bufsize * 2; }

  _applyWindow(buf, type) {
    if (this.windowType !== type) {
      this.windowType = type;
      this.window = makeWindow(type, 2 * this.bufsize);
    }
    const w = this.window;
    for (let i = 0; i < buf.length; i++) buf[i] *= w[i];
  }

  _analyse(smps, off, windowType) {
    const b = this.bufsize, w = this.work;
    w.set(this.oldS, 0);
    w.set(smps.subarray(off, off + b), b);
    this.oldFreq.set(this.inFreq.subarray(0, b));
    this._applyWindow(w, windowType);
    this.fft.forwardMag(w, this.inFreq);
    this.inFreq[0] = 0;
  }

  _nextInbuf(smps, off) {
    const b = this.bufsize;
    this.veryOld.set(this.oldS);
    this.oldS.set(this.newS);
    this.newS.set(smps.subarray(off, off + b));
  }

  _detectOnset() {
    const b = this.bufsize;
    const maxk = 1 + Math.trunc((b * 500) / (this.sr * 0.5));
    let os = 0, osinc = 0, osincold = 1e-5, k = 0;
    for (let i = 0; i < b; i++) {
      osinc += this.inFreq[i] - this.oldFreq[i];
      osincold += this.oldFreq[i];
      if (k >= maxk) { k = 0; os += osinc / osincold; osinc = 0; }
      k++;
    }
    os += osinc;
    if (os < 0) os = 0;
    const strength = Math.pow(20, 1 - this.onsetSens) - 1;
    const strengthH = strength * 0.75;
    let r = 0;
    if (os > strengthH) r = Math.min(1, (os - strengthH) / (strength - strengthH));
    return r;
  }

  // smps: Float32Array with nsmps (0, bufsize or 2*bufsize) new input samples.
  // Produces this.out (bufsize samples). Returns onset strength 0..1.
  process(smps, nsmps, params) {
    const b = this.bufsize;
    const wt = params.windowType;
    let onset = 0;
    if (nsmps !== 0) {
      if (this.onsetSens > 1e-3) {
        for (let k = 0; k < nsmps; k += b) this._analyse(smps, k, wt);
        onset = this._detectOnset();
      }
      for (let k = 0; k < nsmps; k += b) this._nextInbuf(smps, k);
    }

    // input window at the fractional read position
    let start = Math.floor(this.remained * b);
    if (start >= b) start = b - 1;
    const w = this.work;
    w.set(this.veryOld.subarray(start), 0);
    w.set(this.oldS, b - start);
    w.set(this.newS.subarray(0, start), 2 * b - start);
    this._applyWindow(w, wt);
    this.fft.forwardMag(w, this.freq);

    this._processSpectrum(this.freq, params);

    this.fft.inverseRandomPhase(this.freq, this.rng, this.outSmp);

    // overlap-add with amplitude-modulation correction
    const t = Math.PI / b;
    const hinv = 0.853553390593;
    const o = this.outSmp, old = this.oldOut, out = this.out;
    for (let i = 0; i < b; i++) {
      const a = 0.5 + 0.5 * Math.cos(i * t);
      const v = o[i + b] * (1 - a) + old[i] * a;
      out[i] = v * (hinv - (1 - hinv) * Math.cos(i * 2 * t)) * 2;
    }
    old.set(o);

    if (!this.freezing) {
      let r = 1 / this.rap;
      if (this.extraCredit > 0) {
        const get = 0.5 * r;
        this.extraCredit = Math.max(0, this.extraCredit - get);
        r -= get;
      }
      this.remained += r;
      if (this.remained >= 1) {
        this.skip = Math.floor(this.remained - 1) * b;
        this.remained -= Math.floor(this.remained);
        this.requireNew = true;
      } else {
        this.requireNew = false;
      }
    }
    return onset;
  }

  hereIsOnset(onset) {
    if (this.freezing) return;
    if (onset > 0.5) {
      this.requireNew = true;
      this.extraCredit += 1 - this.remained;
      this.remained = 0;
      this.skip = 0;
    }
  }

  getNSamples() { return this.freezing ? 0 : this.requireNew ? this.bufsize : 0; }
  getSkip() { return this.freezing ? 0 : this.skip; }

  _processSpectrum(freq, p) {
    const nfreq = this.bufsize, sr = this.sr;
    const a = this.specIn;
    for (const name of p.order) {
      if (!p.enabled[name]) continue;
      a.set(freq.subarray(0, nfreq));
      switch (name) {
        case 'harmonics': harmonics(nfreq, sr, this.tmp1, a, freq, p.harmonics); break;
        case 'tonalNoise': tonalNoise(nfreq, sr, this.tmp1, this.tmp2, a, freq, p.tonalNoise.bandwidth, p.tonalNoise.preserve); break;
        case 'freqShift': if (p.freqShift.hz !== 0) freqShift(nfreq, sr, a, freq, p.freqShift.hz); break;
        case 'pitchShift': {
          const cents = Math.trunc(p.pitchShift.semitones * 100);
          if (cents !== 0) pitchShift(nfreq, a, freq, Math.pow(2, cents / 1200));
          break;
        }
        case 'ratioMix': ratioMix(nfreq, this.tmp2, this.tmp1, a, freq, p.ratioMix.levels); break;
        case 'spread': spread(nfreq, sr, this.tmp1, a, freq, p.spread.amount); break;
        case 'filter': filter(nfreq, sr, a, freq, p.filter); break;
        case 'compressor': compressor(nfreq, a, freq, p.compressor.amount); break;
      }
    }
  }
}

// ---------------------------------------------------------------- Engine (multi-channel + file reader)

export class Engine {
  // channels: Float32Array[] of equal length
  constructor(channels, sampleRate, params = defaultParams()) {
    this.input = channels;
    this.length = channels[0].length;
    this.sr = sampleRate;
    this.params = params;
    this.seed = 1;
    this.stretchers = [];
    this.pos = 0;
    this.ended = false;
    this.tailFrames = 0;
    this._configure();
    this.seek(params.start);
  }

  get numOut() { return this.input.length === 1 && this.params.monoToStereo ? 2 : this.input.length; }

  _configure() {
    const p = this.params;
    const n = this.numOut;
    this.stretchers = [];
    for (let i = 0; i < n; i++) this.stretchers.push(new Stretcher(p.bufsize, this.sr, this.seed++));
    this.inbufs = Array.from({ length: n }, () => new Float32Array(2 * p.bufsize));
    this.first = true;
    this._applyLive();
  }

  _applyLive() {
    const p = this.params;
    for (const s of this.stretchers) {
      s.rap = Math.max(0.01, p.stretch);
      s.freezing = !!p.freeze;
      s.onsetSens = p.onset;
      if (p.onset < 1e-3) s.extraCredit = 0;
    }
  }

  setParams(np) {
    const old = this.params;
    this.params = { ...old, ...np };
    const needReinit = this.params.bufsize !== old.bufsize || this.params.monoToStereo !== old.monoToStereo;
    if (needReinit) this._configure();
    else this._applyLive();
    if (this.params.start !== old.start || this.params.end !== old.end) {
      const [s, e] = this._range();
      if (this.pos < s || this.pos >= e) this.pos = s;
    }
    if (this.params.loop && this.ended) { this.ended = false; this.tailFrames = 0; }
    return needReinit;
  }

  _range() {
    const p = this.params;
    let s = Math.floor(Math.min(p.start, p.end) * this.length);
    let e = Math.floor(Math.max(p.start, p.end) * this.length);
    if (e - s < 64) e = Math.min(this.length, s + 64);
    return [s, e];
  }

  seek(frac) {
    const [s, e] = this._range();
    this.pos = Math.min(e - 1, Math.max(s, Math.floor(frac * this.length)));
    this.ended = false;
    this.tailFrames = 0;
    this._configure();
  }

  _read(n) {
    const [s, e] = this._range();
    const loop = this.params.loop;
    const ins = this.input;
    for (let i = 0; i < n; i++) {
      if (this.pos >= e) {
        if (loop) this.pos = s;
        else { this.ended = true; }
      }
      for (let c = 0; c < this.inbufs.length; c++) {
        this.inbufs[c][i] = this.ended ? 0 : ins[c % ins.length][this.pos];
      }
      if (!this.ended) this.pos++;
    }
  }

  _skip(n) {
    const [s, e] = this._range();
    if (this.params.loop) {
      const len = e - s;
      this.pos = s + ((this.pos - s + n) % len);
    } else {
      this.pos += n;
      if (this.pos >= e) { this.pos = e; this.ended = true; }
    }
  }

  get position() { return this.pos / this.length; }

  get finished() { return this.ended && this.tailFrames > 3; }

  // Produces one frame of bufsize samples per output channel.
  renderFrame() {
    const st = this.stretchers;
    const s0 = st[0];
    const n = this.first ? s0.getMaxBufsize() : s0.getNSamples();
    this.first = false;
    const inPos = this.position;
    if (n > 0) this._read(n);
    let onsetMax = 0;
    for (let c = 0; c < st.length; c++) {
      const o = st[c].process(this.inbufs[c], n, this.params);
      if (o > onsetMax) onsetMax = o;
    }
    for (const s of st) s.hereIsOnset(onsetMax);
    const skip = s0.getSkip();
    if (skip > 0) this._skip(skip);
    if (this.ended) this.tailFrames++;
    return { out: st.map((s) => s.out), inPos };
  }
}
