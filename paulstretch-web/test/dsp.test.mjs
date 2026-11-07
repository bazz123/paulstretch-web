// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RealFFT, Engine, defaultParams, Stretcher, MODULES } from '../src/dsp.js';

function naiveMag(x) {
  const n = x.length, out = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) { re += x[i] * Math.cos((2 * Math.PI * k * i) / n); im -= x[i] * Math.sin((2 * Math.PI * k * i) / n); }
    out[k] = Math.hypot(re, im);
  }
  return out;
}

test('forward magnitudes match a naive DFT', () => {
  const n = 64, x = new Float32Array(n).map(() => Math.random() * 2 - 1);
  const fft = new RealFFT(n), mag = new Float32Array(n / 2);
  fft.forwardMag(x, mag);
  const ref = naiveMag(x);
  for (let k = 0; k < n / 2; k++) assert.ok(Math.abs(mag[k] - ref[k]) < 1e-3, `bin ${k}: ${mag[k]} vs ${ref[k]}`);
});

test('random-phase inverse keeps the magnitudes (round trip)', () => {
  const n = 256, fft = new RealFFT(n);
  const mag = new Float32Array(n / 2).map((_, k) => (k === 0 ? 0 : Math.random()));
  const out = new Float32Array(n);
  fft.inverseRandomPhase(mag, Math.random, out);
  const back = new Float32Array(n / 2);
  fft.forwardMag(out, back);
  for (let k = 1; k < n / 2; k++) assert.ok(Math.abs(back[k] - mag[k]) < 1e-4, `bin ${k}`);
});

function sine(sr, secs, f) {
  const x = new Float32Array(Math.floor(sr * secs));
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * f * i) / sr);
  return x;
}

function renderAll(engine, maxFrames = 100000) {
  const chunks = [];
  let frames = 0;
  while (!engine.finished && frames++ < maxFrames) chunks.push(Float32Array.from(engine.renderFrame().out[0]));
  return chunks;
}

test('output length is about input length x stretch', () => {
  const sr = 44100;
  for (const stretch of [0.5, 1, 4, 10]) {
    const p = { ...defaultParams(), stretch, bufsize: 1024, loop: false };
    const e = new Engine([sine(sr, 2, 440)], sr, p);
    const outLen = renderAll(e).length * 1024;
    const expected = 2 * sr * stretch;
    assert.ok(Math.abs(outLen - expected) / expected < 0.15, `stretch ${stretch}: ${outLen} vs ${expected}`);
  }
});

test('a stretched sine keeps its level and pitch', () => {
  const sr = 44100;
  const p = { ...defaultParams(), stretch: 8, bufsize: 4096, loop: true };
  const e = new Engine([sine(sr, 1, 440)], sr, p);
  for (let i = 0; i < 4; i++) e.renderFrame();
  const chunk = Float32Array.from({ length: 16384 }, () => 0);
  for (let f = 0; f < 4; f++) chunk.set(e.renderFrame().out[0], f * 4096);
  const rms = Math.sqrt(chunk.reduce((a, v) => a + v * v, 0) / chunk.length);
  const inRms = 0.5 / Math.SQRT2;
  assert.ok(rms > inRms * 0.5 && rms < inRms * 2, `rms ${rms}`);
  const fft = new RealFFT(16384), mag = new Float32Array(8192);
  fft.forwardMag(chunk, mag);
  let peak = 0;
  for (let k = 1; k < 8192; k++) if (mag[k] > mag[peak]) peak = k;
  const hz = (peak * sr) / 16384;
  assert.ok(Math.abs(hz - 440) < 10, `peak at ${hz} Hz`);
});

test('pitch shift +12 semitones moves the peak an octave up', () => {
  const sr = 44100;
  const p = { ...defaultParams(), stretch: 4, bufsize: 4096 };
  p.pitchShift = { semitones: 12 };
  const e = new Engine([sine(sr, 1, 440)], sr, p);
  for (let i = 0; i < 3; i++) e.renderFrame();
  const out = e.renderFrame().out[0];
  const fft = new RealFFT(4096), mag = new Float32Array(2048);
  fft.forwardMag(out, mag);
  let peak = 0;
  for (let k = 1; k < 2048; k++) if (mag[k] > mag[peak]) peak = k;
  assert.ok(Math.abs((peak * sr) / 4096 - 880) < 25, `peak ${(peak * sr) / 4096}`);
});

test('every spectral module runs and produces finite output', () => {
  const sr = 48000;
  const p = defaultParams();
  p.bufsize = 2048;
  for (const m of MODULES) p.enabled[m] = true;
  p.spread.amount = 0.5; p.compressor.amount = 0.5; p.ratioMix.levels = [0.3, 0.3, 1, 0.3, 0.2, 0.1, 0.2, 0.2];
  p.tonalNoise.preserve = -0.5; p.harmonics.gauss = true; p.freqShift.hz = 100;
  const e = new Engine([sine(sr, 1, 220), sine(sr, 1, 330)], sr, p);
  for (let i = 0; i < 10; i++) {
    const { out } = e.renderFrame();
    for (const ch of out) for (const v of ch) assert.ok(Number.isFinite(v));
  }
});

test('freeze stops the read position', () => {
  const sr = 44100;
  const p = { ...defaultParams(), stretch: 1, bufsize: 1024 };
  const e = new Engine([sine(sr, 2, 440)], sr, p);
  e.renderFrame(); e.renderFrame();
  e.setParams({ freeze: true });
  const pos = e.pos;
  for (let i = 0; i < 20; i++) e.renderFrame();
  assert.equal(e.pos, pos);
});

test('Stretcher handles large buffers quickly', () => {
  const s = new Stretcher(65536, 44100, 1);
  const x = new Float32Array(131072).map(() => Math.random() - 0.5);
  const t0 = performance.now();
  s.process(x, 131072, defaultParams());
  for (let i = 0; i < 4; i++) s.process(x, 0, defaultParams());
  const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 200, `${ms.toFixed(1)} ms per frame`);
});

test('every built-in preset renders finite, non-silent audio', async () => {
  const { PRESETS, applySettings } = await import('../src/presets.js');
  const sr = 44100;
  for (const p of PRESETS) {
    const params = defaultParams();
    applySettings(params, p.settings);
    params.bufsize = Math.min(params.bufsize, 8192); // keep the test fast
    const e = new Engine([sine(sr, 1, 220)], sr, params);
    let energy = 0;
    for (let i = 0; i < 6; i++) for (const v of e.renderFrame().out[0]) { assert.ok(Number.isFinite(v), p.name); energy += v * v; }
    assert.ok(energy > 0, `${p.name} is silent`);
  }
});
