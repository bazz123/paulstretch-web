// Background thread: runs the stretch engine ahead of playback and streams
// frames to the AudioWorklet through a MessagePort (the web equivalent of
// PaulXStretch's prebuffering TimeSliceThread). Exports run in render-worker.js.
import { Engine, defaultParams } from './dsp.js';

let input = null;      // { channels, sampleRate }
let params = defaultParams();
let engine = null;
let port = null;       // MessagePort to the worklet
let playing = false;
let queued = 0;        // samples sent to the worklet and not yet played
let pumpScheduled = false;

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
  }
};
