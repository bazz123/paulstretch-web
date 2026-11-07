# PaulStretch Web

A from-scratch browser reimplementation of [PaulXStretch](https://github.com/essej/paulxstretch):
extreme time stretching (PaulStretch algorithm by Nasca Octavian Paul) plus the PaulXStretch
spectral modules. No build step, no dependencies.

## Run

Workers and AudioWorklets need HTTP (not `file://`):

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765.

## Test

```bash
node --test test/
```

## Architecture

| File | Role | Original counterpart |
|---|---|---|
| `src/dsp.js` | Real FFT, `Stretcher` (one channel), spectral modules, `Engine` (file reader, looping, onsets) | `Stretch.cpp`, `ProcessedStretch.*`, `StretchSource.cpp` |
| `src/engine-worker.js` | Runs the engine ahead of playback; offline render | prebuffering `TimeSliceThread`, offline render thread pool |
| `src/player-worklet.js` | Plays queued frames on the audio thread | `processBlock` reading the ring buffer |
| `src/app.js` | UI, waveform/range, spectrum, WAV export | `PluginEditor.cpp` |
| `src/wav.js` | 16-bit WAV encoder with dither and normalisation | JUCE `WavAudioFormat` |

The worker and worklet talk directly over a `MessageChannel`. The worker keeps
about `bufsize + 0.4 s` of audio queued, so parameter changes are heard after
that latency (same trade-off as the original's prebuffer).

## Not ported

Free-draw filter envelope, binaural beats, live input capture, multichannel (>2),
plugin formats, and per-parameter automation.

## License

GPLv3, inherited from PaulXStretch / PaulStretch.
