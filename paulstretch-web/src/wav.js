// 16-bit PCM WAV encoder with optional peak normalisation and TPDF dither.
export function encodeWav(channels, sampleRate, { normalize = true, peakDb = -1 } = {}) {
  const nch = channels.length;
  const len = channels[0].length;
  let gain = 1;
  if (normalize) {
    let peak = 0;
    for (const ch of channels) for (let i = 0; i < len; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
    if (peak > 1e-9) gain = Math.pow(10, peakDb / 20) / peak;
  }
  const bytes = 44 + len * nch * 2;
  const buf = new ArrayBuffer(bytes);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, len * nch * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      const dither = (Math.random() - Math.random()) / 32768;
      let s = channels[c][i] * gain + dither;
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      v.setInt16(o, Math.round(s * 32767), true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
