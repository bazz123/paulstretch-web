// Export worker: renders with the same engine and effects as live playback.
// - 'render': the normal export, streamed to the browser's private file
//   storage (OPFS) so a 3-hour file needs only a few MB of memory.
// - 'capture': a captured moment as a one-shot or seamless loop (returned
//   whole, for Listen and download) or as a long drone (streamed like 'render').
// One worker per job; the page cancels by terminating it.
import { renderPipeline, maxExportFrames } from './render-pipeline.js';
import { FrozenSource, renderLoop, renderOneShot, captureSnapshot } from './capture.js';
import { wavHeader, smplChunk, PcmEncoder, encodeWavBlob } from './wav-writer.js';

const WAV_LIMIT = 0xffffffff - 64;
const yieldFn = () => new Promise((r) => setTimeout(r, 0));

async function openSink(name) {
  try {
    const root = await navigator.storage.getDirectory();
    try {
      for await (const [entry] of root.entries()) {
        if (entry.startsWith('export-') && entry !== name) await root.removeEntry(entry).catch(() => {});
      }
    } catch { /* listing not supported: old files stay until overwritten */ }
    const fh = await root.getFileHandle(name, { create: true });
    const h = await fh.createSyncAccessHandle();
    h.truncate(0);
    let at = 44;
    return {
      kind: 'opfs',
      write(u8) { h.write(u8, { at }); at += u8.byteLength; },
      finish(header, trailer) {
        if (trailer) { h.write(trailer, { at }); at += trailer.byteLength; }
        h.write(header, { at: 0 }); h.flush(); h.close();
        return null;
      },
    };
  } catch {
    const parts = [];
    return {
      kind: 'blob',
      write(u8) { parts.push(new Blob([u8.slice()])); },
      finish(header, trailer) { return new Blob([header, ...parts, ...(trailer ? [trailer] : [])], { type: 'audio/wav' }); },
    };
  }
}

// Streams a pipeline (engine or frozen source) to a WAV file, optionally in two passes for normalise.
async function streamWav({ id, name, pipe, sampleRate, seconds, normalize, volume, bits = 16, midi = null }) {
  const passes = normalize ? 2 : 1;
  let gain = volume;
  if (normalize) {
    postMessage({ type: 'phase', id, phase: 'measure' });
    const stats = await renderPipeline({
      ...pipe(), seconds, gain: 1, onBlock: () => {},
      onProgress: (d, t) => postMessage({ type: 'progress', id, progress: (d / t) / passes }), yieldFn,
    });
    gain = stats.peak > 1e-9 ? Math.pow(10, -1 / 20) / stats.peak : 1;
  }
  postMessage({ type: 'phase', id, phase: 'write' });
  const sink = await openSink(name);
  const enc = new PcmEncoder(bits, 2);
  const lr = [null, null];
  const stats = await renderPipeline({
    ...pipe(), seconds, gain,
    onBlock: (L, R, n) => { lr[0] = L; lr[1] = R; sink.write(enc.encode(lr, n)); },
    onProgress: (d, t) => postMessage({ type: 'progress', id, progress: (passes - 1 + d / t) / passes }), yieldFn,
  });
  const dataBytes = stats.frames * 2 * (bits / 8);
  let trailer = null;
  if (midi !== null) {
    const smpl = smplChunk({ sampleRate, midi });
    trailer = new Uint8Array(smpl.byteLength + (dataBytes & 1));
    trailer.set(smpl, dataBytes & 1);
  }
  const blob = sink.finish(wavHeader(stats.frames, sampleRate, 2, bits, trailer ? trailer.byteLength - (dataBytes & 1) : 0), trailer);
  return { kind: sink.kind, name, blob, stats, clipped: !normalize && stats.peak > 1 };
}

async function doRender(m) {
  const { id, channels, sampleRate: sr, params, seconds, normalize } = m;
  if (maxExportFrames(params, seconds, sr) * 4 > WAV_LIMIT) {
    throw new Error('This length is over the 4 GB WAV limit at this sample rate. Choose a shorter length.');
  }
  const r = await streamWav({
    id, name: `export-${id}.wav`, sampleRate: sr, seconds, normalize, volume: Math.pow(10, params.volumeDb / 20),
    pipe: () => ({ channels, sampleRate: sr, params }),
  });
  postMessage({
    type: 'done', id, kind: r.kind, name: r.name, blob: r.blob,
    seconds: r.stats.frames / sr, bodySeconds: r.stats.body / sr, tailSeconds: r.stats.tail / sr, clipped: r.clipped,
  });
}

async function doCapture(m) {
  const { id, channels, sampleRate: sr, params: p0, pos, kind, opts } = m;
  const params = opts.includeFx ? p0 : { ...p0, fx: { ...p0.fx, enabled: { binaural: false, eq3: false, chorus: false, reverb: false } } };
  const volume = Math.pow(10, params.volumeDb / 20);
  const { pitch } = captureSnapshot(channels, sr, params, pos);
  const midi = pitch ? pitch.midi : 60;

  if (kind === 'drone') {
    const frames = maxExportFrames(params, opts.seconds, sr);
    if (frames * 2 * (opts.bits / 8) > WAV_LIMIT) throw new Error('This length is over the 4 GB WAV limit at this bit depth. Choose a shorter length or 16-bit.');
    const r = await streamWav({
      id, name: `export-${id}.wav`, sampleRate: sr, seconds: opts.seconds, normalize: opts.normalize, volume, bits: opts.bits, midi,
      pipe: () => ({ channels, sampleRate: sr, params, source: new FrozenSource(channels, sr, params, pos) }),
    });
    postMessage({
      type: 'capture-done', id, kind, fileKind: r.kind, name: r.name, blob: r.blob, pitch,
      seconds: r.stats.frames / sr, bodySeconds: r.stats.body / sr, tailSeconds: r.stats.tail / sr, clipped: r.clipped,
    });
    return;
  }

  postMessage({ type: 'phase', id, phase: 'write' });
  postMessage({ type: 'progress', id, progress: 0.1 });
  const common = { channels, sampleRate: sr, params, pos, seconds: opts.seconds, includeFx: opts.includeFx, normalize: opts.normalize, gain: volume };
  const r = kind === 'loop' ? renderLoop(common) : renderOneShot({ ...common, attack: opts.attack, release: opts.release });
  postMessage({ type: 'progress', id, progress: 0.9 });
  const smpl = smplChunk({ sampleRate: sr, midi, loop: kind === 'loop' ? { start: r.loopStart, end: r.loopEnd } : null });
  const blob = encodeWavBlob(r.channels, sr, { bits: opts.bits, smpl });
  postMessage({
    type: 'capture-done', id, kind, fileKind: 'blob', blob, pitch, preview: r.channels, sampleRate: sr,
    seconds: r.frames / sr, bodySeconds: (r.body ?? r.frames) / sr, tailSeconds: (r.tail ?? 0) / sr,
    clipped: !opts.normalize && r.peak > 1,
  }, r.channels.map((c) => c.buffer));
}

onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'render') await doRender(m);
    else if (m.type === 'capture') await doCapture(m);
  } catch (err) {
    postMessage({ type: 'error', id: m.id, message: String((err && err.message) || err) });
  }
};
