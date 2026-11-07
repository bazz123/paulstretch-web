import { defaultParams, WINDOW_TYPES, MODULES } from './dsp.js';
import { encodeWav } from './wav.js';
import { openHelp } from './help.js';
import { PRESETS, applySettings, snapshot, loadUserPresets, saveUserPresets } from './presets.js';

const $ = (id) => document.getElementById(id);
const params = defaultParams();

let ctx = null, node = null, gainNode = null, analyser = null, worker = null;
let audio = null;          // { name, channels, sampleRate, duration, peaks }
let playing = false;
let playPos = 0;           // input position (0..1) of the frame now playing
let renderId = 0, renderUrl = null;

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
    worker.postMessage({ type: 'params', params: engineParams() });
  });
}

function onWorkerMessage(e) {
  const m = e.data;
  if (m.type === 'ended') setPlaying(false);
  else if (m.type === 'render-progress' && m.id === renderId) $('renderProgress').value = m.progress;
  else if (m.type === 'render-done' && m.id === renderId) finishRender(m);
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
  audio = { name, sampleRate: abuf.sampleRate, duration: abuf.duration, nch, peaks: computePeaks(channels, 2000) };
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
  setPlaying(true);
}
function stop() {
  if (worker) worker.postMessage({ type: 'stop' });
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
    $('renderSecs').value = Math.max(1, Math.min(600, Math.round(out)));
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

function buildModules() {
  const box = $('modules');
  box.innerHTML = '';
  params.order.forEach((name, idx) => {
    const def = MODULE_DEFS[name];
    const card = document.createElement('div');
    card.className = 'module' + (params.enabled[name] ? '' : ' off');
    card.dataset.module = name;
    const head = document.createElement('div');
    head.className = 'module-head';
    const num = document.createElement('span');
    num.className = 'idx mono';
    num.textContent = idx + 1;
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = params.enabled[name];
    toggle.setAttribute('aria-label', `Enable ${def.title}`);
    toggle.style.accentColor = 'var(--accent)';
    toggle.addEventListener('change', () => { params.enabled[name] = toggle.checked; card.classList.toggle('off', !toggle.checked); sendParams(); });
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = def.title;
    const up = document.createElement('button');
    up.className = 'order-btn'; up.textContent = '▲'; up.title = 'Move earlier'; up.disabled = idx === 0;
    up.addEventListener('click', () => moveModule(idx, -1));
    const down = document.createElement('button');
    down.className = 'order-btn'; down.textContent = '▼'; down.title = 'Move later'; down.disabled = idx === params.order.length - 1;
    down.addEventListener('click', () => moveModule(idx, 1));
    head.append(num, toggle, title, up, down);

    const body = document.createElement('div');
    body.className = 'module-body';
    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = def.desc;
    body.append(desc);
    for (const c of def.controls) {
      const target = params[name];
      if (c.toggle) {
        body.append(check({ label: c.label, get: () => target[c.key], set: (v) => { target[c.key] = v; } }));
      } else if (c.index !== undefined) {
        body.append(slider({ ...c, get: () => target.levels[c.index], set: (v) => { target.levels[c.index] = v; } }));
      } else {
        body.append(slider({ ...c, get: () => target[c.key], set: (v) => { target[c.key] = v; } }));
      }
    }
    card.append(head, body);
    box.append(card);
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
  const entry = { name, settings: snapshot(params) };
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
}

// ------------------------------------------------------------------ rendering

async function render() {
  if (!audio) return;
  await ensureAudio();
  const secs = Math.max(1, Math.min(600, +$('renderSecs').value || 60));
  renderId++;
  $('renderProgress').hidden = false;
  $('renderProgress').value = 0;
  $('cancelRender').hidden = false;
  $('render').disabled = true;
  worker.postMessage({ type: 'render', id: renderId, seconds: secs, params: engineParams() });
}

function finishRender(m) {
  $('renderProgress').hidden = true;
  $('cancelRender').hidden = true;
  $('render').disabled = false;
  const blob = encodeWav(m.channels, m.sampleRate, { normalize: $('normalize').checked });
  if (renderUrl) URL.revokeObjectURL(renderUrl);
  renderUrl = URL.createObjectURL(blob);
  const base = (audio.name || 'audio').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim() || 'audio';
  const fname = `${base} x${Math.round(params.stretch)}.wav`;
  const out = $('renderOut');
  out.innerHTML = '';
  const a = document.createElement('a');
  a.href = renderUrl; a.download = fname; a.textContent = `Download ${fname} (${(blob.size / 1048576).toFixed(1)} MB)`;
  const player = document.createElement('audio');
  player.controls = true; player.src = renderUrl;
  out.append(player, a);
}

$('cancelRender').addEventListener('click', () => {
  worker?.postMessage({ type: 'cancel-render' });
  renderId++;
  $('renderProgress').hidden = true;
  $('cancelRender').hidden = true;
  $('render').disabled = false;
});

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
window.addEventListener('resize', drawWave);

applySettings(params, PRESETS[0].settings);
buildMainControls();
buildModules();
buildPresetSelect(`builtin:${PRESETS[0].id}`);
refreshDerived();
drawWave();
console.assert(MODULES.every((m) => MODULE_DEFS[m]), 'module UI missing');
