// AudioWorklet: plays the frames the worker sends and runs the shared effects
// chain (effects.js) on them, so effect changes are heard immediately.
import { FxChain } from './effects.js';

const FADE = 256;

class StretchPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];        // { data: Float32Array[], pos, offset }
    this.consumed = 0;
    this.fadeOut = 0;
    this.flushing = false;
    this.workerPort = null;
    this.playing = false;
    this.fx = new FxChain(sampleRate, 128);
    this.fx.units.binaural.gate.jump(0); // generated tones only while playing
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'port') {
        this.workerPort = m.port;
        this.workerPort.onmessage = (ev) => this.onWorker(ev.data);
      } else if (m.type === 'fx') {
        this.fx.setParams(m.fx);
      } else if (m.type === 'play') {
        this.playing = true;
        this.fx.resetTimeline();   // binaural glide starts from the beginning
        this.fx.setToneGate(1);
      } else if (m.type === 'stop') {
        this.playing = false;      // effects keep running so tails ring out
        this.fx.setToneGate(0);    // but generated binaural tones stop with the music
      }
    };
  }

  onWorker(m) {
    if (m.type === 'chunk') {
      this.queue.push({ data: m.data, pos: m.pos, offset: 0, announced: false });
    } else if (m.type === 'flush') {
      if (this.queue.length) {
        this.queue = [this.queue[0]];
        this.fadeOut = FADE;
        this.flushing = true;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1];
    const n = L.length;
    let i = 0;
    while (i < n && this.queue.length) {
      const c = this.queue[0];
      if (!c.announced && !this.flushing) {
        c.announced = true;
        this.port.postMessage({ type: 'pos', pos: c.pos });
      }
      const d0 = c.data[0], d1 = c.data[1] || c.data[0];
      while (i < n && c.offset < d0.length) {
        let g = 1;
        if (this.flushing) {
          if (this.fadeOut <= 0) break;
          g = this.fadeOut / FADE;
          this.fadeOut--;
        }
        L[i] = d0[c.offset] * g;
        if (R) R[i] = d1[c.offset] * g;
        c.offset++;
        i++;
        if (!this.flushing) this.consumed++;
      }
      if (this.flushing && this.fadeOut <= 0) {
        this.queue.shift();
        this.flushing = false;
      } else if (c.offset >= d0.length) {
        this.queue.shift();
        if (this.flushing) this.flushing = false;
      }
    }
    for (; i < n; i++) { L[i] = 0; if (R) R[i] = 0; }
    if (R && this.fx.anyActive) this.fx.process(L, R, n, this.playing);
    if (this.consumed >= 1024 && this.workerPort) {
      this.workerPort.postMessage({ type: 'consumed', n: this.consumed });
      this.consumed = 0;
    }
    return true;
  }
}

registerProcessor('stretch-player', StretchPlayer);
