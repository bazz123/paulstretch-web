// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FxChain, defaultFx, beatAt, eqResponseDb, normalizeFx } from '../src/effects.js';
import { RealFFT } from '../src/dsp.js';

const SR = 48000;

function noise(n, seed = 1) {
  let a = seed;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { a = (a * 1664525 + 1013904223) >>> 0; x[i] = (a / 4294967296 - 0.5) * 0.5; }
  return x;
}
const sine = (n, f, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

function allOn() {
  const fx = defaultFx();
  for (const k of Object.keys(fx.enabled)) fx.enabled[k] = true;
  fx.reverb.shimmer = true;
  fx.binaural.mode = 'both';
  fx.binaural.glide.enabled = true;
  fx.binaural.glide.duration = 2;
  fx.eq3 = { low: 4, mid: -3, high: 2, midFreq: 900, midQ: 1.2 };
  return fx;
}

function run(fx, L, R, block) {
  const c = new FxChain(SR);
  c.setParams(fx);
  const l = Float32Array.from(L), r = Float32Array.from(R);
  for (let o = 0; o < l.length; o += block) {
    const n = Math.min(block, l.length - o);
    c.process(l.subarray(o, o + n), r.subarray(o, o + n), n);
  }
  return [l, r];
}

function peakHz(x) {
  const n = 1 << Math.floor(Math.log2(x.length));
  const fft = new RealFFT(n), mag = new Float32Array(n / 2);
  fft.forwardMag(x.subarray(x.length - n), mag);
  let k = 1;
  for (let i = 1; i < n / 2; i++) if (mag[i] > mag[k]) k = i;
  return (k * SR) / n;
}

test('output does not depend on block size (live 128 vs export chunks)', () => {
  const fx = allOn();
  const L = noise(SR * 3, 1), R = noise(SR * 3, 2);
  const [a1, a2] = run(fx, L, R, 128);
  const [b1, b2] = run(fx, L, R, 16384);
  const [c1] = run(fx, L, R, 777);
  let maxd = 0;
  for (let i = 0; i < a1.length; i++) maxd = Math.max(maxd, Math.abs(a1[i] - b1[i]), Math.abs(a2[i] - b2[i]), Math.abs(a1[i] - c1[i]));
  assert.ok(maxd < 1e-5, `max difference ${maxd}`);
});

test('all effects together stay finite and bounded on loud input', () => {
  const fx = allOn();
  fx.reverb.decay = 30; fx.reverb.shimmerAmount = 1; fx.reverb.mix = 1;
  const L = noise(SR * 20, 3), R = noise(SR * 20, 4);
  for (let i = 0; i < L.length; i++) { L[i] *= 3; R[i] *= 3; }
  const [l, r] = run(fx, L, R, 4096);
  let peak = 0;
  for (let i = 0; i < l.length; i++) { assert.ok(Number.isFinite(l[i]) && Number.isFinite(r[i])); peak = Math.max(peak, Math.abs(l[i]), Math.abs(r[i])); }
  assert.ok(peak < 20, `peak ${peak}`);
  // no runaway: the last second is not much louder than the middle
  assert.ok(rms(l, l.length - SR) < rms(l, 10 * SR, 11 * SR) * 3);
});

test('reverb tail decays roughly at the set decay time and stays stereo', () => {
  const fx = defaultFx();
  fx.enabled.reverb = true;
  fx.reverb.mix = 1; fx.reverb.decay = 3; fx.reverb.predelay = 0;
  const n = SR * 6;
  const L = new Float32Array(n), R = new Float32Array(n);
  L.set(noise(SR / 10, 5)); R.set(noise(SR / 10, 6));
  const [l, r] = run(fx, L, R, 1024);
  const e1 = rms(l, SR * 0.5, SR * 1.0), e2 = rms(l, SR * 2.0, SR * 2.5);
  const dbPerSec = (20 * Math.log10(e2 / e1)) / 1.5;
  assert.ok(dbPerSec < -12 && dbPerSec > -35, `decay ${dbPerSec.toFixed(1)} dB/s (expected about -20)`);
  let corr = 0, el = 0, er = 0;
  for (let i = SR; i < 2 * SR; i++) { corr += l[i] * r[i]; el += l[i] * l[i]; er += r[i] * r[i]; }
  assert.ok(Math.abs(corr / Math.sqrt(el * er)) < 0.5, 'left and right reverb are decorrelated');
});

test('reverb does not cross-feed channels at full width', () => {
  const fx = defaultFx();
  fx.enabled.reverb = true; fx.reverb.width = 1; fx.reverb.mix = 0.5;
  const L = noise(SR, 7), R = new Float32Array(SR);
  const [l, r] = run(fx, L, R, 512);
  // each channel has its own FDN; at 100% width nothing of the left reaches the right
  assert.ok(rms(l) > 0.01);
  assert.equal(rms(r), 0, 'right stays silent');
  // at 0% width the reverb is shared (mono), which is the documented trade-off
  fx.reverb.width = 0;
  const [, r0] = run(fx, L, R, 512);
  assert.ok(rms(r0) > 0.001);
});

test('original binaural shifts left and right apart by the beat frequency', () => {
  const fx = defaultFx();
  fx.enabled.binaural = true; fx.binaural.mode = 'original'; fx.binaural.beat = 20; fx.binaural.amount = 0;
  const x = sine(SR * 2, 1000);
  const [l, r] = run(fx, x, x, 128);
  const fl = peakHz(l), fr = peakHz(r);
  assert.ok(Math.abs(fr - fl - 20) < 3, `L ${fl.toFixed(1)} Hz, R ${fr.toFixed(1)} Hz`);
  assert.ok(Math.abs(rms(l, SR) - rms(x, SR)) < 0.05, 'level preserved');
});

test('tone generator makes carriers a beat apart', () => {
  const fx = defaultFx();
  fx.enabled.binaural = true; fx.binaural.mode = 'tones'; fx.binaural.carrier = 200; fx.binaural.beat = 10; fx.binaural.level = 1;
  const z = new Float32Array(SR * 2);
  const [l, r] = run(fx, z, z, 256);
  assert.ok(Math.abs(peakHz(l) - 195) < 2 && Math.abs(peakHz(r) - 205) < 2, `${peakHz(l)} / ${peakHz(r)}`);
});

test('glide follows the timeline with both curves and directions', () => {
  const b = defaultFx().binaural;
  b.glide = { enabled: true, start: 4, end: 16, duration: 100, curve: 'linear', direction: 'increasing' };
  assert.equal(beatAt(b, 0), 4); assert.equal(beatAt(b, 50), 10); assert.equal(beatAt(b, 500), 16);
  b.glide.curve = 'exp';
  assert.ok(Math.abs(beatAt(b, 50) - 8) < 1e-9);
  b.glide.direction = 'decreasing';
  assert.equal(beatAt(b, 0), 16); assert.equal(beatAt(b, 100), 4);
});

test('3-band EQ matches its drawn response', () => {
  const p = { low: 6, mid: -6, high: 0, midFreq: 1000, midQ: 1 };
  const [lowDb, midDb, highDb] = eqResponseDb(p, SR, [40, 1000, 15000]);
  assert.ok(Math.abs(lowDb - 6) < 0.5 && Math.abs(midDb + 6) < 0.6 && Math.abs(highDb) < 0.5, `${lowDb} ${midDb} ${highDb}`);
  const fx = defaultFx();
  fx.enabled.eq3 = true; fx.eq3 = p;
  const x = sine(SR, 1000);
  const [l] = run(fx, x, x, 128);
  const g = 20 * Math.log10(rms(l, SR / 2) / rms(x, SR / 2));
  assert.ok(Math.abs(g - midDb) < 0.5, `measured ${g.toFixed(2)} dB vs ${midDb.toFixed(2)}`);
});

test('chorus keeps channels separate and level reasonable', () => {
  const fx = defaultFx();
  fx.enabled.chorus = true; fx.chorus.mix = 0.5;
  const L = noise(SR * 2, 9), R = new Float32Array(SR * 2);
  const [l, r] = run(fx, L, R, 128);
  assert.equal(rms(r), 0, 'no bleed from left into silent right');
  const ratio = rms(l, SR) / rms(L, SR);
  assert.ok(ratio > 0.5 && ratio < 1.3, `level ratio ${ratio}`);
});

test('parameter jumps produce no clicks', () => {
  const fx = defaultFx();
  fx.enabled.eq3 = fx.enabled.chorus = fx.enabled.reverb = true;
  const c = new FxChain(SR);
  c.setParams(fx);
  const x = sine(SR * 2, 220, 0.3);
  const L = Float32Array.from(x), R = Float32Array.from(x);
  let maxStep = 0, prev = 0;
  for (let o = 0; o < L.length; o += 128) {
    if (o === SR) { fx.eq3.low = 12; fx.eq3.high = -12; fx.reverb.size = 0.1; fx.chorus.voices = 1; fx.reverb.mix = 0.9; fx.enabled.chorus = false; c.setParams(fx); }
    c.process(L.subarray(o, o + 128), R.subarray(o, o + 128), 128);
    for (let i = o; i < o + 128; i++) { if (i > SR / 2) maxStep = Math.max(maxStep, Math.abs(L[i] - prev)); prev = L[i]; }
  }
  // a 220 Hz sine at 0.3 changes at most ~0.009 per sample; allow headroom for effects
  assert.ok(maxStep < 0.08, `largest sample step ${maxStep}`);
});

test('old presets without effects get safe defaults', () => {
  const fx = normalizeFx(undefined);
  assert.deepEqual(fx.enabled, { binaural: false, eq3: false, chorus: false, reverb: false });
  const partial = normalizeFx({ enabled: { reverb: true }, reverb: { decay: 12 } });
  assert.equal(partial.reverb.decay, 12);
  assert.equal(partial.reverb.mix, defaultFx().reverb.mix);
  assert.deepEqual(partial.order, ['eq3', 'chorus', 'reverb']);
});

test('all effects run much faster than real time', () => {
  const fx = allOn();
  const c = new FxChain(SR);
  c.setParams(fx);
  const L = noise(SR * 10, 1), R = noise(SR * 10, 2);
  const t0 = performance.now();
  c.process(L, R, L.length);
  const speed = 10000 / (performance.now() - t0);
  assert.ok(speed > 8, `${speed.toFixed(1)}x real time`);
  console.log(`effects speed: ${speed.toFixed(1)}x real time with everything on`);
});
