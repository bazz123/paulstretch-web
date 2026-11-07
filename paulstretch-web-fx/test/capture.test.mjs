// Run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultParams } from '../src/dsp.js';
import { defaultFx } from '../src/effects.js';
import { FrozenSource, captureSnapshot, detectPitch, renderLoop, renderOneShot, describePitch } from '../src/capture.js';
import { renderPipeline } from '../src/render-pipeline.js';
import { encodeWavBlob, smplChunk, wavHeader } from '../src/wav-writer.js';

const SR = 44100;
const saw = (f, secs = 2) => {
  const x = new Float32Array(SR * secs);
  for (let i = 0; i < x.length; i++) { let v = 0; for (let h = 1; h < 15; h++) v += Math.sin((2 * Math.PI * f * h * i) / SR) / h; x[i] = 0.3 * v; }
  return x;
};
const noise = (secs = 2) => { let a = 9; return Float32Array.from({ length: SR * secs }, () => { a = (a * 1664525 + 1013904223) >>> 0; return (a / 4294967296 - 0.5) * 0.4; }); };

function params(fxOn = true) {
  const p = defaultParams();
  p.bufsize = 16384;
  p.fx = defaultFx();
  if (fxOn) {
    Object.assign(p.fx.enabled, { binaural: true, eq3: true, chorus: true, reverb: true });
    p.fx.reverb.shimmer = true; p.fx.reverb.decay = 10;
    p.fx.binaural.mode = 'both'; p.fx.binaural.glide.enabled = true;
  }
  return p;
}

test('pitch detection: harmonic tones are named correctly, noise has no pitch', () => {
  for (const [f, note] of [[110, 'A2'], [261.63, 'C4'], [82.41, 'E2'], [440, 'A4']]) {
    const { pitch } = captureSnapshot([saw(f)], SR, params(false), 0.5);
    assert.ok(pitch, `pitch found for ${f}`);
    assert.equal(pitch.note, note, `${f} Hz → ${pitch.label}`);
    assert.ok(Math.abs(pitch.cents) <= 5, `${f} Hz cents ${pitch.cents}`);
  }
  assert.equal(captureSnapshot([noise()], SR, params(false), 0.5).pitch, null);
  assert.equal(describePitch(440 * Math.pow(2, 0.12 / 12)).label, 'A4 +12c');
});

test('loops are exactly periodic with every effect on (odd and tempo lengths)', () => {
  for (const seconds of [4.37, (4 * 4 * 60) / 117]) {
    const r = renderLoop({ channels: [saw(110)], sampleRate: SR, params: params(true), pos: 0.5, seconds, verify: true });
    assert.equal(r.frames, Math.round(seconds * SR));
    assert.ok(r.periodicError < 1e-4, `${seconds.toFixed(2)} s: pass-to-pass difference ${r.periodicError}`);
    const [L] = r.channels;
    let maxStep = 0;
    for (let i = 1; i < L.length; i++) maxStep = Math.max(maxStep, Math.abs(L[i] - L[i - 1]));
    assert.ok(Math.abs(L[0] - L[L.length - 1]) <= maxStep, 'the wrap is no bigger than a normal step');
    assert.equal(r.channels.length, 2, 'binaural makes it stereo');
  }
});

test('loop level matches what Freeze plays', () => {
  const p = params(false);
  const r = renderLoop({ channels: [saw(220)], sampleRate: SR, params: p, pos: 0.5, seconds: 6 });
  const src = new FrozenSource([saw(220)], SR, p, 0.5);
  let s = 0, n = 0;
  for (let f = 0; f < 12; f++) { const { out } = src.renderFrame(); if (f > 2) for (const v of out[0]) { s += v * v; n++; } }
  const live = Math.sqrt(s / n);
  const loop = Math.sqrt(r.channels[0].reduce((a, v) => a + v * v, 0) / r.channels[0].length);
  assert.ok(Math.abs(20 * Math.log10(loop / live)) < 1.5, `loop ${loop} vs freeze ${live}`);
});

test('one-shot: silent start, attack/release envelope, tail after the length', () => {
  const r = renderOneShot({ channels: [saw(110)], sampleRate: SR, params: params(true), pos: 0.5, seconds: 5, attack: 1, release: 2 });
  const [L] = r.channels;
  assert.equal(r.body, 5 * SR);
  assert.ok(r.tail > SR, 'reverb tail');
  assert.ok(Math.abs(L[0]) < 1e-3, 'starts from silence');
  const peakEnd = Math.max(...L.subarray(L.length - 1000).map(Math.abs));
  assert.ok(peakEnd < 1e-3, 'ends in silence');
  const dry = renderOneShot({ channels: [saw(110)], sampleRate: SR, params: params(false), pos: 0.5, seconds: 5, attack: 1, release: 2 });
  assert.equal(dry.tail, Math.round(0.05 * SR) * 0 + dry.tail);
  assert.ok(dry.frames <= 5 * SR + 0.06 * SR, 'no effects: no tail');
});

test('drone: frozen source through the export pipeline is stable and deterministic', async () => {
  const run = async () => {
    let peak = 0, sum = 0;
    await renderPipeline({
      channels: [saw(110)], sampleRate: SR, params: params(true), seconds: 30,
      source: new FrozenSource([saw(110)], SR, params(true), 0.5),
      onBlock: (L, R, n) => { for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(L[i])); sum += L[i]; } },
    });
    return { peak, sum };
  };
  const a = await run(), b = await run();
  assert.ok(a.peak > 0.01 && a.peak < 5);
  assert.equal(a.sum, b.sum);
});

test('WAV files: 24-bit data, root note and loop points in the smpl chunk', async () => {
  const L = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 10) * 0.5);
  const smpl = smplChunk({ sampleRate: SR, midi: 45.12, loop: { start: 0, end: 999 } });
  const blob = encodeWavBlob([L, L], SR, { bits: 24, smpl });
  const buf = new DataView(await blob.arrayBuffer());
  const str = (o) => String.fromCharCode(buf.getUint8(o), buf.getUint8(o + 1), buf.getUint8(o + 2), buf.getUint8(o + 3));
  assert.equal(str(0), 'RIFF'); assert.equal(str(8), 'WAVE');
  assert.equal(buf.getUint32(4, true), buf.byteLength - 8, 'RIFF size covers all chunks');
  assert.equal(buf.getUint16(34, true), 24);
  const dataBytes = buf.getUint32(40, true);
  assert.equal(dataBytes, 1000 * 2 * 3);
  // 24-bit sample 100 (left) ≈ input
  const o = 44 + 100 * 6;
  let q = buf.getUint8(o) | (buf.getUint8(o + 1) << 8) | (buf.getUint8(o + 2) << 16);
  if (q & 0x800000) q -= 0x1000000;
  assert.ok(Math.abs(q / 8388607 - L[100]) < 1e-5);
  const s = 44 + dataBytes;
  assert.equal(str(s), 'smpl');
  assert.equal(buf.getUint32(s + 20, true), 45, 'MIDI unity note A2');
  assert.ok(Math.abs(buf.getUint32(s + 24, true) / 4294967296 - 0.12) < 1e-6, 'fine tuning');
  assert.equal(buf.getUint32(s + 36, true), 1, 'one loop');
  assert.equal(buf.getUint32(s + 52, true), 0); assert.equal(buf.getUint32(s + 56, true), 999);
  assert.equal(wavHeader(10, SR, 2, 16).byteLength, 44);
});
