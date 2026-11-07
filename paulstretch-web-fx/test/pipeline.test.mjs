// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, defaultParams, drawEqCurve, Stretcher } from '../src/dsp.js';
import { FxChain, defaultFx } from '../src/effects.js';
import { renderPipeline, END_FADE_SECONDS } from '../src/render-pipeline.js';
import { PRESETS, applySettings, snapshot } from '../src/presets.js';

const SR = 44100;
const tone = (secs) => {
  const x = new Float32Array(Math.floor(SR * secs));
  for (let i = 0; i < x.length; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR) * (1 + 0.5 * Math.sin(i / 3000));
  return x;
};

function fullParams(fxOverride) {
  const p = defaultParams();
  p.bufsize = 4096;
  p.fx = defaultFx();
  Object.assign(p.fx.enabled, { binaural: true, eq3: true, chorus: true, reverb: true });
  p.fx.reverb.shimmer = true;
  p.fx.binaural.glide.enabled = true;
  p.fx.binaural.glide.duration = 5;
  if (fxOverride) fxOverride(p.fx);
  return p;
}

async function collect(opts) {
  const L = [], R = [];
  const stats = await renderPipeline({ ...opts, onBlock: (l, r, n) => { L.push(Float32Array.from(l.subarray(0, n))); R.push(Float32Array.from(r.subarray(0, n))); } });
  const cat = (parts) => { const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  return { stats, L: cat(L), R: cat(R) };
}

test('export is deterministic, so two-pass normalise sees the same audio', async () => {
  const params = fullParams();
  const a = await collect({ channels: [tone(2)], sampleRate: SR, params, seconds: 6 });
  const b = await collect({ channels: [tone(2)], sampleRate: SR, params, seconds: 6 });
  assert.equal(a.L.length, b.L.length);
  for (let i = 0; i < a.L.length; i++) assert.equal(a.L[i], b.L[i]);
  // volume after effects: gain scales the output exactly
  const c = await collect({ channels: [tone(2)], sampleRate: SR, params, seconds: 6, gain: 0.5 });
  for (let i = 0; i < a.L.length; i += 97) assert.ok(Math.abs(c.L[i] - a.L[i] * 0.5) < 1e-6);
});

test('export matches live playback processing (128-sample blocks)', async () => {
  const params = fullParams();
  const seconds = 8;
  const exp = await collect({ channels: [tone(3)], sampleRate: SR, params, seconds });
  // live: engine frames, then the effects in 128-sample worklet quanta
  const eng = new Engine([tone(3)], SR, { ...params });
  const fx = new FxChain(SR, 128);
  fx.setParams(params.fx);
  for (const k of Object.keys(fx.en)) fx.en[k].jump(1);
  const compareTo = Math.floor((seconds - END_FADE_SECONDS) * SR) - 1;
  const live = new Float32Array(compareTo + 8192);
  let w = 0;
  while (w < compareTo) {
    const { out } = eng.renderFrame();
    const L = Float32Array.from(out[0]), R = Float32Array.from(out[1] || out[0]);
    for (let o = 0; o < L.length; o += 128) fx.process(L.subarray(o, o + 128), R.subarray(o, o + 128), Math.min(128, L.length - o), true);
    live.set(L.subarray(0, Math.min(L.length, live.length - w)), w);
    w += L.length;
  }
  let maxd = 0;
  for (let i = 0; i < compareTo; i++) maxd = Math.max(maxd, Math.abs(live[i] - exp.L[i]));
  assert.ok(maxd < 1e-5, `max difference ${maxd}`);
});

test('reverb tail rings out after the length and ends in silence', async () => {
  const params = fullParams((fx) => { fx.reverb.decay = 2; fx.reverb.shimmer = false; });
  const { stats, L } = await collect({ channels: [tone(2)], sampleRate: SR, params, seconds: 5 });
  assert.equal(stats.body, 5 * SR);
  assert.ok(stats.tail > SR * 1.0, `tail ${stats.tail / SR} s`);
  const end = L.subarray(L.length - 2048);
  assert.ok(Math.max(...end.map(Math.abs)) < 1e-3, 'ends quietly');
  // no cut at the boundary between body and tail
  const k = stats.body;
  assert.ok(Math.abs(L[k] - L[k - 1]) < 0.05);
});

test('no effects means no tail and an exact length', async () => {
  const params = defaultParams();
  params.bufsize = 4096;
  params.fx = defaultFx();
  const { stats } = await collect({ channels: [tone(1)], sampleRate: SR, params, seconds: 3 });
  assert.equal(stats.tail, 0);
  assert.equal(stats.frames, 3 * SR);
});

test('long export keeps memory flat (10 minutes, all effects)', async () => {
  const params = fullParams();
  params.bufsize = 16384;
  let frames = 0;
  const heap = [];
  const t0 = performance.now();
  await renderPipeline({
    channels: [tone(5), tone(5)], sampleRate: SR, params, seconds: 600,
    onBlock: (l, r, n) => { frames += n; if (frames % (SR * 60) < n) heap.push(process.memoryUsage().heapUsed); },
  });
  const secs = (performance.now() - t0) / 1000;
  const speed = 600 / secs;
  const growth = (heap[heap.length - 1] - heap[1]) / 1048576;
  console.log(`10 min export: ${secs.toFixed(1)} s (${speed.toFixed(1)}x real time), heap growth ${growth.toFixed(1)} MB; 3 h estimate ${(10800 / speed / 60).toFixed(1)} min per pass`);
  assert.ok(growth < 20, `heap grew ${growth} MB`);
  assert.ok(frames >= 600 * SR);
});

test('spectral EQ curve: interpolation and processing', () => {
  const one = drawEqCurve([{ f: 1000, db: -12 }]);
  assert.equal(one(50), -12); assert.equal(one(15000), -12);
  const c = drawEqCurve([{ f: 100, db: 0 }, { f: 1000, db: -24 }, { f: 10000, db: 6 }]);
  assert.equal(c(20), 0); assert.equal(c(20000), 6);
  assert.ok(Math.abs(c(1000) + 24) < 1e-9);
  for (let f = 100; f < 1000; f *= 1.05) assert.ok(c(f) <= 0.001 && c(f) >= -24.001, 'no overshoot');
  // processing: a -24 dB flat curve lowers the output by about 24 dB
  const p = defaultParams();
  p.enabled.drawEq = true; p.drawEq = { points: [{ f: 1000, db: -24 }] };
  const x = tone(1);
  const s1 = new Stretcher(4096, SR, 1), s2 = new Stretcher(4096, SR, 1);
  s1.process(x, 8192, defaultParams()); s2.process(x, 8192, p);
  for (let i = 0; i < 3; i++) { s1.process(x, 0, defaultParams()); s2.process(x, 0, p); }
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const db = 20 * Math.log10(rms(s2.out) / rms(s1.out));
  assert.ok(Math.abs(db + 24) < 1, `${db.toFixed(2)} dB`);
});

test('presets: v1 saved presets load with effects off; v2 round-trips everything', () => {
  const v1 = { stretch: 12, bufsize: 8192, windowType: 'hann', onset: 0, freeze: false, order: defaultParams().order, enabled: { spread: true }, spread: { amount: 0.4 } };
  const params = defaultParams();
  params.fx = defaultFx();
  params.fx.enabled.reverb = true;
  applySettings(params, v1);
  assert.equal(params.stretch, 12);
  assert.equal(params.fx.enabled.reverb, false);
  assert.deepEqual(params.drawEq, { points: [] });
  const ambient = PRESETS.find((p) => p.id === 'pad');
  applySettings(params, ambient.settings);
  assert.equal(params.fx.reverb.shimmer, true);
  const again = defaultParams();
  applySettings(again, JSON.parse(JSON.stringify(snapshot(params))));
  assert.deepEqual(again.fx, params.fx);
  assert.ok(PRESETS.some((p) => p.name === 'Binaural Atmosphere' && p.settings.fx.binaural.glide.enabled));
});

test('binaural forces stereo even for mono input with Mono → wide stereo off', async () => {
  const params = defaultParams();
  params.bufsize = 4096;
  params.monoToStereo = false;
  params.fx = defaultFx();
  const plain = await collect({ channels: [tone(2)], sampleRate: SR, params, seconds: 4 });
  for (let i = 0; i < plain.L.length; i += 53) assert.equal(plain.L[i], plain.R[i], 'mono stays identical without binaural');
  params.fx.enabled.binaural = true;
  params.fx.binaural.beat = 6;
  const bin = await collect({ channels: [tone(2)], sampleRate: SR, params, seconds: 4 });
  let diff = 0;
  for (let i = SR; i < 3 * SR; i++) diff += Math.abs(bin.L[i] - bin.R[i]);
  assert.ok(diff / (2 * SR) > 0.01, 'left and right differ');
});
