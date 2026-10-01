# Brain Dynamics Lab — Muse web lab

A browser app for exploring EEG with a **Muse 2 / Muse S** headset. Built for **PSYC 20N** (Stanford) so
undergraduates can connect a headset, see live EEG, learn what good contact and artifacts look like, run simple
one-variable experiments, and compare conditions. No install, no accounts, **no data leaves your computer**.

**Use it:** https://braindynamicslab.github.io/muse-web/ (Chrome or Edge — Safari/Firefox don't support Web Bluetooth).
No headset? Click **Practice** for a simulated Muse.

## Features
- Live 4-channel EEG (TP9, AF7, AF8, TP10) with a contact-quality indicator for each sensor (muse-lsl "horseshoe"
  index: amplitude, muscle, line noise, clipping, drift) and plain-language fit hints
- Band power over time (theta, alpha, beta, gamma, optional delta) using nouscope's 1/f-corrected wavelet pipeline
- Optional layers: spectrogram, pulse (PPG, heart rate), head motion (accelerometer); battery level
- Experiment blocks: choose a condition, **Start** / **Stop**; per-condition band summary and A-vs-B spectrum comparison
- One-click **.zip** download: raw EEG, band shares, signal quality, accelerometer, PPG, block times (CSV)
- URL flag `?layers=bands,spectrogram,ppg,motion` fixes which layers are shown (instructors can control a week's view);
  `?sim=auto` starts Practice mode on load

## Run locally
```bash
npm install
npm run dev      # http://localhost:5173  (Node 20.19+ or 22.12+)
npm run build    # static site in dist/
```
Web Bluetooth needs HTTPS or `localhost`. Deploy `dist/` to any static host.

## Scope
Teaching and demos. It is **not** a research data-collection tool: browser tabs can throttle or drop data on sleep,
timestamps are packet-arrival times, and there is no LSL/trigger synchronization.

## Credits
Built on [nouscope](https://github.com/soundtrip-health/nouscope) (Bob Dougherty / Soundtrip LLC) and
[muse-js](https://github.com/soundtrip-health/muse-js) (Uri Shaked; Soundtrip fork), with signal-quality methods from
the Brain Dynamics Lab's muse-lsl app. Full notices and references: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
Muse™ is a trademark of Interaxon Inc.; this project is not affiliated with Interaxon.

## License
[MIT](LICENSE) © 2026 Manish Saggar, Brain Dynamics Lab.
