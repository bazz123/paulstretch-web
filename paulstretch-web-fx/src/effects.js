// Shared time-domain effects: Binaural → 3-band EQ → Chorus → Reverb.
// Plain JavaScript with no browser audio APIs, so the exact same code runs in
// the AudioWorklet (live playback) and in the export worker.
//
// Every parameter is smoothed per sample and every periodic update is keyed to
// an absolute sample counter, so the output does not depend on how the audio
// is cut into blocks (128-sample worklet quanta vs. large export chunks).

export const FX_NAMES = ['binaural', 'eq3', 'chorus', 'reverb'];
export const FX_REORDERABLE = ['eq3', 'chorus', 'reverb']; // binaural is always first

export const EQ_LOW_FREQ = 250;
export const EQ_HIGH_FREQ = 4000;

export function defaultFx() {
  return {
    order: ['eq3', 'chorus', 'reverb'],
    enabled: { binaural: false, eq3: false, chorus: false, reverb: false },
    binaural: {
      mode: 'original',            // 'original' | 'tones' | 'both'
      beat: 6,                     // Hz, 0.5..30
      stereoMode: 'lr',            // 'lr' | 'rl' | 'sym'
      amount: 0.5,                 // original "power": how much L/R are shared before shifting
      carrier: 200,                // Hz, tone generator
      level: 0.2,                  // tone generator level 0..1
      glide: { enabled: false, start: 10, end: 4, duration: 600, curve: 'exp', direction: 'decreasing' },
    },
    eq3: { low: 0, mid: 0, high: 0, midFreq: 1000, midQ: 0.7 },
    chorus: { rate: 0.2, depth: 0.6, voices: 3, spread: 0.8, mix: 0.3 },
    reverb: { size: 0.7, decay: 8, damping: 0.5, predelay: 20, width: 1, mix: 0.35, shimmer: false, shimmerAmount: 0.3 },
  };
}

// Fills in anything missing (older presets, partial objects).
export function normalizeFx(fx) {
  const d = defaultFx();
  if (!fx || typeof fx !== 'object') return d;
  const out = { ...d, ...fx };
  out.enabled = { ...d.enabled, ...(fx.enabled || {}) };
  for (const k of FX_NAMES) out[k] = { ...d[k], ...(fx[k] || {}) };
  out.binaural.glide = { ...d.binaural.glide, ...((fx.binaural && fx.binaural.glide) || {}) };
  const order = Array.isArray(fx.order) ? fx.order.filter((n) => FX_REORDERABLE.includes(n)) : [];
  for (const n of FX_REORDERABLE) if (!order.includes(n)) order.push(n);
  out.order = order;
  return out;
}

// Beat frequency at time t (seconds since playback/export start).
export function beatAt(b, t) {
  const g = b.glide;
  if (!g.enabled) return b.beat;
  const lo = Math.min(g.start, g.end), hi = Math.max(g.start, g.end);
  const from = g.direction === 'increasing' ? lo : hi;
  const to = g.direction === 'increasing' ? hi : lo;
  const f = Math.min(1, Math.max(0, t / Math.max(1, g.duration)));
  return g.curve === 'exp' ? from * Math.pow(to / from, f) : from + (to - from) * f;
}

// ---------------------------------------------------------------- helpers

class Smooth {
  constructor(v, ms, sr) { this.v = v; this.t = v; this.k = 1 - Math.exp(-1 / Math.max(1, (ms * 0.001) * sr)); }
  set(t) { this.t = t; }
  jump(t) { this.v = this.t = t; }
  next() {
    const d = this.t - this.v;
    if (d > 1e-9 || d < -1e-9) this.v += d * this.k; else this.v = this.t;
    return this.v;
  }
  get settled() { return Math.abs(this.t - this.v) < 1e-7; }
}

const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

class DelayLine {
  constructor(maxSamples) { this.size = pow2(maxSamples + 4); this.mask = this.size - 1; this.buf = new Float32Array(this.size); this.w = 0; }
  write(x) { this.buf[this.w] = x; this.w = (this.w + 1) & this.mask; }
  // fractional read, d >= 1 samples behind the last write (cubic Hermite)
  read(d) {
    const p = this.w - 1 - d;
    const i = Math.floor(p), f = p - i, m = this.mask, b = this.buf;
    const xm1 = b[(i - 1) & m], x0 = b[i & m], x1 = b[(i + 1) & m], x2 = b[(i + 2) & m];
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
  readInt(d) { return this.buf[(this.w - 1 - d) & this.mask]; }
  readLin(d) {
    const p = this.w - 1 - d, i = Math.floor(p), f = p - i, m = this.mask;
    const a = this.buf[i & m];
    return a + (this.buf[(i + 1) & m] - a) * f;
  }
  clear() { this.buf.fill(0); }
}

// ---------------------------------------------------------------- Binaural (PaulXStretch port + tone generator)

// Allpass pair Hilbert transformer, coefficients by Olli Niemitalo (as in PaulStretch).
const HCL = [0.6923877778065, 0.9360654322959, 0.988229522686, 0.9987488452737];
const HCR = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278];

class Hilbert {
  constructor() {
    this.al = HCL.map((c) => c * c); this.ar = HCR.map((c) => c * c);
    this.s = new Float64Array(32); // 8 allpasses x (in1, in2, out1, out2)
    this.old = 0; this.o1 = 0; this.o2 = 0;
  }
  process(x) {
    let a = this.old, b = x;
    const s = this.s;
    for (let i = 0; i < 4; i++) {
      let k = i * 4;
      let y = this.al[i] * (a + s[k + 3]) - s[k + 1];
      s[k + 1] = s[k]; s[k] = a; s[k + 3] = s[k + 2]; s[k + 2] = y; a = y;
      k = 16 + i * 4;
      y = this.ar[i] * (b + s[k + 3]) - s[k + 1];
      s[k + 1] = s[k]; s[k] = b; s[k + 3] = s[k + 2]; s[k + 2] = y; b = y;
    }
    this.old = x;
    this.o1 = a; this.o2 = b;
  }
  clear() { this.s.fill(0); this.old = this.o1 = this.o2 = 0; }
}

class Binaural {
  constructor(sr) {
    this.sr = sr;
    this.hl = new Hilbert(); this.hr = new Hilbert();
    this.ph = 0; this.phL = 0; this.phR = 0;
    this.beat = new Smooth(6, 80, sr);
    this.amount = new Smooth(0.5, 30, sr);
    this.shiftMix = new Smooth(1, 30, sr);   // original method on/off within the effect
    this.toneLevel = new Smooth(0, 30, sr);
    this.carrier = new Smooth(200, 50, sr);
    this.p = defaultFx().binaural;
  }
  set(p) {
    this.p = p;
    this.amount.set(p.amount);
    this.shiftMix.set(p.mode === 'tones' ? 0 : 1);
    this.toneLevel.set(p.mode === 'original' ? 0 : p.level);
    this.carrier.set(p.carrier);
  }
  clear() { this.hl.clear(); this.hr.clear(); }
  process(L, R, n, i0, wet, t0, advance) {
    const sr = this.sr, p = this.p, sm = p.stereoMode;
    for (let i = 0; i < n; i++) {
      const t = advance ? t0 + i / sr : t0;
      this.beat.set(beatAt(p, t));
      const beat = this.beat.next();
      const mono = this.amount.next() * 0.5;
      const shift = this.shiftMix.next();
      const inl = L[i], inr = R[i];
      // original PaulXStretch processing
      const xl = inl * (1 - mono) + inr * mono;
      const xr = inr * (1 - mono) + inl * mono;
      this.ph += (beat * 0.5) / sr;
      this.ph -= Math.floor(this.ph);
      const x = this.ph * 2 * Math.PI, c = Math.cos(x), s = Math.sin(x);
      this.hl.process(xl);
      let m1 = this.hl.o1 * c, m2 = this.hl.o2 * s;
      const outl1 = m1 + m2, outl2 = m1 - m2;
      this.hr.process(xr);
      m1 = this.hr.o1 * c; m2 = this.hr.o2 * s;
      const outr1 = m1 - m2, outr2 = m1 + m2;
      let bl, br;
      if (sm === 'rl') { bl = outl1; br = outr1; }
      else if (sm === 'sym') { bl = 0.5 * (outl1 + outr1); br = 0.5 * (outl2 + outr2); }
      else { bl = outl2; br = outr2; }
      let ol = inl + (bl - inl) * shift, or = inr + (br - inr) * shift;
      // tone generator: two carriers a beat apart
      const lvl = this.toneLevel.next();
      const car = this.carrier.next();
      this.phL += (car - beat * 0.5) / sr; this.phL -= Math.floor(this.phL);
      this.phR += (car + beat * 0.5) / sr; this.phR -= Math.floor(this.phR);
      if (lvl > 1e-6) {
        ol += lvl * 0.25 * Math.sin(2 * Math.PI * this.phL);
        or += lvl * 0.25 * Math.sin(2 * Math.PI * this.phR);
      }
      const w = wet[i];
      L[i] = inl + (ol - inl) * w;
      R[i] = inr + (or - inr) * w;
    }
  }
}

// ---------------------------------------------------------------- 3-band EQ (RBJ biquads)

function shelfCoefs(type, f, db, sr) {
  const A = Math.pow(10, db / 40), w = (2 * Math.PI * f) / sr, c = Math.cos(w), s = Math.sin(w);
  const al = (s / 2) * Math.SQRT2, sa = 2 * Math.sqrt(A) * al;
  let b0, b1, b2, a0, a1, a2;
  if (type === 'low') {
    b0 = A * ((A + 1) - (A - 1) * c + sa); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sa);
    a0 = (A + 1) + (A - 1) * c + sa; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sa;
  } else {
    b0 = A * ((A + 1) + (A - 1) * c + sa); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - sa);
    a0 = (A + 1) - (A - 1) * c + sa; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - sa;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function peakCoefs(f, db, q, sr) {
  const A = Math.pow(10, db / 40), w = (2 * Math.PI * f) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  const a0 = 1 + al / A;
  return [(1 + al * A) / a0, (-2 * c) / a0, (1 - al * A) / a0, (-2 * c) / a0, (1 - al / A) / a0];
}

export function eqCoefs(p, sr) {
  return [shelfCoefs('low', EQ_LOW_FREQ, p.low, sr), peakCoefs(Math.min(p.midFreq, sr * 0.45), p.mid, p.midQ, sr), shelfCoefs('high', Math.min(EQ_HIGH_FREQ, sr * 0.45), p.high, sr)];
}

// Magnitude response in dB at the given frequencies (for the EQ graph).
export function eqResponseDb(p, sr, freqs) {
  const cs = eqCoefs(p, sr);
  return freqs.map((f) => {
    const w = (2 * Math.PI * f) / sr;
    let mag = 1;
    for (const [b0, b1, b2, a1, a2] of cs) {
      const c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2);
      const dr = 1 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
      mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    }
    return 20 * Math.log10(mag);
  });
}

class Eq3 {
  constructor(sr) {
    this.sr = sr;
    const d = defaultFx().eq3;
    this.s = { low: new Smooth(d.low, 40, sr), mid: new Smooth(d.mid, 40, sr), high: new Smooth(d.high, 40, sr), midFreq: new Smooth(d.midFreq, 60, sr), midQ: new Smooth(d.midQ, 60, sr) };
    this.list = Object.values(this.s);
    this.z = new Float64Array(12); // 3 stages x 2 channels x 2 state
    this.c = eqCoefs(d, sr);
  }
  set(p) { for (const k in this.s) this.s[k].set(p[k]); }
  clear() { this.z.fill(0); }
  // coefficients follow the smoothed values; recomputed every 32 samples while moving
  _update() {
    const s = this.s;
    this.c = eqCoefs({ low: s.low.v, mid: s.mid.v, high: s.high.v, midFreq: s.midFreq.v, midQ: s.midQ.v }, this.sr);
  }
  process(L, R, n, i0, wet) {
    const z = this.z, s = this.s;
    for (let i = 0; i < n; i++) {
      let moving = false;
      for (const sm of this.list) { sm.next(); if (!sm.settled) moving = true; }
      if (moving ? ((i0 + i) & 31) === 0 : this.wasMoving) this._update();
      this.wasMoving = moving;
      const c = this.c;
      for (let ch = 0; ch < 2; ch++) {
        const buf = ch ? R : L;
        const dry = buf[i];
        let x = dry;
        for (let st = 0; st < 3; st++) {
          const [b0, b1, b2, a1, a2] = c[st];
          const k = (st * 2 + ch) * 2;
          const y = b0 * x + z[k];
          z[k] = b1 * x - a1 * y + z[k + 1];
          z[k + 1] = b2 * x - a2 * y;
          x = y;
        }
        buf[i] = dry + (x - dry) * wet[i];
      }
    }
  }
}

// ---------------------------------------------------------------- Chorus (up to 4 voices, per-channel, no L/R mixing)

const CH_BASE_MS = [11, 16.5, 22, 27.5];
const CH_RATE_MUL = [1, 1.13, 0.87, 1.27];

class Chorus {
  constructor(sr) {
    this.sr = sr;
    this.dl = [new DelayLine(Math.ceil(0.05 * sr)), new DelayLine(Math.ceil(0.05 * sr))];
    this.phase = new Float64Array(4);
    const d = defaultFx().chorus;
    this.rate = new Smooth(d.rate, 100, sr);
    this.depth = new Smooth(d.depth, 60, sr);
    this.spread = new Smooth(d.spread, 60, sr);
    this.mix = new Smooth(d.mix, 30, sr);
    this.vg = [0, 1, 2, 3].map((k) => new Smooth(k < d.voices ? 1 : 0, 40, sr));
    this.voices = d.voices;
    for (let k = 0; k < 4; k++) this.phase[k] = k / 4;
  }
  set(p) {
    this.rate.set(p.rate); this.depth.set(p.depth); this.spread.set(p.spread); this.mix.set(p.mix);
    const v = Math.max(1, Math.min(4, Math.round(p.voices)));
    this.voices = v;
    for (let k = 0; k < 4; k++) this.vg[k].set(k < v ? 1 : 0);
  }
  clear() { this.dl[0].clear(); this.dl[1].clear(); }
  process(L, R, n, i0, wet) {
    const sr = this.sr, msS = sr / 1000;
    for (let i = 0; i < n; i++) {
      const rate = this.rate.next(), depth = this.depth.next(), spread = this.spread.next(), mix = this.mix.next() * wet[i];
      const xl = L[i], xr = R[i];
      this.dl[0].write(xl); this.dl[1].write(xr);
      let wl = 0, wr = 0, gsum = 0;
      for (let k = 0; k < 4; k++) {
        const g = this.vg[k].next();
        this.phase[k] += (rate * CH_RATE_MUL[k]) / sr;
        if (this.phase[k] >= 1) this.phase[k] -= 1;
        if (g < 1e-5) continue;
        const amp = depth * 6 * msS;
        const base = CH_BASE_MS[k] * msS;
        const pl = this.phase[k], pr = pl + spread * 0.33;
        const dlL = base + amp * (0.5 + 0.5 * Math.sin(2 * Math.PI * pl));
        const dlR = base + amp * (0.5 + 0.5 * Math.sin(2 * Math.PI * pr));
        wl += g * this.dl[0].read(dlL);
        wr += g * this.dl[1].read(dlR);
        gsum += g;
      }
      const norm = gsum > 1e-6 ? 1 / Math.sqrt(gsum) : 0;
      L[i] = xl * (1 - mix) + wl * norm * mix;
      R[i] = xr * (1 - mix) + wr * norm * mix;
    }
  }
}

// ---------------------------------------------------------------- Reverb (8-line FDN per channel + shimmer)

const FDN_MS = [31.3, 37.9, 41.1, 47.3, 53.9, 61.7, 71.3, 79.1];
const DIFF_MS = [4.71, 3.59, 12.73, 9.31];
const OUT_SIGN = [1, -1, 1, -1, 1, -1, 1, -1];
const IN_SIGN = [1, 1, -1, -1, 1, -1, 1, -1];
const MAX_SIZE_SCALE = 2.0;
const WET_GAIN = 0.9;

class PitchUp { // two-head granular octave-up shifter
  constructor(sr) {
    this.W = Math.round(0.06 * sr);
    this.dl = new DelayLine(this.W + 8);
    this.p = 0;
  }
  process(x) {
    this.dl.write(x);
    this.p += 1 / this.W;
    if (this.p >= 1) this.p -= 1;
    let y = 0;
    for (const off of [0, 0.5]) {
      let f = this.p + off; if (f >= 1) f -= 1;
      y += Math.sin(Math.PI * f) * this.dl.read(2 + this.W * (1 - f));
    }
    return y * 0.7071;
  }
  clear() { this.dl.clear(); }
}

class FdnChannel {
  constructor(sr, skew, seed) {
    this.sr = sr;
    const msS = sr / 1000;
    this.base = FDN_MS.map((ms, i) => ms * skew * msS * (1 + 0.013 * ((i * 7 + seed) % 5)));
    this.lines = this.base.map((b) => new DelayLine(Math.ceil(b * MAX_SIZE_SCALE + 0.01 * sr)));
    this.lp = new Float64Array(8);
    this.out = new Float64Array(8);
    // slow delay modulation per line, as rotating (cos, sin) pairs: no sin() per sample
    const ph = FDN_MS.map((_, i) => 2 * Math.PI * ((i * 0.137 + seed * 0.31) % 1));
    const rate = FDN_MS.map((_, i) => 0.07 + 0.045 * ((i * 3 + seed) % 7));
    this.mc = Float64Array.from(ph, Math.cos); this.ms = Float64Array.from(ph, Math.sin);
    this.rc = Float64Array.from(rate, (r) => Math.cos((2 * Math.PI * r) / sr));
    this.rs = Float64Array.from(rate, (r) => Math.sin((2 * Math.PI * r) / sr));
    this.modDepth = 0.0004 * sr;
    this.ticks = 0;
    this.diff = DIFF_MS.map((ms) => ({ dl: new DelayLine(Math.ceil(ms * skew * msS) + 4), d: Math.round(ms * skew * msS) }));
    this.pre = new DelayLine(Math.ceil(0.5 * sr));
    this.shim = new PitchUp(sr);
    this.shimHp = 0; this.shimPrev = 0; this.shimFb = 0;
    this.h = new Float64Array(8);
    this.g = new Float64Array(8);
    this.gKey = -1; this.gKey2 = -1;
  }
  clear() {
    this.ticks = 0;
    for (const l of this.lines) l.clear();
    for (const d of this.diff) d.dl.clear();
    this.pre.clear(); this.shim.clear();
    this.lp.fill(0); this.out.fill(0);
    this.shimHp = this.shimPrev = this.shimFb = 0;
  }
  // one sample; returns wet output
  tick(x, scale, decay, damp, preSamples, shimGain) {
    const sr = this.sr;
    this.pre.write(x);
    let v = preSamples >= 1 ? this.pre.read(preSamples) : x;
    // input diffusion (Schroeder allpasses)
    const diff = this.diff;
    for (let j = 0; j < 4; j++) {
      const d = diff[j];
      const delayed = d.dl.readInt(d.d - 1);
      const w = v + 0.6 * delayed;
      d.dl.write(w);
      v = delayed - 0.6 * w;
    }
    // shimmer: octave-up of the previous output, high-passed and soft-limited, fed back in
    v += this.shimFb;
    const o = this.out;
    const mc = this.mc, ms = this.ms, rc = this.rc, rs = this.rs;
    for (let i = 0; i < 8; i++) {
      const c = mc[i] * rc[i] - ms[i] * rs[i];
      ms[i] = ms[i] * rc[i] + mc[i] * rs[i];
      mc[i] = c;
      o[i] = this.lines[i].readLin(this.base[i] * scale + this.modDepth * ms[i]);
    }
    if ((++this.ticks & 4095) === 0) {
      for (let i = 0; i < 8; i++) { const k = 1 / Math.hypot(mc[i], ms[i]); mc[i] *= k; ms[i] *= k; }
    }
    // Hadamard 8x8 (orthonormal) mixing
    let a0 = o[0] + o[1], a1 = o[0] - o[1], a2 = o[2] + o[3], a3 = o[2] - o[3];
    let a4 = o[4] + o[5], a5 = o[4] - o[5], a6 = o[6] + o[7], a7 = o[6] - o[7];
    let b0 = a0 + a2, b1 = a1 + a3, b2 = a0 - a2, b3 = a1 - a3;
    let b4 = a4 + a6, b5 = a5 + a7, b6 = a4 - a6, b7 = a5 - a7;
    const h = this.h;
    h[0] = b0 + b4; h[1] = b1 + b5; h[2] = b2 + b6; h[3] = b3 + b7; h[4] = b0 - b4; h[5] = b1 - b5; h[6] = b2 - b6; h[7] = b3 - b7;
    const nrm = 0.35355339059327373;
    if (scale !== this.gKey || decay !== this.gKey2) {
      this.gKey = scale; this.gKey2 = decay;
      for (let i = 0; i < 8; i++) this.g[i] = Math.pow(10, (-3 * this.base[i] * scale) / (decay * sr));
    }
    let wet = 0;
    for (let i = 0; i < 8; i++) {
      let f = h[i] * nrm * this.g[i];
      this.lp[i] += (1 - damp) * (f - this.lp[i]);
      f = this.lp[i];
      this.lines[i].write(f + v * IN_SIGN[i] * 0.35);
      wet += o[i] * OUT_SIGN[i];
    }
    wet *= nrm * WET_GAIN;
    if (shimGain > 1e-5) {
      const up = this.shim.process(wet);
      this.shimHp = 0.995 * (this.shimHp + up - this.shimPrev);
      this.shimPrev = up;
      this.shimFb = Math.tanh(this.shimHp * 2) * 0.5 * shimGain;
    } else {
      this.shimFb = 0;
    }
    return wet;
  }
}

class Reverb {
  constructor(sr) {
    this.sr = sr;
    this.ch = [new FdnChannel(sr, 1.0, 1), new FdnChannel(sr, 1.071, 4)];
    const d = defaultFx().reverb;
    this.size = new Smooth(d.size, 400, sr);
    this.decay = new Smooth(d.decay, 200, sr);
    this.damping = new Smooth(d.damping, 60, sr);
    this.predelay = new Smooth(d.predelay, 200, sr);
    this.width = new Smooth(d.width, 60, sr);
    this.mix = new Smooth(d.mix, 30, sr);
    this.shim = new Smooth(0, 120, sr);
  }
  set(p) {
    this.size.set(p.size); this.decay.set(p.decay); this.damping.set(p.damping); this.predelay.set(p.predelay);
    this.width.set(p.width); this.mix.set(p.mix); this.shim.set(p.shimmer ? p.shimmerAmount : 0);
  }
  clear() { this.ch[0].clear(); this.ch[1].clear(); }
  process(L, R, n, i0, wet) {
    const sr = this.sr;
    for (let i = 0; i < n; i++) {
      const size = this.size.next(), decay = this.decay.next(), damping = this.damping.next();
      const pre = this.predelay.next() * sr / 1000, width = this.width.next(), mix = this.mix.next() * wet[i];
      const shim = this.shim.next();
      const scale = 0.25 + (MAX_SIZE_SCALE - 0.25) * size;
      const damp = damping * 0.85;
      // when shimmer is on, shorten the loop slightly so the extra energy can't run away
      const dec = decay * (1 - 0.25 * shim);
      const xl = L[i], xr = R[i];
      const wl = this.ch[0].tick(xl, scale, dec, damp, pre, shim);
      const wr = this.ch[1].tick(xr, scale, dec, damp, pre, shim);
      const mid = 0.5 * (wl + wr), side = 0.5 * (wl - wr) * width;
      L[i] = xl * (1 - mix) + (mid + side) * mix;
      R[i] = xr * (1 - mix) + (mid - side) * mix;
    }
  }
}

// ---------------------------------------------------------------- chain

export class FxChain {
  constructor(sampleRate, maxBlock = 4096) {
    this.sr = sampleRate;
    this.fx = defaultFx();
    this.units = { binaural: new Binaural(sampleRate), eq3: new Eq3(sampleRate), chorus: new Chorus(sampleRate), reverb: new Reverb(sampleRate) };
    this.en = {};
    for (const k of FX_NAMES) this.en[k] = new Smooth(0, 25, sampleRate);
    this.active = {};
    this.wet = new Float32Array(maxBlock);
    this.sample = 0;        // absolute sample counter (block-size invariant updates)
    this.timeline = 0;      // samples of playback/export time, for binaural glide
  }

  setParams(fx) {
    this.fx = normalizeFx(fx);
    for (const k of FX_NAMES) {
      this.en[k].set(this.fx.enabled[k] ? 1 : 0);
      this.units[k].set(this.fx[k]);
    }
  }

  resetTimeline() { this.timeline = 0; }

  reset() {
    for (const k of FX_NAMES) this.units[k].clear();
    this.timeline = 0;
  }

  get anyActive() {
    return FX_NAMES.some((k) => this.fx.enabled[k] || this.en[k].v > 1e-5);
  }

  // Seconds of tail needed after the input stops.
  tailSeconds() {
    const f = this.fx;
    let t = 0;
    if (f.enabled.reverb) t = Math.max(t, f.reverb.predelay / 1000 + f.reverb.decay * (f.reverb.shimmer ? 1.6 : 1.15) + 0.5);
    if (f.enabled.chorus) t = Math.max(t, 0.1);
    return t;
  }

  // In-place stereo processing. advance: whether the glide timeline moves.
  process(L, R, n, advance = true) {
    for (let off = 0; off < n; off += this.wet.length) {
      const m = Math.min(this.wet.length, n - off);
      this._block(off ? L.subarray(off) : L, off ? R.subarray(off) : R, m, advance);
    }
  }

  _block(L, R, n, advance) {
    const t0 = this.timeline / this.sr;
    const chain = ['binaural', ...this.fx.order];
    for (const k of chain) {
      const e = this.en[k];
      if (e.t === 0 && e.v < 1e-5) {
        if (this.active[k]) { this.units[k].clear(); this.active[k] = false; }
        e.v = 0;
        // binaural glide time still moves while bypassed, so it stays on the timeline
        continue;
      }
      this.active[k] = true;
      const w = this.wet;
      for (let i = 0; i < n; i++) w[i] = e.next();
      if (k === 'binaural') this.units[k].process(L, R, n, this.sample, w, t0, advance);
      else this.units[k].process(L, R, n, this.sample, w);
    }
    this.sample += n;
    if (advance) this.timeline += n;
  }
}
