// WAV writing shared by exports and captures: 16- or 24-bit PCM with TPDF
// dither, and an optional `smpl` chunk (root note, fine tuning, loop points)
// that samplers such as Ableton Simpler/Sampler, Kontakt and Logic Sampler read.

export function wavHeader(frames, sampleRate, nch = 2, bits = 16, extraBytes = 0) {
  const bps = bits / 8;
  const dataBytes = frames * nch * bps;
  const v = new DataView(new ArrayBuffer(44));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes + (dataBytes & 1) + extraBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * bps, true);
  v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  return new Uint8Array(v.buffer);
}

// midi: fractional MIDI note of the sound (69 = A4). loop: { start, end } in
// sample frames, end inclusive. Returns the complete chunk (id + size + body).
export function smplChunk({ sampleRate, midi = 60, loop = null }) {
  const nLoops = loop ? 1 : 0;
  const body = 36 + 24 * nLoops;
  const v = new DataView(new ArrayBuffer(8 + body));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  const unity = Math.max(0, Math.min(127, Math.floor(midi)));
  const frac = Math.max(0, Math.min(0.999999, midi - unity));
  str(0, 'smpl'); v.setUint32(4, body, true);
  v.setUint32(8, 0, true);                                  // manufacturer
  v.setUint32(12, 0, true);                                 // product
  v.setUint32(16, Math.round(1e9 / sampleRate), true);      // sample period (ns)
  v.setUint32(20, unity, true);                             // MIDI unity note
  v.setUint32(24, Math.floor(frac * 4294967296), true);     // pitch fraction above it
  v.setUint32(28, 0, true); v.setUint32(32, 0, true);       // SMPTE format / offset
  v.setUint32(36, nLoops, true);
  v.setUint32(40, 0, true);                                 // sampler data
  if (loop) {
    v.setUint32(44, 0, true);                               // cue point id
    v.setUint32(48, 0, true);                               // forward loop
    v.setUint32(52, loop.start, true);
    v.setUint32(56, loop.end, true);
    v.setUint32(60, 0, true);                               // fraction
    v.setUint32(64, 0, true);                               // play count: infinite
  }
  return new Uint8Array(v.buffer);
}

// Converts float blocks to interleaved PCM bytes, reusing one buffer.
export class PcmEncoder {
  constructor(bits = 16, nch = 2) {
    this.bits = bits; this.nch = nch;
    this.buf = new Uint8Array(0);
  }
  encode(chs, n, offset = 0) {
    const bps = this.bits / 8, nch = this.nch;
    const need = n * nch * bps;
    if (this.buf.length < need) this.buf = new Uint8Array(need);
    const out = this.buf;
    const full = this.bits === 24 ? 8388607 : 32767;
    const lsb = 1 / (full + 1);
    let o = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < nch; c++) {
        let s = chs[Math.min(c, chs.length - 1)][offset + i] + (Math.random() - Math.random()) * lsb;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        let q = Math.round(s * full);
        if (q < 0) q += this.bits === 24 ? 16777216 : 65536;
        out[o++] = q & 255;
        out[o++] = (q >> 8) & 255;
        if (bps === 3) out[o++] = (q >> 16) & 255;
      }
    }
    return out.subarray(0, need);
  }
}

// Whole file in memory (captures up to about a minute plus tail).
export function encodeWavBlob(channels, sampleRate, { bits = 24, smpl = null } = {}) {
  const nch = channels.length, n = channels[0].length;
  const enc = new PcmEncoder(bits, nch);
  const parts = [];
  const extra = smpl ? smpl.byteLength : 0;
  const dataBytes = n * nch * (bits / 8);
  parts.push(wavHeader(n, sampleRate, nch, bits, extra));
  for (let o = 0; o < n; o += 65536) {
    const k = Math.min(65536, n - o);
    parts.push(enc.encode(channels, k, o).slice());
  }
  if (dataBytes & 1) parts.push(new Uint8Array(1));
  if (smpl) parts.push(smpl);
  return new Blob(parts, { type: 'audio/wav' });
}
