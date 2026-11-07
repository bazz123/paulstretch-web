import { defaultParams, WINDOW_TYPES, MODULES, drawEqCurve, DRAW_EQ_MIN_DB, DRAW_EQ_MAX_DB } from './dsp.js';
import { defaultFx, normalizeFx, FX_REORDERABLE, eqResponseDb, EQ_LOW_FREQ, EQ_HIGH_FREQ } from './effects.js';
import { openHelp } from './help.js';
import { PRESETS, PRESET_VERSION, applySettings, snapshot, loadUserPresets, saveUserPresets } from './presets.js';

const $ = (id) => document.getElementById(id);
const params = defaultParams();
params.fx = defaultFx();

let ctx = null, node = null, gainNode = null, analyser = null, worker = null;
let audio = null;          // { name, buffer, sampleRate, duration, peaks }
let playing = false;
let playPos = 0;           // input position (0..1) of the frame now playing
let renderId = 0, renderUrl = null, renderWorker = null;

// ------------------------------------------------------------------ audio graph

async function ensureAudio() {
  if (ctx) { if (ctx.state === 'suspended') await ctx.resume(); return; }
  ctx = new AudioContext({ latencyHint: 'playback' });
  await ctx.audioWorklet.addModule(new URL('./player-worklet.js', import.meta.url));
  node = new AudioWorkletNode(ctx, 'stretch-player', { numberOfInputs: 0, outputChannelCount: [2] });
  gainNode = ctx.createGain();
  gainNode.gain.value = dbToGain(params.volumeDb);
  analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  analyser.smoothingTimeConstant = 0.82;
  node.connect(gainNode).connect(analyser).connect(ctx.destination);

  worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  const ch = new MessageChannel();
  worker.postMessage({ type: 'port', port: ch.port1 }, [ch.port1]);
  node.port.postMessage({ type: 'port', port: ch.port2 }, [ch.port2]);
  worker.postMessage({ type: 'params', params: engineParams() });
  node.port.postMessage({ type: 'fx', fx: engineParams().fx });
  worker.onmessage = onWorkerMessage;
  node.port.onmessage = (e) => { if (e.data.type === 'pos') { playPos = e.data.pos; drawWave(); } };
  requestAnimationFrame(drawSpectrum);
}

const dbToGain = (db) => Math.pow(10, db / 20);
const engineParams = () => JSON.parse(JSON.stringify(params));

let paramsPending = false;
function sendParams() {
  if (!worker || paramsPending) return;
  paramsPending = true;
  requestAnimationFrame(() => {
    paramsPending = false;
    const p = engineParams();
    worker.postMessage({ type: 'params', params: p });
    node?.port.postMessage({ type: 'fx', fx: p.fx });
  });
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'ended') stop();
}

// ------------------------------------------------------------------ loading

async function loadArrayBuffer(buf, name) {
  await ensureAudio();
  stop();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    $('fileInfo').textContent = `Could not decode “${name}”. Try WAV, MP3, FLAC, OGG or M4A.`;
    return;
  }
  setAudio(decoded, name);
}

function setAudio(abuf, name) {
  const nch = Math.min(2, abuf.numberOfChannels);
  const channels = [];
  for (let c = 0; c < nch; c++) channels.push(Float32Array.from(abuf.getChannelData(c)));
  audio = { name, buffer: abuf, sampleRate: abuf.sampleRate, duration: abuf.duration, nch, peaks: computePeaks(channels, 2000) };
  params.start = 0; params.end = 1;
  playPos = 0;
  worker.postMessage({ type: 'params', params: engineParams() });
  worker.postMessage({ type: 'load', channels, sampleRate: abuf.sampleRate }, channels.map((c) => c.buffer));
  $('fileInfo').textContent = `${name} · ${fmtTime(abuf.duration)} · ${nch === 1 ? 'mono' : 'stereo'} · ${abuf.sampleRate} Hz`;
  $('fileInfo').classList.remove('muted');
  $('play').disabled = false;
  $('render').disabled = false;
  refreshDerived();
  drawWave();
}

function computePeaks(channels, cols) {
  const len = channels[0].length;
  const mins = new Float32Array(cols), maxs = new Float32Array(cols);
  for (let x = 0; x < cols; x++) {
    const a = Math.floor((x * len) / cols), b = Math.max(a + 1, Math.floor(((x + 1) * len) / cols));
    let mn = 1, mx = -1;
    for (const ch of channels) for (let i = a; i < b; i++) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    mins[x] = mn; maxs[x] = mx;
  }
  return { mins, maxs };
}

// A short synthetic phrase so the app can be tried without a file.
async function makeDemo() {
  await ensureAudio();
  stop();
  const sr = ctx.sampleRate, secs = 4;
  const off = new OfflineAudioContext(2, sr * secs, sr);
  const notes = [57, 60, 64, 67, 71, 72, 69, 64];
  notes.forEach((midi, i) => {
    const t = 0.25 + i * 0.42;
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    for (const [mult, amp] of [[1, 0.5], [2, 0.18], [3, 0.08], [4.01, 0.05]]) {
      const o = off.createOscillator(), g = off.createGain(), p = off.createStereoPanner();
      o.frequency.value = f * mult;
      o.type = mult === 1 ? 'triangle' : 'sine';
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * 0.5, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 1.8);
      p.pan.value = (i % 2 ? 0.35 : -0.35);
      o.connect(g).connect(p).connect(off.destination);
      o.start(t); o.stop(t + 2);
    }
  });
  const rendered = await off.startRendering();
  setAudio(rendered, 'Demo phrase (synthesised)');
}

// ------------------------------------------------------------------ transport

async function play() {
  if (!audio) return;
  await ensureAudio();
  worker.postMessage({ type: 'play' });
  node.port.postMessage({ type: 'play' });
  setPlaying(true);
}
function stop() {
  if (worker) worker.postMessage({ type: 'stop' });
  node?.port.postMessage({ type: 'stop' });
  setPlaying(false);
}
function setPlaying(p) {
  playing = p;
  $('playIcon').textContent = p ? '■' : '▶';
  $('playLabel').textContent = p ? 'Stop' : 'Play';
}
function seek(frac) {
  playPos = frac;
  worker?.postMessage({ type: 'seek', frac });
  drawWave();
}

// ------------------------------------------------------------------ controls

const fmtTime = (s) => {
  if (!isFinite(s)) return '∞';
  if (s < 60) return `${s.toFixed(1)} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
};
const fmtHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`);

// slider factory: log scaling for wide ranges
function slider({ label, min, max, step = 0.001, log = false, get, set, fmt = (v) => v.toFixed(2), onChange = sendParams }) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  const top = document.createElement('div');
  top.className = 'ctl-top';
  const lab = document.createElement('span');
  lab.textContent = label;
  const val = document.createElement('span');
  val.className = 'val mono';
  top.append(lab, val);
  const input = document.createElement('input');
  input.type = 'range';
  input.setAttribute('aria-label', label);
  const toPos = (v) => (log ? Math.log(v / min) / Math.log(max / min) : (v - min) / (max - min));
  const fromPos = (p) => {
    let v = log ? min * Math.pow(max / min, p) : min + p * (max - min);
    if (step >= 1) v = Math.round(v / step) * step;
    return Math.min(max, Math.max(min, v));
  };
  input.min = 0; input.max = 1; input.step = 0.0005;
  const refresh = () => { input.value = toPos(get()); val.textContent = fmt(get()); };
  input.addEventListener('input', () => { set(fromPos(+input.value)); val.textContent = fmt(get()); onChange(); });
  wrap.append(top, input);
  refresh();
  wrap.refresh = refresh;
  return wrap;
}

function select({ label, options, get, set }) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  const top = document.createElement('div');
  top.className = 'ctl-top';
  top.innerHTML = `<span>${label}</span>`;
  const sel = document.createElement('select');
  sel.setAttribute('aria-label', label);
  for (const [value, text] of options) {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    sel.append(o);
  }
  sel.value = String(get());
  sel.addEventListener('change', () => { set(sel.value); sendParams(); });
  wrap.append(top, sel);
  wrap.refresh = () => { for (let i = 0; i < options.length; i++) sel.options[i].textContent = options[i][1]; sel.value = String(get()); };
  return wrap;
}

function check({ label, get, set, onChange = sendParams }) {
  const l = document.createElement('label');
  l.className = 'check';
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = get();
  i.addEventListener('change', () => { set(i.checked); onChange(); });
  l.append(i, document.createTextNode(label));
  return l;
}

let durationEl, windowSel;
function buildMainControls() {
  const box = $('mainControls');
  box.innerHTML = '';
  const stretch = slider({
    label: 'Stretch amount', min: 0.1, max: 10000, log: true,
    get: () => params.stretch, set: (v) => { params.stretch = v; refreshDerived(); },
    fmt: (v) => `×${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)}`,
  });
  durationEl = document.createElement('div');
  durationEl.className = 'muted small mono';
  stretch.append(durationEl);

  const sizes = [];
  for (let p = 8; p <= 19; p++) sizes.push(1 << p);
  windowSel = select({
    label: 'Window size',
    options: sizes.map((s) => [s, windowLabel(s)]),
    get: () => params.bufsize, set: (v) => { params.bufsize = +v; },
  });
  const wtype = select({
    label: 'Window shape',
    options: WINDOW_TYPES.map((w) => [w, w[0].toUpperCase() + w.slice(1).replace('-h', '-H')]),
    get: () => params.windowType, set: (v) => { params.windowType = v; },
  });
  const onset = slider({ label: 'Onset detection', min: 0, max: 1, get: () => params.onset, set: (v) => { params.onset = v; }, fmt: (v) => (v < 0.001 ? 'off' : v.toFixed(2)) });
  const vol = slider({
    label: 'Volume', min: -24, max: 12, get: () => params.volumeDb, set: (v) => { params.volumeDb = v; },
    fmt: (v) => `${v.toFixed(1)} dB`,
    onChange: () => { if (gainNode) gainNode.gain.setTargetAtTime(dbToGain(params.volumeDb), ctx.currentTime, 0.03); },
  });
  const toggles = document.createElement('div');
  toggles.className = 'ctl toggles';
  const loop = check({ label: 'Loop', get: () => params.loop, set: (v) => { params.loop = v; } });
  const mono = check({ label: 'Mono → wide stereo', get: () => params.monoToStereo, set: (v) => { params.monoToStereo = v; } });
  // not part of presets, so changing them does not switch the dropdown to Custom
  vol.dataset.nopreset = loop.dataset.nopreset = mono.dataset.nopreset = '';
  toggles.append(
    check({ label: 'Freeze', get: () => params.freeze, set: (v) => { params.freeze = v; } }),
    loop,
    mono,
  );
  stretch.dataset.help = 'stretch';
  windowSel.dataset.help = 'windowSize';
  wtype.dataset.help = 'windowShape';
  onset.dataset.help = 'onset';
  vol.dataset.help = 'volume';
  toggles.dataset.help = 'toggles';
  box.append(stretch, windowSel, wtype, onset, vol, toggles);
}

function windowLabel(bufsize) {
  const sr = audio?.sampleRate || ctx?.sampleRate || 48000;
  const secs = (2 * bufsize) / sr;
  return `${bufsize * 2} samples · ${secs < 1 ? `${Math.round(secs * 1000)} ms` : `${secs.toFixed(2)} s`}`;
}

function refreshDerived() {
  if (!durationEl) return;
  if (audio) {
    const span = Math.abs(params.end - params.start) * audio.duration;
    const out = span * params.stretch;
    durationEl.textContent = `${fmtTime(span)} selection → ${fmtTime(out)} output`;
    $('rangeInfo').textContent = `${fmtTime(Math.min(params.start, params.end) * audio.duration)} – ${fmtTime(Math.max(params.start, params.end) * audio.duration)}`;
    setRenderSeconds(Math.min(MAX_EXPORT_SECONDS, out));
  } else {
    durationEl.textContent = 'Load audio to see the output length';
  }
  windowSel?.refresh();
}

const MODULE_DEFS = {
  harmonics: {
    title: 'Harmonics', desc: 'Keeps only a harmonic series, turning noise into a pitched drone.',
    controls: [
      { key: 'count', label: 'Harmonics', min: 1, max: 100, step: 1, fmt: (v) => String(v) },
      { key: 'freq', label: 'Base frequency', min: 1, max: 5000, log: true, fmt: fmtHz },
      { key: 'bandwidth', label: 'Bandwidth', min: 0.1, max: 200, fmt: (v) => `${v.toFixed(1)} ¢` },
      { key: 'gauss', label: 'Gaussian shape', toggle: true },
    ],
  },
  pitchShift: { title: 'Pitch shift', desc: 'Shifts every partial by a ratio.', controls: [{ key: 'semitones', label: 'Semitones', min: -24, max: 24, step: 0.1, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} st` }] },
  freqShift: { title: 'Frequency shift', desc: 'Adds a fixed offset in Hz. Inharmonic and metallic.', controls: [{ key: 'hz', label: 'Shift', min: -1000, max: 1000, step: 1, fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v)} Hz` }] },
  spread: { title: 'Spread', desc: 'Widens each partial into a band of noise.', controls: [{ key: 'amount', label: 'Bandwidth', min: 0, max: 1 }] },
  tonalNoise: {
    title: 'Tonal vs noise', desc: 'Positive keeps the tonal peaks; negative keeps the noise floor.',
    controls: [
      { key: 'preserve', label: 'Preserve', min: -1, max: 1, fmt: (v) => (v >= 0 ? `tonal ${v.toFixed(2)}` : `noise ${(-v).toFixed(2)}`) },
      { key: 'bandwidth', label: 'Bandwidth', min: 0.74, max: 1, fmt: (v) => v.toFixed(3) },
    ],
  },
  filter: {
    title: 'Filter', desc: 'Brick-wall band pass, or band stop.',
    controls: [
      { key: 'low', label: 'Low', min: 20, max: 20000, log: true, fmt: fmtHz },
      { key: 'high', label: 'High', min: 20, max: 20000, log: true, fmt: fmtHz },
      { key: 'stop', label: 'Band stop', toggle: true },
    ],
  },
  ratioMix: {
    title: 'Ratio mix', desc: 'Layers pitch-shifted copies, like octave doubling.',
    controls: ['−2 oct', '−1 oct', 'Original', '+1 oct', '+1 oct +5th', '+2 oct', '+5th', '−5th'].map((label, i) => ({ index: i, label, min: 0, max: 1 })),
  },
  compressor: { title: 'Compressor', desc: 'Evens out loudness between frames.', controls: [{ key: 'amount', label: 'Amount', min: 0, max: 1 }] },
};

const pct = (v) => `${Math.round(v * 100)}%`;
const fmtSecs = (v) => (v < 10 ? `${v.toFixed(1)} s` : fmtTime(v));

const FX_DEFS = {
  binaural: { title: 'Binaural beats', desc: 'Gives each ear a slightly different frequency. Needs headphones.' },
  eq3: {
    title: 'EQ (3-band)', desc: `Low shelf at ${EQ_LOW_FREQ} Hz, adjustable mid band, high shelf at ${EQ_HIGH_FREQ / 1000} kHz.`,
    controls: [
      { key: 'low', label: 'Low', min: -12, max: 12, step: 0.1, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` },
      { key: 'mid', label: 'Mid', min: -12, max: 12, step: 0.1, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` },
      { key: 'high', label: 'High', min: -12, max: 12, step: 0.1, fmt: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB` },
      { key: 'midFreq', label: 'Mid frequency', min: 100, max: 8000, log: true, fmt: fmtHz },
      { key: 'midQ', label: 'Mid width (Q)', min: 0.3, max: 4, log: true, fmt: (v) => `Q ${v.toFixed(2)}` },
    ],
  },
  chorus: {
    title: 'Chorus', desc: 'Up to four slowly drifting copies per side for a wide, lush image.',
    controls: [
      { key: 'rate', label: 'Rate', min: 0.05, max: 5, log: true, fmt: (v) => `${v.toFixed(2)} Hz` },
      { key: 'depth', label: 'Depth', min: 0, max: 1, fmt: pct },
      { key: 'voices', label: 'Voices', min: 1, max: 4, step: 1, fmt: (v) => String(v) },
      { key: 'spread', label: 'Stereo spread', min: 0, max: 1, fmt: pct },
      { key: 'mix', label: 'Mix', min: 0, max: 1, fmt: pct },
    ],
  },
  reverb: {
    title: 'Reverb', desc: 'Smooth algorithmic reverb for long ambient tails, with optional shimmer.',
    controls: [
      { key: 'size', label: 'Size', min: 0, max: 1, fmt: (v) => (v < 0.25 ? 'small' : v < 0.5 ? 'medium' : v < 0.8 ? 'large' : 'huge') + ` · ${pct(v)}` },
      { key: 'decay', label: 'Decay', min: 0.5, max: 30, log: true, fmt: fmtSecs },
      { key: 'damping', label: 'Damping', min: 0, max: 1, fmt: pct },
      { key: 'predelay', label: 'Pre-delay', min: 0, max: 250, step: 1, fmt: (v) => `${Math.round(v)} ms` },
      { key: 'width', label: 'Width', min: 0, max: 1, fmt: pct },
      { key: 'mix', label: 'Mix', min: 0, max: 1, fmt: pct },
      { key: 'shimmer', label: 'Shimmer (octave up in the tail)', toggle: true },
      { key: 'shimmerAmount', label: 'Shimmer amount', min: 0, max: 1, fmt: pct, show: 'shimmer' },
    ],
  },
};

function makeCard({ key, title, desc, num, isOn, setOn, fx, canUp, canDown, onUp, onDown, upTitle }) {
  const card = document.createElement('div');
  card.className = 'module' + (isOn() ? '' : ' off') + (fx ? ' fx' : '');
  card.dataset.module = key;
  const head = document.createElement('div');
  head.className = 'module-head';
  const idx = document.createElement('span');
  idx.className = 'idx mono';
  idx.textContent = num ?? '';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = isOn();
  toggle.setAttribute('aria-label', `Enable ${title}`);
  toggle.style.accentColor = 'var(--accent)';
  toggle.addEventListener('change', () => { setOn(toggle.checked); card.classList.toggle('off', !toggle.checked); sendParams(); });
  const t = document.createElement('span');
  t.className = 'title';
  t.textContent = title;
  head.append(idx, toggle, t);
  if (fx) {
    const tag = document.createElement('span');
    tag.className = 'fx-tag';
    tag.textContent = 'FX';
    head.append(tag);
  }
  if (onUp) {
    const up = document.createElement('button');
    up.className = 'order-btn'; up.textContent = '▲'; up.title = upTitle || 'Move earlier'; up.disabled = !canUp;
    up.addEventListener('click', onUp);
    const down = document.createElement('button');
    down.className = 'order-btn'; down.textContent = '▼'; down.title = upTitle || 'Move later'; down.disabled = !canDown;
    down.addEventListener('click', onDown);
    head.append(up, down);
  }
  const body = document.createElement('div');
  body.className = 'module-body';
  if (desc) {
    const p = document.createElement('p');
    p.className = 'desc';
    p.textContent = desc;
    body.append(p);
  }
  card.append(head, body);
  return { card, body };
}

function addControls(body, controls, target, onSet = () => {}) {
  for (const c of controls) {
    let el;
    if (c.toggle) el = check({ label: c.label, get: () => target[c.key], set: (v) => { target[c.key] = v; onSet(); } });
    else if (c.index !== undefined) el = slider({ ...c, get: () => target.levels[c.index], set: (v) => { target.levels[c.index] = v; onSet(); } });
    else el = slider({ ...c, get: () => target[c.key], set: (v) => { target[c.key] = v; onSet(); } });
    if (c.show) el.dataset.show = c.show;
    body.append(el);
  }
}

function buildModules() {
  const box = $('modules');
  box.innerHTML = '';
  // 1–8: spectral modules, reorderable among themselves
  params.order.forEach((name, idx) => {
    const def = MODULE_DEFS[name];
    const { card, body } = makeCard({
      key: name, title: def.title, desc: def.desc, num: idx + 1,
      isOn: () => params.enabled[name], setOn: (v) => { params.enabled[name] = v; },
      canUp: idx > 0, canDown: idx < params.order.length - 1,
      onUp: () => moveModule(idx, -1), onDown: () => moveModule(idx, 1),
    });
    addControls(body, def.controls, params[name]);
    box.append(card);
  });
  // FX: binaural first (fixed), then the reorderable effects
  const fx = params.fx;
  box.append(buildBinauralCard());
  fx.order.forEach((name, idx) => {
    const def = FX_DEFS[name];
    const { card, body } = makeCard({
      key: name, title: def.title, desc: def.desc, fx: true,
      isOn: () => fx.enabled[name], setOn: (v) => { fx.enabled[name] = v; },
      canUp: idx > 0, canDown: idx < fx.order.length - 1,
      onUp: () => moveFx(idx, -1), onDown: () => moveFx(idx, 1),
      upTitle: 'Reorder within the effects',
    });
    if (name === 'eq3') {
      const graph = document.createElement('canvas');
      graph.className = 'eq3-graph';
      graph.setAttribute('aria-label', 'EQ response curve');
      body.append(graph);
      const redraw = () => drawEq3(graph);
      addControls(body, def.controls, fx.eq3, redraw);
      requestAnimationFrame(redraw);
    } else {
      const vis = () => { for (const el of body.querySelectorAll('[data-show]')) el.hidden = !fx[name][el.dataset.show]; };
      addControls(body, def.controls, fx[name], vis);
      vis();
    }
    box.append(card);
  });
  box.append(buildDrawEqCard());
}

function buildBinauralCard() {
  const fx = params.fx, b = fx.binaural, g = b.glide;
  const { card, body } = makeCard({
    key: 'binaural', title: FX_DEFS.binaural.title, fx: true,
    isOn: () => fx.enabled.binaural, setOn: (v) => { fx.enabled.binaural = v; },
    canUp: false, canDown: false, onUp: () => {}, onDown: () => {}, upTitle: 'Binaural always runs first among the effects',
  });
  const note = document.createElement('p');
  note.className = 'desc headphones';
  note.textContent = '🎧 Headphones needed: each ear gets a slightly different frequency and you hear the difference as a slow beat. Not a medical treatment.';
  body.append(note);
  const vis = () => {
    for (const el of body.querySelectorAll('[data-show]')) {
      const s = el.dataset.show;
      el.hidden = (s === 'original' && b.mode === 'tones') || (s === 'tones' && b.mode === 'original') || (s === 'glide' && !g.enabled) || (s === 'noglide' && g.enabled);
    }
  };
  const tag = (el, s) => { el.dataset.show = s; return el; };
  body.append(
    select({ label: 'Mode', options: [['original', 'Shift the music (PaulXStretch)'], ['tones', 'Tone generator'], ['both', 'Both']], get: () => b.mode, set: (v) => { b.mode = v; vis(); } }),
    tag(slider({ label: 'Beat frequency', min: 0.5, max: 30, log: true, get: () => b.beat, set: (v) => { b.beat = v; }, fmt: (v) => `${v.toFixed(2)} Hz` }), 'noglide'),
    tag(select({ label: 'Direction', options: [['lr', 'Left → Right'], ['rl', 'Right → Left'], ['sym', 'Symmetric']], get: () => b.stereoMode, set: (v) => { b.stereoMode = v; } }), 'original'),
    tag(slider({ label: 'Amount', min: 0, max: 1, get: () => b.amount, set: (v) => { b.amount = v; }, fmt: pct }), 'original'),
    tag(slider({ label: 'Carrier frequency', min: 40, max: 1000, log: true, get: () => b.carrier, set: (v) => { b.carrier = v; }, fmt: fmtHz }), 'tones'),
    tag(slider({ label: 'Tone level', min: 0, max: 1, get: () => b.level, set: (v) => { b.level = v; }, fmt: pct }), 'tones'),
    check({ label: 'Glide the beat frequency', get: () => g.enabled, set: (v) => { g.enabled = v; vis(); } }),
    tag(slider({ label: 'Start beat', min: 0.5, max: 30, log: true, get: () => g.start, set: (v) => { g.start = v; }, fmt: (v) => `${v.toFixed(2)} Hz` }), 'glide'),
    tag(slider({ label: 'End beat', min: 0.5, max: 30, log: true, get: () => g.end, set: (v) => { g.end = v; }, fmt: (v) => `${v.toFixed(2)} Hz` }), 'glide'),
    tag(slider({ label: 'Glide duration', min: 10, max: 10800, log: true, get: () => g.duration, set: (v) => { g.duration = v; }, fmt: fmtSecs }), 'glide'),
    tag(select({ label: 'Curve', options: [['linear', 'Linear'], ['exp', 'Exponential']], get: () => g.curve, set: (v) => { g.curve = v; } }), 'glide'),
    tag(select({ label: 'Direction of glide', options: [['increasing', 'Increasing (low → high)'], ['decreasing', 'Decreasing (high → low)']], get: () => g.direction, set: (v) => { g.direction = v; } }), 'glide'),
  );
  const glideNote = document.createElement('p');
  glideNote.className = 'desc';
  glideNote.dataset.show = 'glide';
  glideNote.textContent = 'The glide follows playback time from when you press Play, and export time from the start of the file.';
  body.append(glideNote);
  vis();
  return card;
}

function moveFx(idx, dir) {
  const o = params.fx.order, j = idx + dir;
  if (j < 0 || j >= o.length) return;
  [o[idx], o[j]] = [o[j], o[idx]];
  buildModules();
  sendParams();
}

// ---------------------------------------------------------------- EQ graph

function drawEq3(c) {
  const dpr = sizeCanvas(c);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const sr = ctx?.sampleRate || 48000;
  const fx = (f) => (Math.log10(f / 20) / 3) * W;
  const fy = (db) => H / 2 - (db / 15) * (H / 2 - 4 * dpr);
  g.strokeStyle = '#243045';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, fy(0)); g.lineTo(W, fy(0)); g.stroke();
  const p = params.fx.eq3;
  const bands = [[EQ_LOW_FREQ, 'Low'], [p.midFreq, 'Mid'], [Math.min(EQ_HIGH_FREQ, sr * 0.45), 'High']];
  g.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
  g.fillStyle = '#8592a8';
  for (const [f, label] of bands) {
    const x = fx(f);
    g.fillStyle = 'rgba(143, 156, 255, 0.25)';
    g.fillRect(x - dpr / 2, 0, dpr, H);
    g.fillStyle = '#8592a8';
    g.fillText(label, Math.min(W - 26 * dpr, x + 3 * dpr), 11 * dpr);
  }
  const N = 160, freqs = [];
  for (let i = 0; i < N; i++) freqs.push(20 * Math.pow(1000, i / (N - 1)));
  const db = eqResponseDb(p, sr, freqs);
  g.strokeStyle = '#6fd3c4';
  g.lineWidth = 2 * dpr;
  g.beginPath();
  freqs.forEach((f, i) => { const x = fx(f), y = fy(db[i]); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
  g.stroke();
}

// ---------------------------------------------------------------- spectral EQ curve editor

let eqEditor = null;

function buildDrawEqCard() {
  const { card, body } = makeCard({
    key: 'drawEq', title: 'Spectral EQ curve', num: 9,
    desc: 'Draw a gain curve over the spectrum. Runs inside the stretch, after modules 1–8 and before the effects.',
    isOn: () => params.enabled.drawEq, setOn: (v) => { params.enabled.drawEq = v; },
  });
  card.classList.add('wide');
  const canvas = document.createElement('canvas');
  canvas.className = 'draw-eq';
  canvas.setAttribute('aria-label', 'Spectral EQ curve editor');
  canvas.tabIndex = 0;
  const bar = document.createElement('div');
  bar.className = 'draw-eq-bar';
  const readout = document.createElement('span');
  readout.className = 'mono small draw-eq-readout';
  readout.textContent = 'Click to add a point · drag to move · double-click or right-click a point to remove';
  const reset = document.createElement('button');
  reset.className = 'btn ghost small-btn';
  reset.textContent = 'Reset curve';
  reset.addEventListener('click', () => { params.drawEq.points = []; eqChanged(); });
  bar.append(readout, reset);
  body.append(canvas, bar);
  eqEditor = { canvas, readout, hover: -1, drag: -1 };
  wireEqEditor();
  requestAnimationFrame(drawEqEditor);
  return card;
}

const EQ_F_MIN = 20, EQ_F_MAX = 20000;
const eqX = (f, W) => (Math.log10(f / EQ_F_MIN) / Math.log10(EQ_F_MAX / EQ_F_MIN)) * W;
const eqF = (x, W) => EQ_F_MIN * Math.pow(EQ_F_MAX / EQ_F_MIN, Math.min(1, Math.max(0, x / W)));
const eqY = (db, H) => ((DRAW_EQ_MAX_DB - db) / (DRAW_EQ_MAX_DB - DRAW_EQ_MIN_DB)) * H;
const eqDb = (y, H) => Math.min(DRAW_EQ_MAX_DB, Math.max(DRAW_EQ_MIN_DB, DRAW_EQ_MAX_DB - (y / H) * (DRAW_EQ_MAX_DB - DRAW_EQ_MIN_DB)));

function eqChanged() {
  params.drawEq.points.sort((a, b) => a.f - b.f);
  markCustom();
  sendParams();
  drawEqEditor();
}

function eqShow(i) {
  const p = params.drawEq.points[i];
  if (p) eqEditor.readout.textContent = `${fmtHz(p.f)} · ${p.db > 0 ? '+' : ''}${p.db.toFixed(1)} dB`;
}

function wireEqEditor() {
  const { canvas } = eqEditor;
  const pos = (ev) => { const r = canvas.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top, W: r.width, H: r.height }; };
  const hit = ({ x, y, W, H }) => {
    const pts = params.drawEq.points;
    for (let i = 0; i < pts.length; i++) if (Math.hypot(eqX(pts[i].f, W) - x, eqY(pts[i].db, H) - y) < 10) return i;
    return -1;
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const p = pos(ev);
    let i = hit(p);
    if (i < 0) {
      if (params.drawEq.points.length >= 32) { eqEditor.readout.textContent = 'Maximum of 32 points'; return; }
      params.drawEq.points.push({ f: Math.round(eqF(p.x, p.W)), db: Math.round(eqDb(p.y, p.H) * 10) / 10 });
      eqChanged();
      i = hit(p);
    }
    eqEditor.drag = i;
    canvas.setPointerCapture(ev.pointerId);
    eqShow(i);
  });
  canvas.addEventListener('pointermove', (ev) => {
    const p = pos(ev);
    if (eqEditor.drag >= 0) {
      const pt = params.drawEq.points[eqEditor.drag];
      pt.f = Math.round(eqF(p.x, p.W));
      pt.db = Math.round(eqDb(p.y, p.H) * 10) / 10;
      const keep = pt;
      eqChanged();
      eqEditor.drag = params.drawEq.points.indexOf(keep);
      eqShow(eqEditor.drag);
      return;
    }
    const h = hit(p);
    if (h !== eqEditor.hover) { eqEditor.hover = h; drawEqEditor(); }
    canvas.style.cursor = h >= 0 ? 'grab' : 'crosshair';
    if (h >= 0) eqShow(h);
    else eqEditor.readout.textContent = `${fmtHz(eqF(p.x, p.W))} · ${eqDb(p.y, p.H).toFixed(1)} dB`;
  });
  const end = () => { eqEditor.drag = -1; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  const remove = (ev) => {
    const i = hit(pos(ev));
    if (i < 0) return;
    ev.preventDefault();
    params.drawEq.points.splice(i, 1);
    eqEditor.hover = -1;
    eqChanged();
    eqEditor.readout.textContent = 'Point removed';
  };
  canvas.addEventListener('dblclick', remove);
  canvas.addEventListener('contextmenu', remove);
}

function drawEqEditor() {
  if (!eqEditor || !eqEditor.canvas.isConnected) return;
  const c = eqEditor.canvas;
  const dpr = sizeCanvas(c);
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  // grid
  g.font = `${10 * dpr}px ui-sans-serif, system-ui, sans-serif`;
  g.fillStyle = '#5d6a82';
  g.strokeStyle = '#1c2536';
  g.lineWidth = 1;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = eqX(f, W);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3 * dpr, H - 4 * dpr);
  }
  for (let db = DRAW_EQ_MAX_DB; db >= DRAW_EQ_MIN_DB; db -= 12) {
    const y = eqY(db, H);
    g.strokeStyle = db === 0 ? '#2f3d57' : '#1c2536';
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    g.fillText(`${db > 0 ? '+' : ''}${db} dB`, 4 * dpr, y - 3 * dpr);
  }
  // live output spectrum underneath
  if (analyser && specData) {
    const sr = ctx.sampleRate, bins = specData.length;
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x < W; x += 2) {
      const f = eqF(x, W);
      const k = Math.min(bins - 1, Math.round((f / (sr / 2)) * bins));
      const v = Math.max(-110, Math.min(-10, specData[k]));
      g.lineTo(x, H - ((v + 110) / 100) * H);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fillStyle = 'rgba(143, 156, 255, 0.16)';
    g.fill();
  }
  // curve
  const curve = drawEqCurve(params.drawEq.points);
  g.strokeStyle = params.enabled.drawEq ? '#6fd3c4' : '#4a5a72';
  g.lineWidth = 2 * dpr;
  g.beginPath();
  for (let x = 0; x <= W; x += 2) {
    const y = eqY(curve(eqF(x, W)), H);
    if (x) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.stroke();
  params.drawEq.points.forEach((p, i) => {
    g.beginPath();
    g.arc(eqX(p.f, W), eqY(p.db, H), (i === eqEditor.hover || i === eqEditor.drag ? 7 : 5) * dpr, 0, 2 * Math.PI);
    g.fillStyle = '#0b0e14';
    g.fill();
    g.lineWidth = 2 * dpr;
    g.strokeStyle = '#8f9cff';
    g.stroke();
  });
}

function moveModule(idx, dir) {
  const o = params.order, j = idx + dir;
  [o[idx], o[j]] = [o[j], o[idx]];
  buildModules();
  sendParams();
}

// ------------------------------------------------------------------ presets

let userPresets = loadUserPresets();
const presetSel = $('preset');
const CUSTOM = 'custom';

function buildPresetSelect(selected) {
  presetSel.innerHTML = '';
  const custom = new Option('Custom (edited)', CUSTOM);
  custom.disabled = true;
  presetSel.add(custom);
  const builtIn = document.createElement('optgroup');
  builtIn.label = 'Presets';
  for (const p of PRESETS) builtIn.append(new Option(p.name, `builtin:${p.id}`));
  presetSel.add(builtIn);
  if (userPresets.length) {
    const mine = document.createElement('optgroup');
    mine.label = 'My presets';
    for (const p of userPresets) mine.append(new Option(p.name, `user:${p.name}`));
    presetSel.add(mine);
  }
  presetSel.value = selected;
  if (presetSel.value !== selected) presetSel.value = CUSTOM;
  updatePresetUi();
}

function findPreset(value) {
  if (value.startsWith('builtin:')) {
    const p = PRESETS.find((x) => `builtin:${x.id}` === value);
    return p && { name: p.name, usage: p.usage, settings: p.settings };
  }
  if (value.startsWith('user:')) {
    const p = userPresets.find((x) => `user:${x.name}` === value);
    return p && { name: p.name, usage: 'Your saved preset.', settings: p.settings };
  }
  return null;
}

function updatePresetUi() {
  const p = findPreset(presetSel.value);
  presetSel.title = p ? `${p.name}: ${p.usage}` : 'Settings changed by hand';
  $('deletePreset').hidden = !presetSel.value.startsWith('user:');
}

function applyPreset(value) {
  const p = findPreset(value);
  if (!p) return;
  applySettings(params, p.settings);
  buildMainControls();
  buildModules();
  refreshDerived();
  sendParams();
  presetSel.value = value;
  updatePresetUi();
}

function markCustom() {
  if (presetSel.value === CUSTOM) return;
  presetSel.value = CUSTOM;
  updatePresetUi();
}

let toastTimer = 0;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function savePreset() {
  const current = findPreset(presetSel.value);
  const suggestion = presetSel.value.startsWith('user:') ? current.name : '';
  const raw = prompt('Name for this preset:', suggestion);
  const name = raw?.trim().slice(0, 40);
  if (!name) return;
  if (PRESETS.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    alert(`“${name}” is a built-in preset name. Please choose another name.`);
    return;
  }
  const existing = userPresets.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
  if (existing >= 0 && !confirm(`Replace your preset “${userPresets[existing].name}”?`)) return;
  const entry = { name, version: PRESET_VERSION, settings: snapshot(params) };
  if (existing >= 0) userPresets[existing] = entry; else userPresets.push(entry);
  userPresets.sort((a, b) => a.name.localeCompare(b.name));
  const stored = saveUserPresets(userPresets);
  buildPresetSelect(`user:${name}`);
  toast(stored ? `Saved “${name}”` : `Saved “${name}” for this session only (browser storage is unavailable)`);
}

function deletePreset() {
  const value = presetSel.value;
  if (!value.startsWith('user:')) return;
  const name = value.slice(5);
  if (!confirm(`Delete your preset “${name}”? This can't be undone.`)) return;
  userPresets = userPresets.filter((p) => p.name !== name);
  saveUserPresets(userPresets);
  buildPresetSelect(CUSTOM);
  toast(`Deleted “${name}”`);
}

presetSel.addEventListener('change', () => applyPreset(presetSel.value));
$('savePreset').addEventListener('click', savePreset);
$('deletePreset').addEventListener('click', deletePreset);

// Any hand edit of a sound setting leaves the preset.
const onEdit = (e) => { if (!e.target.closest('[data-nopreset]')) markCustom(); };
$('mainControls').addEventListener('input', onEdit);
$('mainControls').addEventListener('change', onEdit);
$('modules').addEventListener('input', onEdit);
$('modules').addEventListener('change', onEdit);
$('modules').addEventListener('click', (e) => { if (e.target.closest('.order-btn')) markCustom(); });

// ------------------------------------------------------------------ waveform

const wave = $('wave');
function sizeCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return dpr;
}

function drawWave() {
  const dpr = sizeCanvas(wave);
  const g = wave.getContext('2d');
  const W = wave.width, H = wave.height;
  g.clearRect(0, 0, W, H);
  if (!audio) {
    g.fillStyle = '#243045';
    g.fillRect(0, H / 2, W, 1);
    return;
  }
  const s = Math.min(params.start, params.end) * W, e = Math.max(params.start, params.end) * W;
  g.fillStyle = 'rgba(111, 211, 196, 0.07)';
  g.fillRect(s, 0, e - s, H);
  const { mins, maxs } = audio.peaks;
  const cols = mins.length;
  for (let x = 0; x < W; x++) {
    const k = Math.floor((x / W) * cols);
    const y1 = H / 2 - maxs[k] * H * 0.46, y2 = H / 2 - mins[k] * H * 0.46;
    g.fillStyle = x >= s && x <= e ? '#6fd3c4' : '#3a4a66';
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  g.fillStyle = '#8f9cff';
  for (const x of [s, e]) { g.fillRect(x - dpr, 0, 2 * dpr, H); g.fillRect(x - 5 * dpr, 0, 10 * dpr, 4 * dpr); }
  const px = playPos * W;
  g.fillStyle = '#ffffff';
  g.fillRect(px - dpr / 2, 0, dpr, H);
}

let drag = null;
wave.addEventListener('pointerdown', (ev) => {
  if (!audio) return;
  const r = wave.getBoundingClientRect();
  const f = (ev.clientX - r.left) / r.width;
  const tol = 8 / r.width;
  const lo = Math.min(params.start, params.end), hi = Math.max(params.start, params.end);
  let mode = 'new';
  if (Math.abs(f - lo) < tol) mode = 'start';
  else if (Math.abs(f - hi) < tol) mode = 'end';
  params.start = lo; params.end = hi;
  drag = { mode, x0: ev.clientX, f0: f, moved: false };
  wave.setPointerCapture(ev.pointerId);
});
wave.addEventListener('pointermove', (ev) => {
  const r = wave.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  if (!drag) {
    if (!audio) return;
    const tol = 8 / r.width;
    wave.style.cursor = Math.abs(f - params.start) < tol || Math.abs(f - params.end) < tol ? 'ew-resize' : 'crosshair';
    return;
  }
  if (Math.abs(ev.clientX - drag.x0) > 3) drag.moved = true;
  if (!drag.moved) return;
  if (drag.mode === 'start') params.start = f;
  else if (drag.mode === 'end') params.end = f;
  else { params.start = Math.min(drag.f0, f); params.end = Math.max(drag.f0, f); }
  refreshDerived();
  drawWave();
});
wave.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag;
  drag = null;
  if (!d.moved) { seek(d.f0); return; }
  const lo = Math.min(params.start, params.end), hi = Math.max(params.start, params.end);
  params.start = lo; params.end = Math.max(hi, lo + 0.001);
  sendParams();
  if (playPos < lo || playPos > hi) seek(lo);
  refreshDerived();
  drawWave();
});
wave.addEventListener('dblclick', () => {
  params.start = 0; params.end = 1;
  sendParams(); refreshDerived(); drawWave();
});

// ------------------------------------------------------------------ spectrum

const spec = $('spectrum');
let specData = null;
function drawSpectrum() {
  requestAnimationFrame(drawSpectrum);
  sizeCanvas(spec);
  const g = spec.getContext('2d');
  const W = spec.width, H = spec.height;
  g.clearRect(0, 0, W, H);
  if (!analyser) return;
  if (!specData) specData = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(specData);
  const sr = ctx.sampleRate, bins = specData.length;
  const fmin = 30, fmax = sr / 2;
  g.beginPath();
  for (let x = 0; x < W; x++) {
    const f = fmin * Math.pow(fmax / fmin, x / W);
    const k = Math.min(bins - 1, Math.round((f / (sr / 2)) * bins));
    const db = Math.max(-110, Math.min(-10, specData[k]));
    const y = H - ((db + 110) / 100) * H;
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.lineTo(W, H); g.lineTo(0, H); g.closePath();
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(143, 156, 255, 0.55)');
  grad.addColorStop(1, 'rgba(111, 211, 196, 0.05)');
  g.fillStyle = grad;
  g.fill();
  drawEqEditor();
}

// ------------------------------------------------------------------ rendering (streamed export)

const MAX_EXPORT_SECONDS = 3 * 3600;
const PREVIEW_MAX_SECONDS = 20 * 60;
let renderStart = 0, renderPhase = '';

function getRenderSeconds() {
  const h = +$('renderH').value || 0, m = +$('renderM').value || 0, s = +$('renderS').value || 0;
  return Math.max(1, Math.min(MAX_EXPORT_SECONDS, Math.round(h * 3600 + m * 60 + s)));
}

function setRenderSeconds(total) {
  total = Math.max(1, Math.min(MAX_EXPORT_SECONDS, Math.round(total)));
  $('renderH').value = Math.floor(total / 3600);
  $('renderM').value = Math.floor((total % 3600) / 60);
  $('renderS').value = total % 60;
}

function setRendering(on) {
  $('renderProgress').hidden = !on;
  $('renderStatus').hidden = !on;
  $('cancelRender').hidden = !on;
  $('render').disabled = on;
}

async function render() {
  if (!audio) return;
  await ensureAudio();
  const seconds = getRenderSeconds();
  setRenderSeconds(seconds);
  renderId++;
  const id = renderId;
  if (renderWorker) renderWorker.terminate();
  renderWorker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
  renderWorker.onmessage = (e) => onRenderMessage(e.data);
  renderWorker.onerror = (e) => onRenderMessage({ type: 'error', id, message: e.message || 'The export worker failed to start.' });
  const abuf = audio.buffer;
  const channels = [];
  for (let c = 0; c < Math.min(2, abuf.numberOfChannels); c++) channels.push(Float32Array.from(abuf.getChannelData(c)));
  if (renderUrl) { URL.revokeObjectURL(renderUrl); renderUrl = null; }
  $('renderOut').innerHTML = '';
  $('renderProgress').value = 0;
  $('renderStatus').textContent = 'Starting…';
  setRendering(true);
  renderStart = performance.now();
  renderPhase = '';
  renderWorker.postMessage(
    { type: 'render', id, channels, sampleRate: abuf.sampleRate, params: engineParams(), seconds, normalize: $('normalize').checked },
    channels.map((c) => c.buffer),
  );
}

function onRenderMessage(m) {
  if (m.id !== renderId) return;
  if (m.type === 'phase') {
    renderPhase = m.phase;
  } else if (m.type === 'progress') {
    $('renderProgress').value = m.progress;
    const elapsed = (performance.now() - renderStart) / 1000;
    const eta = m.progress > 0.01 ? elapsed * (1 / m.progress - 1) : NaN;
    const what = renderPhase === 'measure' ? 'Measuring the peak (pass 1 of 2)' : $('normalize').checked ? 'Writing (pass 2 of 2)' : 'Writing';
    $('renderStatus').textContent = `${what} · ${Math.round(m.progress * 100)}% · ${isFinite(eta) ? `about ${fmtTime(eta)} left` : 'estimating…'}`;
  } else if (m.type === 'done') {
    finishRender(m);
  } else if (m.type === 'error') {
    setRendering(false);
    renderWorker?.terminate();
    renderWorker = null;
    $('renderOut').textContent = `Export failed: ${m.message}`;
  }
}

async function finishRender(m) {
  setRendering(false);
  renderWorker?.terminate();
  renderWorker = null;
  let file = m.blob;
  if (m.kind === 'opfs') {
    const root = await navigator.storage.getDirectory();
    file = await (await root.getFileHandle(m.name)).getFile();
  }
  renderUrl = URL.createObjectURL(file);
  const base = (audio.name || 'audio').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'audio';
  const fname = `${base} x${Math.round(params.stretch)}.wav`;
  const out = $('renderOut');
  out.innerHTML = '';
  const a = document.createElement('a');
  a.href = renderUrl; a.download = fname;
  a.textContent = `Download ${fname} (${(file.size / 1048576).toFixed(file.size > 1e9 ? 0 : 1)} MB)`;
  const info = document.createElement('span');
  info.className = 'muted small';
  info.textContent = `${fmtTime(m.bodySeconds)}${m.tailSeconds > 0.05 ? ` + ${m.tailSeconds.toFixed(1)} s effect tail` : ''} · took ${fmtTime((performance.now() - renderStart) / 1000)}${m.clipped ? ' · some peaks clipped: lower the volume or turn on Normalise' : ''}`;
  if (m.seconds <= PREVIEW_MAX_SECONDS) {
    const player = document.createElement('audio');
    player.controls = true; player.src = renderUrl;
    out.append(player);
  }
  out.append(a, info);
}

$('cancelRender').addEventListener('click', async () => {
  const id = renderId;
  renderId++;
  renderWorker?.terminate();
  renderWorker = null;
  setRendering(false);
  $('renderOut').textContent = 'Export cancelled.';
  await removeExportFiles(`export-${id}.wav`);
});

// The stopped worker releases its file lock shortly after terminate(), so retry briefly.
async function removeExportFiles(only) {
  let root;
  try { root = await navigator.storage.getDirectory(); } catch { return; }
  for (let attempt = 0; attempt < 20; attempt++) {
    let left = 0;
    try {
      const names = [];
      for await (const [n] of root.entries()) if (n.startsWith('export-') && (!only || n === only)) names.push(n);
      for (const n of names) {
        try { await root.removeEntry(n); } catch { left++; }
      }
    } catch { return; }
    if (!left) return;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Export files from an earlier visit can't be downloaded any more: free the space.
removeExportFiles();

// ------------------------------------------------------------------ wiring

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await loadArrayBuffer(await f.arrayBuffer(), f.name);
  e.target.value = '';
});
$('demo').addEventListener('click', makeDemo);
$('play').addEventListener('click', () => (playing ? stop() : play()));
$('render').addEventListener('click', render);
$('helpBtn').addEventListener('click', openHelp);

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) await loadArrayBuffer(await f.arrayBuffer(), f.name);
});
window.addEventListener('keydown', (e) => {
  if ($('help').open) return;
  if (e.key === '?') { openHelp(); return; }
  if (e.code !== 'Space' || !audio) return;
  const t = e.target;
  if (t instanceof HTMLSelectElement || (t instanceof HTMLInputElement && (t.type === 'number' || t.type === 'text'))) return;
  e.preventDefault();
  playing ? stop() : play();
});
window.addEventListener('resize', () => {
  drawWave();
  drawEqEditor();
  document.querySelectorAll('.eq3-graph').forEach(drawEq3);
});

applySettings(params, PRESETS[0].settings);
buildMainControls();
buildModules();
buildPresetSelect(`builtin:${PRESETS[0].id}`);
refreshDerived();
drawWave();
console.assert(MODULES.every((m) => MODULE_DEFS[m]), 'module UI missing');
