// Help dialog. Every "screenshot" is a live, non-interactive copy of the real
// control, so the pictures always match the current interface and settings.
import { makeWindow, WINDOW_TYPES } from './dsp.js';
import { PRESETS, describeSettings } from './presets.js';

const $ = (id) => document.getElementById(id);
const COLORS = ['#8592a8', '#6fd3c4', '#8f9cff', '#f2b56b', '#e98aa8'];

// ---------------------------------------------------------------- previews

function cloneEl(el) {
  if (!el) return document.createTextNode('');
  const c = el.cloneNode(true);
  c.removeAttribute('id');
  c.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  c.querySelectorAll('input, select, button').forEach((n) => { n.tabIndex = -1; });
  // cloneNode does not copy live form state or canvas pixels
  const srcInputs = el.querySelectorAll('input, select');
  c.querySelectorAll('input, select').forEach((n, i) => {
    const s = srcInputs[i];
    if (n.type === 'checkbox') n.checked = s.checked; else n.value = s.value;
  });
  const srcCanvases = el.tagName === 'CANVAS' ? [el] : [...el.querySelectorAll('canvas')];
  const dstCanvases = c.tagName === 'CANVAS' ? [c] : [...c.querySelectorAll('canvas')];
  dstCanvases.forEach((d, i) => {
    const s = srcCanvases[i];
    d.width = s.width; d.height = s.height;
    d.getContext('2d').drawImage(s, 0, 0);
  });
  return c;
}

function shot(...nodes) {
  const box = document.createElement('div');
  box.className = 'shot';
  box.inert = true;
  box.setAttribute('aria-hidden', 'true');
  box.append(...nodes);
  return box;
}

function canvas(w, h, draw) {
  const c = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  c.style.aspectRatio = `${w} / ${h}`;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  draw(g, w, h);
  return c;
}

const hasAudio = () => !$('fileInfo').classList.contains('muted');

// a deterministic fake waveform: plucked notes
function fakeWave(n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const note = Math.floor(t * 8);
    const local = t * 8 - note;
    out[i] = Math.exp(-local * 4) * (0.55 + 0.35 * Math.sin(note * 1.7)) * (0.6 + 0.4 * Math.sin(i * 0.9));
  }
  return out;
}

function drawWaveIllustration(g, W, H, { range = [0.3, 0.65], playhead = 0.48 } = {}) {
  const amp = fakeWave(W);
  const [s, e] = [range[0] * W, range[1] * W];
  g.fillStyle = 'rgba(111, 211, 196, 0.07)';
  g.fillRect(s, 0, e - s, H);
  for (let x = 0; x < W; x++) {
    const a = amp[x] * H * 0.42;
    g.fillStyle = x >= s && x <= e ? '#6fd3c4' : '#3a4a66';
    g.fillRect(x, H / 2 - a, 1, Math.max(1, 2 * a));
  }
  g.fillStyle = '#8f9cff';
  for (const x of [s, e]) { g.fillRect(x - 1, 0, 2, H); g.fillRect(x - 5, 0, 10, 4); }
  g.fillStyle = '#fff';
  g.fillRect(playhead * W, 0, 1, H);
}

function waveShot() {
  const real = $('wave');
  if (hasAudio()) return shot(cloneEl(real));
  return shot(canvas(600, 140, (g, W, H) => drawWaveIllustration(g, W, H)));
}

function isBlank(c) {
  if (!c.width || !c.height) return true;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 64) if (d[i]) return false;
  return true;
}

function spectrumShot() {
  const real = $('spectrum');
  if (!isBlank(real)) return shot(cloneEl(real));
  return shot(canvas(600, 90, (g, W, H) => {
    g.beginPath();
    g.moveTo(0, H);
    for (let x = 0; x < W; x++) {
      const t = x / W;
      let db = -95 + 40 * Math.exp(-t * 2.5);
      for (let h = 1; h <= 8; h++) {
        const pos = 0.32 + Math.log2(h) * 0.13;
        db += (30 / h) * Math.exp(-(((t - pos) / 0.006) ** 2));
      }
      g.lineTo(x, H - ((db + 110) / 100) * H);
    }
    g.lineTo(W, H);
    g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(143, 156, 255, 0.55)');
    grad.addColorStop(1, 'rgba(111, 211, 196, 0.05)');
    g.fillStyle = grad;
    g.fill();
  }));
}

function windowShapeShot() {
  const c = canvas(600, 170, (g, W, H) => {
    const pad = 12, n = 256;
    g.strokeStyle = '#243045';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad, H - pad); g.lineTo(W - pad, H - pad); g.stroke();
    WINDOW_TYPES.forEach((type, k) => {
      const w = makeWindow(type, n);
      g.strokeStyle = COLORS[k];
      g.lineWidth = 2;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const x = pad + (i / (n - 1)) * (W - 2 * pad);
        const y = H - pad - w[i] * (H - 2 * pad);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    });
  });
  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML = WINDOW_TYPES.map((t, k) => `<span><i style="background:${COLORS[k]}"></i>${t}</span>`).join('');
  return shot(cloneEl(document.querySelector('[data-help="windowShape"]')), c, legend);
}

function windowSizeShot() {
  const c = canvas(600, 150, (g, W, H) => {
    const amp = fakeWave(W);
    for (let x = 0; x < W; x++) {
      const a = amp[x] * 42;
      g.fillStyle = '#3a4a66';
      g.fillRect(x, 60 - a, 1, Math.max(1, 2 * a));
    }
    const bracket = (x0, x1, y, color, label) => {
      g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2;
      g.beginPath(); g.moveTo(x0, y - 6); g.lineTo(x0, y); g.lineTo(x1, y); g.lineTo(x1, y - 6); g.stroke();
      g.globalAlpha = 0.12; g.fillRect(x0, 8, x1 - x0, y - 14); g.globalAlpha = 1;
      g.font = '12px ui-sans-serif, system-ui, sans-serif';
      g.fillText(label, x0, y + 16);
    };
    bracket(40, 80, 118, '#6fd3c4', 'small: rhythm survives');
    bracket(250, 560, 118, '#8f9cff', 'large: everything blends, pure pitch');
  });
  return shot(cloneEl(document.querySelector('[data-help="windowSize"]')), c);
}

function onsetShot() {
  const c = canvas(600, 120, (g, W, H) => {
    const amp = fakeWave(W);
    for (let x = 0; x < W; x++) {
      const a = amp[x] * 40;
      g.fillStyle = '#3a4a66';
      g.fillRect(x, 54 - a, 1, Math.max(1, 2 * a));
    }
    g.fillStyle = '#f2b56b';
    g.font = '12px ui-sans-serif, system-ui, sans-serif';
    for (let k = 0; k < 8; k++) {
      const x = (k / 8) * W + 1;
      g.fillRect(x, 6, 2, 96);
      g.beginPath(); g.moveTo(x - 4, 6); g.lineTo(x + 6, 6); g.lineTo(x + 1, 13); g.fill();
    }
    g.fillText('detected attacks: the play position jumps to these', 8, H - 4);
  });
  return shot(cloneEl(document.querySelector('[data-help="onset"]')), c);
}

const ctl = (key) => shot(cloneEl(document.querySelector(`[data-help="${key}"]`)));
const moduleShot = (name) => shot(cloneEl(document.querySelector(`[data-module="${name}"]`)));

// ---------------------------------------------------------------- content

const SECTIONS = [
  {
    id: 'start', title: 'Opening and playing',
    shot: () => shot(cloneEl(document.querySelector('.transport'))),
    html: `<p><strong>Open audio…</strong> loads a file (WAV, MP3, FLAC, OGG, M4A). You can also drop a file anywhere on the page.</p>
      <p><strong>Demo sound</strong> creates a short melody to experiment with.</p>
      <p><strong>Play / Stop</strong> starts or stops playback (shortcut: <kbd>space</kbd>). <strong>?</strong> opens this help (shortcut: <kbd>?</kbd>).</p>`,
  },
  {
    id: 'presets', title: 'Presets',
    shot: () => shot(cloneEl(document.querySelector('.preset-bar'))),
    html: `<p>Pick a preset from the dropdown to load a ready-made sound. A preset changes only the sound settings; your file, selection, volume, Loop and Mono → wide stereo stay as they are. Modules a preset doesn't use are switched off.</p>
      <p>As soon as you change a setting by hand, the dropdown shows <strong>Custom (edited)</strong>.</p>
      <p><strong>Save…</strong> stores the current settings under a name of your own, under <em>My presets</em>. <strong>Delete</strong> appears when one of your presets is selected. Your presets are kept in this browser on this computer.</p>
      <p>The built-in presets are described below. Window lengths are for 48 kHz audio; at 44.1 kHz they are about 9% longer.</p>`,
    wide: () => `<div class="preset-cards">${PRESETS.map((p) => `
      <article class="preset-card">
        <h4>${p.name}</h4>
        <p class="use">${p.usage}</p>
        <p>${p.tip}</p>
        <ul class="chips">${describeSettings(p.settings).map((d) => `<li>${d}</li>`).join('')}</ul>
      </article>`).join('')}</div>`,
  },
  {
    id: 'wave', title: 'Waveform and selection',
    shot: waveShot,
    html: `<p>Shows the loaded sound. The <strong>green part</strong> is what gets stretched; the <strong>purple lines</strong> mark the edges of that selection.</p>
      <ul><li><strong>Drag</strong>: select a new part.</li>
      <li><strong>Drag an edge</strong>: adjust the start or end.</li>
      <li><strong>Click</strong>: jump to that point.</li>
      <li><strong>Double-click</strong>: select the whole file again.</li></ul>
      <p>The <strong>white line</strong> shows where you are in the original. With a large stretch it moves very slowly.</p>`,
  },
  {
    id: 'spectrum', title: 'Spectrum',
    shot: spectrumShot,
    html: `<p>A live view of the frequencies you hear: low on the left, high on the right. Useful for seeing what the spectral modules do.</p>`,
  },
  {
    id: 'stretch', title: 'Stretch amount',
    shot: () => ctl('stretch'),
    html: `<p>How many times longer the sound becomes. <strong>×8</strong> turns 4 seconds into 32 seconds. It goes up to <strong>×10,000</strong>, which turns one second into almost three hours.</p>
      <p>Below the slider you can see how long your selection will become. Values below ×1 speed the sound up instead.</p>`,
  },
  {
    id: 'windowSize', title: 'Window size',
    shot: windowSizeShot,
    html: `<p>The length of each chunk of audio that is analysed at a time. This is the most important setting for the sound.</p>
      <ul><li><strong>Small</strong> (about 10–90 ms): rhythm and attacks stay more recognisable, but it sounds grainier.</li>
      <li><strong>Large</strong> (about 0.7–20 s): a smooth, hazy ambient sound with pure pitches; attacks disappear.</li></ul>
      <p><strong>Rule of thumb:</strong> 0.1–0.3 s to keep speech or melody recognisable, 0.5–2 s for ambient pads and drones.</p>
      <p>With a large window, settings respond more slowly because a whole window is calculated ahead.</p>`,
  },
  {
    id: 'windowShape', title: 'Window shape',
    shot: windowShapeShot,
    html: `<p>The fade-in/fade-out applied to each chunk before analysis. Without a fade, the edges create hard jumps that add false frequencies.</p>
      <ul><li><strong>Rectangular</strong>: no fade; sounds noisier and harsher.</li>
      <li><strong>Hamming / Hann</strong>: the standard choice, a good balance.</li>
      <li><strong>Blackman / Blackman-Harris</strong>: the purest tones, with slightly wider peaks.</li></ul>
      <p>The difference is subtle. It's most audible with pure tones and small windows.</p>`,
  },
  {
    id: 'onset', title: 'Onset detection',
    shot: onsetShot,
    html: `<p>Detects attacks (a drum hit, a piano key, the start of a word) from a sudden rise of energy in the spectrum.</p>
      <p>At an attack, the play position jumps straight to it instead of slowly smearing through it, and makes up the time afterwards. That keeps attacks and rhythm partly recognisable.</p>
      <p>The value is the <strong>sensitivity</strong>: <em>off</em> disables it, and higher values react to more and softer attacks. Works best with percussive material and smaller windows.</p>`,
  },
  {
    id: 'volume', title: 'Volume and options',
    shot: () => shot(cloneEl(document.querySelector('[data-help="volume"]')), cloneEl(document.querySelector('[data-help="toggles"]'))),
    html: `<p><strong>Volume</strong>: output level in dB; responds immediately.</p>
      <ul><li><strong>Freeze</strong>: the play position stops and the current moment sustains endlessly.</li>
      <li><strong>Loop</strong>: starts again at the end of the selection. When off, playback stops at the end.</li>
      <li><strong>Mono → wide stereo</strong>: for a mono file, each side gets its own random phases, which gives a wide stereo sound.</li></ul>`,
  },
  {
    id: 'modules', title: 'Spectral modules',
    shot: () => moduleShot('pitchShift'),
    html: `<p>Processing applied to the spectrum, run from top to bottom. The checkbox turns a module on; ▲▼ change the order.</p>
      <ul><li><strong>Harmonics</strong>: keeps only a harmonic series, turning noise into a pitched drone.</li>
      <li><strong>Pitch shift</strong>: shifts everything by semitones.</li>
      <li><strong>Frequency shift</strong>: adds a fixed number of Hz; sounds metallic and inharmonic.</li>
      <li><strong>Spread</strong>: widens each tone into a narrow band of noise.</li>
      <li><strong>Tonal vs noise</strong>: positive keeps the tones, negative keeps the noise.</li>
      <li><strong>Filter</strong>: passes a frequency band, or blocks it (band stop).</li>
      <li><strong>Ratio mix</strong>: layers shifted copies on top, such as octaves.</li>
      <li><strong>Compressor</strong>: evens out the volume.</li></ul>`,
  },
  {
    id: 'render', title: 'Render to WAV',
    shot: () => shot(cloneEl(document.querySelector('.render'))),
    html: `<p>Creates a WAV file with the current settings, faster than real time. Choose the <strong>length</strong> in seconds (max. 600). By default it's the length of your stretched selection.</p>
      <p><strong>Normalise</strong> sets the loudest peak to −1 dBFS. Afterwards you can listen to the result and download it.</p>`,
  },
];

// ---------------------------------------------------------------- dialog

let wired = false;
export function openHelp() {
  const dlg = $('help');
  if (!wired) {
    wired = true;
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  }
  const nav = $('helpNav'), body = $('helpBody');
  nav.innerHTML = '';
  body.innerHTML = '';
  for (const s of SECTIONS) {
    const a = document.createElement('a');
    a.href = `#help-${s.id}`;
    a.textContent = s.title;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(`help-${s.id}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    nav.append(a);

    const sec = document.createElement('section');
    sec.className = 'help-sec';
    sec.id = `help-${s.id}`;
    const text = document.createElement('div');
    text.innerHTML = `<h3>${s.title}</h3>${s.html}`;
    sec.append(text, s.shot());
    if (s.wide) {
      const wide = document.createElement('div');
      wide.className = 'help-wide';
      wide.innerHTML = s.wide();
      sec.append(wide);
    }
    body.append(sec);
  }
  dlg.showModal();
  body.scrollTop = 0;
}
