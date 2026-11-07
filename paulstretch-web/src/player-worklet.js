// AudioWorklet: plays the frames the worker sends. Never computes DSP itself,
// so the audio thread stays light even with huge FFT windows.
const FADE = 256;

class StretchPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];        // { data: Float32Array[], pos, offset }
    this.consumed = 0;
    this.fadeOut = 0;       // samples left in a flush fade-out
    this.workerPort = null;
    this.port.onmessage = (e) => {
      if (e.data.type === 'port') {
        this.workerPort = e.data.port;
        this.workerPort.onmessage = (ev) => this.onWorker(ev.data);
      }
    };
  }

  onWorker(m) {
    if (m.type === 'chunk') {
      this.queue.push({ data: m.data, pos: m.pos, offset: 0, announced: false });
    } else if (m.type === 'flush') {
      // keep the head chunk briefly to fade out, drop the rest
      if (this.queue.length) {
        this.queue = [this.queue[0]];
        this.fadeOut = FADE;
        this.flushing = true;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
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
        if (R !== L) R[i] = d1[c.offset] * g;
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
    for (; i < n; i++) { L[i] = 0; if (R !== L) R[i] = 0; }
    if (this.consumed >= 1024 && this.workerPort) {
      this.workerPort.postMessage({ type: 'consumed', n: this.consumed });
      this.consumed = 0;
    }
    return true;
  }
}

registerProcessor('stretch-player', StretchPlayer);
