// Offline render pipeline: stretch engine → effects chain → volume, streamed
// block by block. Used by the export worker; plain JS so it can be tested in Node.
// Memory use is bounded by one stretch frame, whatever the export length.
import { Engine } from './dsp.js';
import { FxChain } from './effects.js';

export const END_FADE_SECONDS = 3;
const TAIL_SILENCE = 1e-5;          // about -100 dBFS
const TAIL_QUIET_SECONDS = 0.5;

// Calls onBlock(L, R, n) with consecutive stereo blocks. Returns stats.
// gain is the master volume, applied after the effects. The last few seconds of
// the stretched audio fade out before the effects, so tails end naturally.
// source: optional replacement for the stretch engine (e.g. a FrozenSource).
export async function renderPipeline({ channels, sampleRate, params, seconds, gain = 1, onBlock, onProgress, yieldFn, source }) {
  const sr = sampleRate;
  const total = Math.max(1, Math.round(seconds * sr));
  const eng = source || new Engine(channels, sr, { ...params });
  const fx = new FxChain(sr, 8192);
  fx.setParams(params.fx);
  // effects start in their final state, exactly as configured
  for (const k of Object.keys(fx.en)) fx.en[k].jump(params.fx && params.fx.enabled && params.fx.enabled[k] ? 1 : 0);

  const maxFrame = Math.max(params.bufsize || 16384, 8192);
  const L = new Float32Array(maxFrame), R = new Float32Array(maxFrame);
  const fadeLen = Math.min(Math.round(END_FADE_SECONDS * sr), Math.floor(total * 0.25));
  let written = 0, peak = 0, lastYield = Date.now();

  // master volume comes last, after the effects (same order as live playback)
  const emit = (n) => {
    if (gain !== 1) for (let i = 0; i < n; i++) { L[i] *= gain; R[i] *= gain; }
    for (let i = 0; i < n; i++) {
      const a = Math.abs(L[i]), b = Math.abs(R[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    onBlock(L, R, n);
  };

  const maybeYield = async () => {
    if (Date.now() - lastYield > 50) {
      lastYield = Date.now();
      if (onProgress) onProgress(written, total);
      if (yieldFn) await yieldFn();
    }
  };

  // main body
  while (written < total && !eng.finished) {
    const { out } = eng.renderFrame();
    const n = Math.min(out[0].length, total - written);
    const o1 = out[1] || out[0];
    for (let i = 0; i < n; i++) {
      const pos = written + i;
      let g = 1;
      if (fadeLen > 0 && pos >= total - fadeLen) g = (total - pos) / fadeLen;
      L[i] = out[0][i] * g;
      R[i] = o1[i] * g;
    }
    // effects in sub-blocks so the binaural tones follow the end fade
    for (let o = 0; o < n; o += 1024) {
      const k = Math.min(1024, n - o), pos = written + o;
      fx.setToneGate(fadeLen > 0 && pos >= total - fadeLen ? (total - pos) / fadeLen : 1);
      fx.process(L.subarray(o, o + k), R.subarray(o, o + k), k, true);
    }
    emit(n);
    written += n;
    await maybeYield();
  }
  const body = written;
  fx.setToneGate(0);

  // tail: let reverb/chorus ring out on silence
  let tail = 0;
  const maxTail = Math.round(fx.tailSeconds() * sr);
  if (maxTail > 0) {
    let quiet = 0;
    const block = Math.min(4096, maxFrame);
    while (tail < maxTail) {
      const n = Math.min(block, maxTail - tail);
      L.fill(0, 0, n); R.fill(0, 0, n);
      fx.process(L, R, n, true);
      let bp = 0;
      for (let i = 0; i < n; i++) bp = Math.max(bp, Math.abs(L[i]), Math.abs(R[i]));
      emit(n);
      tail += n;
      written += n;
      quiet = bp < TAIL_SILENCE ? quiet + n : 0;
      if (quiet >= TAIL_QUIET_SECONDS * sr && tail > 0.2 * sr) break;
      await maybeYield();
    }
  }
  if (onProgress) onProgress(total, total);
  return { frames: written, body, tail, peak };
}

// Upper bound on the frames an export can produce, for the 4 GB WAV limit.
export function maxExportFrames(params, seconds, sampleRate) {
  const fx = new FxChain(sampleRate);
  fx.setParams(params.fx);
  return Math.round((seconds + fx.tailSeconds()) * sampleRate);
}
