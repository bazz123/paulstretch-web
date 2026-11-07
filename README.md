# PaulStretch Web

**▶ Try it online: https://bazz123.github.io/paulstretch-web/**

A from-scratch browser reimplementation of [PaulXStretch](https://github.com/essej/paulxstretch):
extreme time stretching based on the PaulStretch algorithm by Nasca Octavian Paul,
with the PaulXStretch spectral modules. Plain HTML/JS, no build step, no dependencies.

Capture a sound
Freeze any moment of your audio and turn it into a sound for your DAW. Click a spot in the waveform, press ◉ Capture moment, and export it in one of three forms:

One-shot: a note with its own length, attack and release, with the reverb tail ringing out.
Seamless loop: repeats without a click. Set the length in seconds or as bars at a BPM, so it fits your track’s tempo.
Long drone: up to 3 hours that keeps evolving gently and never repeats.
Everything you hear is included: spectral modules, EQ curve, reverb, chorus and binaural effects. The app detects the pitch and writes the root note and loop points into the 24-bit WAV, so samplers like Ableton, Kontakt and Logic map and loop it automatically.

| Folder | What it is |
|---|---|
| [`paulstretch-web/`](paulstretch-web/) ([open](https://bazz123.github.io/paulstretch-web/paulstretch-web/)) | The core app: stretch engine, 8 spectral modules, presets, help page, WAV export |
| [`paulstretch-web-fx/`](paulstretch-web-fx/) ([open](https://bazz123.github.io/paulstretch-web/paulstretch-web-fx/)) | Extended version: binaural beats (with glide), 3-band EQ, chorus, reverb with shimmer, drawable spectral EQ curve, streamed WAV export up to 3 hours |

## Run locally

Workers and AudioWorklets need HTTP, so serve a folder locally:

```bash
python3 -m http.server 8765 --directory paulstretch-web
```

```bash
python3 -m http.server 8766 --directory paulstretch-web-fx
```

Then open http://localhost:8765 or http://localhost:8766.

## Test

```bash
cd paulstretch-web-fx && node --test test/
```

## License

GPLv3, inherited from PaulXStretch and PaulStretch. See [LICENSE](LICENSE).

Algorithm by Nasca Octavian Paul (PaulStretch); spectral modules after PaulXStretch by Xenakios and Jesse Chappell.
