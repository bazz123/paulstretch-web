# PaulStretch Web — FX version

The PaulStretch Web app extended with an effects section and long streamed
exports. Same stretch engine, spectral modules, presets and help as the base
version, plus:

- **Binaural beats**: port of the PaulXStretch method (shifts the music
  between the ears), a separate tone generator, or both; optional beat glide.
- **3-band EQ** with a response graph.
- **Chorus**: up to 4 voices, per channel, no left/right mixing.
- **Reverb**: 8-line feedback delay network per channel, with **Shimmer**.
- **Spectral EQ curve**: a drawable gain curve as spectral module 9.
- **Streamed WAV export up to 3 hours**, with effect tails and two-pass
  normalise.

## Run

```bash
python3 -m http.server 8766
```

Then open http://localhost:8766.

## Test

```bash
node --test test/
```

## Signal chain

Stretch engine → spectral modules 1–8 → spectral EQ curve → Binaural →
EQ / Chorus / Reverb (reorderable among themselves) → Volume → output or file.

## Architecture

| File | Role |
|---|---|
| `src/dsp.js` | FFT, stretcher, spectral modules, spectral EQ curve, `Engine` |
| `src/effects.js` | Shared effects (`FxChain`): binaural, EQ, chorus, reverb + shimmer. No browser APIs; block-size invariant |
| `src/engine-worker.js` | Runs the engine ahead of playback and streams frames to the player |
| `src/player-worklet.js` | AudioWorklet: plays frames and runs `FxChain` live, so effect changes are immediate |
| `src/render-pipeline.js` | Export pipeline: engine → `FxChain` → volume, block by block, end fade and tails |
| `src/render-worker.js` | Export worker: streams 16-bit WAV to the browser's private file storage (OPFS) |
| `src/presets.js` | Versioned presets (v2 adds effects and the EQ curve; v1 presets still load) |
| `src/app.js`, `src/help.js` | Interface and help page |

Live playback and export use the same `FxChain` code. Every parameter is
smoothed per sample and periodic updates are keyed to an absolute sample
counter, so 128-sample worklet blocks and large export chunks produce the same
output (tested to within 1e-5).

## Limits

- Spectral modules (1–9) are heard after the stretch prebuffer delay; effects
  respond immediately.
- WAV is limited to 4 GB: 3 hours of 16-bit stereo fits at 44.1/48 kHz.
- Normalise renders twice, so it doubles the export time.
- Not ported from PaulXStretch: binaural beats following the input position
  (here the glide follows playback/export time), live input capture,
  plugin formats.

GPLv3, inherited from PaulXStretch / PaulStretch.
