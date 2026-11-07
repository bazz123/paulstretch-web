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

function orderShot() {
  const steps = [['Stretch', ''], ['Spectral 1–8', ''], ['EQ curve', ''], ['Binaural', 'fx'], ['EQ · Chorus · Reverb', 'fx'], ['Volume', ''], ['Output / file', '']];
  const box = document.createElement('div');
  box.className = 'order-flow';
  steps.forEach(([label, kind], i) => {
    const el = document.createElement('span');
    el.className = 'order-step' + (kind ? ' fx' : '');
    el.textContent = label;
    box.append(el);
    if (i < steps.length - 1) { const a = document.createElement('span'); a.className = 'order-arrow'; a.textContent = '→'; box.append(a); }
  });
  return shot(box);
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
    html: `<p>Pick a preset from the dropdown to load a ready-made sound. A preset sets the stretch, the spectral modules, the spectral EQ curve and all effects (binaural with its glide, EQ, chorus, reverb and shimmer). Your file, selection, volume, Loop and Mono → wide stereo stay as they are. Modules and effects a preset doesn't use are switched off.</p>
      <p>Presets saved with the earlier version (without effects) still load: their effects simply start switched off.</p>
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
    html: `<p>Processing applied to the spectrum inside the stretch, run in the order of cards 1–8, followed by the spectral EQ curve (9). The checkbox turns a module on; ▲▼ change the order. The effects (FX cards) are described in their own sections below.</p>
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
    id: 'order', title: 'Processing order',
    shot: orderShot,
    html: `<p>Every sound passes through the same chain, in this order, during playback and in exports:</p>
      <ol class="help-ol"><li><strong>Stretch engine</strong> (stretch amount, window, onset, freeze)</li>
      <li><strong>Spectral modules 1–8</strong>, in the order of the cards (▲▼)</li>
      <li><strong>Spectral EQ curve</strong> (module 9)</li>
      <li><strong>Binaural</strong>: always the first effect</li>
      <li><strong>EQ, Chorus, Reverb</strong>, in the order of their cards (▲▼ only moves them among themselves)</li>
      <li><strong>Volume</strong>, then the output or the file</li></ol>
      <p><strong>Why it matters:</strong> spectral modules (1–9) work inside the stretch, a little ahead of what you hear, so their changes arrive after a short delay (about one window plus 0.4 s). Effects (FX) run in the audio player itself and respond immediately.</p>
      <p>Binaural comes first so the effects after it can't blur the left/right frequency difference. EQ before reverb shapes what goes into the reverb; reverb before EQ shapes the tail too.</p>`,
  },
  {
    id: 'drawEq', title: 'Spectral EQ curve',
    shot: () => shot(cloneEl(document.querySelector('[data-module="drawEq"]'))),
    html: `<p>A freely drawn gain curve over the whole spectrum, inspired by PaulXStretch's free filter. It is spectral module 9: it shapes the stretched spectrum directly, after modules 1–8 and before the effects. The live output spectrum is shown underneath.</p>
      <ul><li><strong>Click</strong> an empty spot to add a point; <strong>drag</strong> a point to change its frequency and gain.</li>
      <li><strong>Double-click</strong> or <strong>right-click</strong> a point to remove it. <strong>Reset curve</strong> removes all points.</li>
      <li>Range: 20 Hz–20 kHz on a logarithmic axis, −36 to +12 dB. Up to 32 points. The curve is smoothed between points and stays flat beyond the outer ones.</li></ul>
      <p><strong>Start with:</strong> two or three points. <strong>Ambient:</strong> pull 3–8 kHz down 6–10 dB for a softer, darker pad. <strong>Drone:</strong> a narrow +6 dB bump on a resonance you like, with cuts on either side, turns a wash into a held note.</p>
      <p><strong>Limits:</strong> changes are heard after the stretch delay. Gain changes between closely spaced points are smoothed, so very narrow notches are softened. Not the same as the 3-band EQ, which is an effect after the stretch.</p>`,
  },
  {
    id: 'binauralOriginal', title: 'Binaural: shift the music',
    shot: () => shot(cloneEl(document.querySelector('[data-module="binaural"]'))),
    html: `<p><strong>Mode: Shift the music (PaulXStretch).</strong> A port of the original PaulXStretch method: each ear's signal is frequency-shifted by half the beat frequency, one ear up and the other down. A 6 Hz beat puts the two ears 6 Hz apart, so the beat lives inside the music rather than in an added tone.</p>
      <ul><li><strong>Beat frequency</strong> (0.5–30 Hz): the difference between the ears.</li>
      <li><strong>Direction</strong>: which ear goes up. <em>Symmetric</em> blends both directions.</li>
      <li><strong>Amount</strong>: how much of each ear is shared with the other before shifting (the original's "power"). Higher gives a clearer beat and a narrower image.</li></ul>
      <p><strong>Start with:</strong> 4–8 Hz, Amount 50%. <strong>Example:</strong> a stretched pad at 6 Hz under a long reverb.</p>
      <p><strong>Why headphones:</strong> the beat only appears when each ear hears its own frequency. Through speakers both signals reach both ears and mix in the air, so you hear a faint wobble or nothing at all. Binaural beats are a listening effect, not a medical treatment, and no specific effect on the brain is promised.</p>
      <p><strong>Limits:</strong> frequency shifting moves all partials by the same number of Hz, so very low notes can sound slightly detuned at high beat values. Always produces stereo output, even for mono files.</p>`,
  },
  {
    id: 'binauralTones', title: 'Binaural: tone generator',
    shot: () => shot(cloneEl(document.querySelector('[data-module="binaural"]'))),
    html: `<p><strong>Mode: Tone generator</strong> adds two pure sine tones under the music: the left at carrier − beat/2, the right at carrier + beat/2. <strong>Both</strong> combines the tones with the music shift.</p>
      <ul><li><strong>Carrier frequency</strong> (40–1000 Hz): the pitch of the tones.</li>
      <li><strong>Beat frequency</strong>: the difference between left and right.</li>
      <li><strong>Tone level</strong>: how loud the tones are under the music.</li></ul>
      <p><strong>Start with:</strong> carrier 150–250 Hz, level 15–25%. Choose a carrier that sits in key with your material (for example 220 Hz for A), so the tone blends in as a drone note.</p>
      <p><strong>Limits:</strong> headphones required, as above. Carriers above about 1 kHz make the beat hard to hear, so the range stops there.</p>`,
  },
  {
    id: 'binauralGlide', title: 'Binaural glide',
    shot: () => shot(cloneEl(document.querySelector('[data-module="binaural"]'))),
    html: `<p>Moves the beat frequency smoothly from one value to another. When glide is on, it replaces the fixed Beat frequency.</p>
      <ul><li><strong>Start beat / End beat</strong>: the two beat frequencies.</li>
      <li><strong>Direction of glide</strong>: <em>Increasing</em> goes from the lower to the higher value, <em>Decreasing</em> from the higher to the lower, whichever slider holds which.</li>
      <li><strong>Glide duration</strong> (10 s–3 h): after this time the beat stays at the final value.</li>
      <li><strong>Curve</strong>: <em>Linear</em> changes by the same Hz per minute; <em>Exponential</em> changes by the same ratio per minute, which sounds more even.</li></ul>
      <p><strong>Timeline:</strong> in playback the glide starts when you press Play; in an export it starts at the beginning of the file. The same settings give the same glide in both. Seeking in the waveform does not restart it.</p>
      <p><strong>Example:</strong> 10 → 6 Hz, exponential, over 20 minutes for a slowly settling ambient piece.</p>`,
  },
  {
    id: 'eq3', title: 'EQ (3-band)',
    shot: () => shot(cloneEl(document.querySelector('[data-module="eq3"]'))),
    html: `<p>A conventional tone control after the stretch: a low shelf at 250 Hz, an adjustable mid band and a high shelf at 4 kHz. The graph shows the combined response.</p>
      <ul><li><strong>Low / Mid / High</strong>: ±12 dB per band.</li>
      <li><strong>Mid frequency</strong> (100 Hz–8 kHz) and <strong>Mid width (Q)</strong>: low Q is broad and gentle, high Q is narrow.</li></ul>
      <p><strong>Start with:</strong> small moves of 1–3 dB. <strong>Ambient:</strong> high −2 dB and low +1.5 dB for a warmer pad. <strong>Drone:</strong> mid −3 dB around 400–600 Hz to clear muddiness under a reverb.</p>
      <p><strong>Limits:</strong> shelf frequencies are fixed. Boosts add level; turn the volume down or use Normalise when exporting.</p>`,
  },
  {
    id: 'chorus', title: 'Chorus',
    shot: () => shot(cloneEl(document.querySelector('[data-module="chorus"]'))),
    html: `<p>Adds up to four slightly delayed copies per side whose delay drifts slowly, which widens and animates the sound. Each copy drifts at a slightly different speed so the movement never repeats exactly. Left and right are processed separately and are never mixed.</p>
      <ul><li><strong>Rate</strong> (0.05–5 Hz): speed of the drift.</li>
      <li><strong>Depth</strong>: how far the delay moves; more depth means more pitch wobble.</li>
      <li><strong>Voices</strong> (1–4): number of copies.</li>
      <li><strong>Stereo spread</strong>: how differently the two sides move; higher is wider.</li>
      <li><strong>Mix</strong>: the balance between the original and the copies.</li></ul>
      <p><strong>Start with:</strong> 3 voices, 0.2 Hz, depth 60%, spread 80%, mix 30%. <strong>Drone:</strong> 0.05–0.1 Hz and mix 15–20% for movement you feel more than hear.</p>
      <p><strong>Limits:</strong> above about 1 Hz with high depth it becomes an audible vibrato. With spread at 0 the movement is identical on both sides and adds no width.</p>`,
  },
  {
    id: 'reverb', title: 'Reverb',
    shot: () => shot(cloneEl(document.querySelector('[data-module="reverb"]'))),
    html: `<p>An algorithmic reverb (a network of eight feedback delay lines per side) tuned for smooth, dense ambient tails. Each side has its own network, so the stereo image, and any binaural beat, is kept.</p>
      <ul><li><strong>Size</strong>: the spacing of the reflections, from small room to huge hall.</li>
      <li><strong>Decay</strong> (0.5–30 s): time for the tail to fall by 60 dB.</li>
      <li><strong>Damping</strong>: how fast the highs die away compared with the lows.</li>
      <li><strong>Pre-delay</strong> (0–250 ms): a gap before the reverb starts, which keeps the dry sound clear.</li>
      <li><strong>Width</strong>: 100% keeps left and right fully separate; 0% makes the reverb mono.</li>
      <li><strong>Mix</strong>: the balance between dry and reverb.</li></ul>
      <p><strong>Start with:</strong> size 70%, decay 8 s, damping 50%, pre-delay 20 ms, mix 35%. <strong>Ambient:</strong> 10–15 s decay at 40% mix. <strong>Drone:</strong> 20–30 s decay, large size, damping 55% so the tail darkens as it fades.</p>
      <p><strong>Limits:</strong> lowering Width below 100% mixes the reverb between the ears, which weakens binaural beats in the tail. Changing Size glides smoothly over a fraction of a second rather than jumping.</p>`,
  },
  {
    id: 'shimmer', title: 'Shimmer',
    shot: () => shot(cloneEl(document.querySelector('[data-module="reverb"]'))),
    html: `<p>Shimmer sends the reverb tail through an octave-up pitch shifter and back into the reverb. Each pass adds another octave, so the tail grows a soft, choir-like halo above the sound.</p>
      <ul><li><strong>Shimmer</strong>: on or off; switching fades smoothly.</li>
      <li><strong>Shimmer amount</strong>: how much of the shifted signal is fed back.</li></ul>
      <p><strong>Start with:</strong> 25–35% with a decay of 8 s or more and damping around 50%. <strong>Ambient:</strong> 35% on a pad gives a bright halo. <strong>Drone:</strong> 10–15% for a barely noticeable upper glow.</p>
      <p><strong>Limits:</strong> the shimmer path is soft-limited and the decay is shortened slightly while it is on, so it cannot run away; very high amounts with long decays can still get bright, so pair them with more damping.</p>`,
  },
  {
    id: 'capture', title: 'Capture a sound',
    shot: () => shot(cloneEl(document.querySelector('#capturePanel .capture'))),
    html: `<p>Freezes one moment of your source and exports it as a sound for your DAW or sampler, with all current spectral modules and effects.</p>
      <ol class="help-ol"><li>Click in the waveform where the sound should come from (or let it play there). Turning on <strong>Freeze</strong> lets you hear the moment first.</li>
      <li>Press <strong>◉ Capture moment</strong> above the waveform. An amber line marks the spot; the panel shows its spectrum and the <strong>detected pitch</strong>.</li>
      <li>Choose <strong>One-shot</strong>, <strong>Loop</strong> or <strong>Long drone</strong>, press <strong>▶ Listen</strong> to audition, then <strong>Export WAV</strong>.</li></ol>
      <ul><li><strong>One-shot</strong>: a note with a length (1–60 s), attack and release; reverb and chorus tails ring out after it.</li>
      <li><strong>Loop</strong>: repeats without a seam. Set the length in seconds or as bars at a BPM for tempo-synced loops (max 60 s). The effects are pre-rolled so the reverb tail wraps around; chorus, reverb movement and binaural beats are nudged by a tiny amount so they complete whole cycles in the loop. A binaural glide is held at its start value.</li>
      <li><strong>Long drone</strong>: up to 3 hours from the captured moment. It keeps evolving gently and never repeats; streamed to disk like a normal export.</li></ul>
      <p><strong>In your DAW:</strong> files are 24-bit by default (16-bit optional). The detected root note and fine tuning, and for loops the loop points, are written into the file's sampler data, so Ableton Simpler/Sampler, Kontakt, Logic Sampler and similar map and loop it automatically. The note is also in the filename, for example <em>Pad - A2 +12c - loop 8s.wav</em>. Sounds without a clear pitch get root note C4.</p>
      <p><strong>Tips:</strong> a larger window gives purer, more tonal captures; a small window gives grittier ones. <strong>Harmonics</strong> turns a noisy moment into a clean pitched tone, and the <strong>Spectral EQ curve</strong> shapes it. Changing settings after capturing is fine: Listen and Export always use the current settings.</p>
      <p><strong>Limits:</strong> pitch detection works best on tonal sounds and larger windows; very short windows (under about 170 ms) make low notes less accurate. Loops shorter than about 2 s can sound repetitive.</p>`,
  },
  {
    id: 'render', title: 'Export behaviour',
    shot: () => shot(cloneEl(document.querySelector('.render'))),
    html: `<p><strong>Render</strong> creates a 16-bit stereo WAV with exactly the same processing as playback: the same engine, spectral modules, EQ curve, effects and volume. It runs in the background and streams to disk as it goes, so even a 3-hour export (about 2 GB) needs little memory.</p>
      <ul><li><strong>Length</strong> (up to 3 h): how much stretched audio to render. It starts at your selection's stretched length.</li>
      <li><strong>Ending:</strong> the last 3 seconds of the stretched audio fade out, then reverb and chorus tails ring out until they are silent. The file is therefore a little longer than the length you set.</li>
      <li><strong>Normalise</strong> sets the loudest peak to −1 dBFS. It renders twice, once to measure and once to write, so it takes twice as long. Without it the Volume setting is used and very loud peaks may clip.</li>
      <li>Progress shows an estimate of the time left; <strong>Cancel</strong> stops it at once.</li></ul>
      <p><strong>Start with:</strong> Normalise on. <strong>Long drones:</strong> render a short test first, then the full length.</p>
      <p><strong>Limits:</strong> the binaural glide starts at 0 in the file. Exports longer than 20 minutes show a download link but no preview player. Keep the tab open while it renders. Files are kept in the browser's private storage until the next export.</p>`,
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
