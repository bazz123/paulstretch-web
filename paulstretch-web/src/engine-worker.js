// Background thread: runs the stretch engine ahead of playback and streams
// frames to the AudioWorklet through a MessagePort (the web equivalent of
// PaulXStretch's prebuffering TimeSliceThread). Also does offline renders.
import { Engine, defaultParams } from './dsp.js';

let input = null;      // { channels, sampleRate }
let params = defaultParams();
let engine = null;
let port = null;       // MessagePort to the worklet
let playing = false;
let queued = 0;        // samples sent to the worklet and not yet played
let pumpScheduled = false;
let renderJob = 0;

const target = () => params.bufsize + Math.floor((input?.sampleRate || 48000) * 0.4);

function schedulePump() {
  if (pumpScheduled) return;
  pumpScheduled = true;
  setTimeout(pump, 0);
}

function pump() {
  pumpScheduled = false;
  if (!playing || !engine || !port) return;
  if (queued >= target()) return;
  if (engine.finished) {
    playing = false;
    postMessage({ type: 'ended' });
    return;
  }
  const { out, inPos } = engine.renderFrame();
  const data = out.map((ch) => Float32Array.from(ch));
  queued += data[0].length;
  port.postMessage({ type: 'chunk', data, pos: inPos }, data.map((d) => d.buffer));
  schedulePump(); // yield between frames so messages (params, seek) get through
}

function flush() {
  port?.postMessage({ type: 'flush' });
  queued = 0;
}

function onPortMessage(e) {
  const m = e.data;
  if (m.type === 'consumed') {
    queued = Math.max(0, queued - m.n);
    schedulePump();
  }
}

function renderOffline({ seconds, params: p, id }) {
  const job = ++renderJob;
  const sr = input.sampleRate;
  const total = Math.floor(seconds * sr);
  const eng = new Engine(input.channels, sr, { ...p, loop: p.loop, freeze: false });
  const nch = eng.numOut;
  const outs = Array.from({ length: nch }, () => new Float32Array(total));
  const gain = Math.pow(10, p.volumeDb / 20);
  let written = 0;
  let lastReport = 0;
  const step = () => {
    if (job !== renderJob) return; // cancelled
    const t0 = performance.now();
    while (written < total && performance.now() - t0 < 50) {
      if (eng.finished) break;
      const { out } = eng.renderFrame();
      const n = Math.min(out[0].length, total - written);
      for (let c = 0; c < nch; c++) {
        const src = out[c], dst = outs[c];
        for (let i = 0; i < n; i++) dst[written + i] = src[i] * gain;
      }
      written += n;
    }
    if (written >= total || eng.finished) {
      const result = outs.map((o) => o.slice(0, written));
      postMessage({ type: 'render-done', id, channels: result, sampleRate: sr }, result.map((r) => r.buffer));
      return;
    }
    if (written - lastReport > sr) {
      lastReport = written;
      postMessage({ type: 'render-progress', id, progress: written / total });
    }
    setTimeout(step, 0);
  };
  step();
}

onmessage = (e) => {
  const m = e.data;
  switch (m.type) {
    case 'port':
      port = m.port;
      port.onmessage = onPortMessage;
      break;
    case 'load':
      input = { channels: m.channels, sampleRate: m.sampleRate };
      engine = new Engine(input.channels, input.sampleRate, params);
      flush();
      break;
    case 'params': {
      params = { ...params, ...m.params };
      if (engine) {
        const reinit = engine.setParams(params);
        if (reinit) flush();
      }
      schedulePump();
      break;
    }
    case 'seek':
      if (engine) {
        engine.seek(m.frac);
        flush();
        schedulePump();
      }
      break;
    case 'play':
      if (engine?.finished) engine.seek(params.start);
      playing = true;
      schedulePump();
      break;
    case 'stop':
      playing = false;
      flush();
      break;
    case 'render':
      if (input) renderOffline(m);
      break;
    case 'cancel-render':
      renderJob++;
      break;
  }
};
