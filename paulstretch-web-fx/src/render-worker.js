// Export worker: renders with the same engine and effects as live playback and
// streams 16-bit WAV straight to the browser's private file storage (OPFS), so
// a 3-hour export needs only a few MB of memory. One worker per export; the
// page cancels by terminating it.
import { renderPipeline, maxExportFrames } from './render-pipeline.js';

const WAV_LIMIT = 0xffffffff - 64;
const yieldFn = () => new Promise((r) => setTimeout(r, 0));

function wavHeader(frames, sr, nch = 2) {
  const bytes = frames * nch * 2;
  const v = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, bytes, true);
  return new Uint8Array(v.buffer);
}

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
      finish(header) { h.write(header, { at: 0 }); h.flush(); h.close(); return null; },
    };
  } catch {
    // Fallback: keep chunks as Blobs (the browser may page them to disk).
    const parts = [];
    return {
      kind: 'blob',
      write(u8) { parts.push(new Blob([u8.slice()])); },
      finish(header) { return new Blob([header, ...parts], { type: 'audio/wav' }); },
    };
  }
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type !== 'render') return;
  const { id, channels, sampleRate: sr, params, seconds, normalize } = m;
  try {
    if (maxExportFrames(params, seconds, sr) * 4 > WAV_LIMIT) {
      throw new Error('This length is over the 4 GB WAV limit at this sample rate. Choose a shorter length.');
    }
    const volume = Math.pow(10, params.volumeDb / 20);
    const passes = normalize ? 2 : 1;
    let gain = volume;

    if (normalize) {
      postMessage({ type: 'phase', id, phase: 'measure' });
      const stats = await renderPipeline({
        channels, sampleRate: sr, params, seconds, gain: 1,
        onBlock: () => {},
        onProgress: (d, t) => postMessage({ type: 'progress', id, progress: (d / t) / passes }),
        yieldFn,
      });
      gain = stats.peak > 1e-9 ? Math.pow(10, -1 / 20) / stats.peak : 1;
    }

    postMessage({ type: 'phase', id, phase: 'write' });
    const name = `export-${id}.wav`;
    const sink = await openSink(name);
    let pcm = new Int16Array(16384);
    const stats = await renderPipeline({
      channels, sampleRate: sr, params, seconds, gain,
      onBlock: (L, R, n) => {
        if (pcm.length < n * 2) pcm = new Int16Array(n * 2);
        for (let i = 0; i < n; i++) {
          let l = L[i] + (Math.random() - Math.random()) / 32768;
          let r = R[i] + (Math.random() - Math.random()) / 32768;
          l = l < -1 ? -1 : l > 1 ? 1 : l;
          r = r < -1 ? -1 : r > 1 ? 1 : r;
          pcm[2 * i] = Math.round(l * 32767);
          pcm[2 * i + 1] = Math.round(r * 32767);
        }
        sink.write(new Uint8Array(pcm.buffer, 0, n * 4));
      },
      onProgress: (d, t) => postMessage({ type: 'progress', id, progress: (passes - 1 + d / t) / passes }),
      yieldFn,
    });
    const blob = sink.finish(wavHeader(stats.frames, sr));
    postMessage({
      type: 'done', id, kind: sink.kind, name, blob,
      seconds: stats.frames / sr, bodySeconds: stats.body / sr, tailSeconds: stats.tail / sr,
      clipped: !normalize && stats.peak > 1,
    });
  } catch (err) {
    postMessage({ type: 'error', id, message: String((err && err.message) || err) });
  }
};
