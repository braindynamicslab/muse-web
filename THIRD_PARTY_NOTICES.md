# Third-party notices

Brain Dynamics Lab (muse-web) is MIT-licensed (see `LICENSE`). It adapts code from, and depends on, the
following projects. Their notices are reproduced or linked here as their licenses require.

## nouscope — adapted source (MIT)

https://github.com/soundtrip-health/nouscope

Adapted into this repository: `src/sim.js` (the simulated Muse) and the EEG band-power and PPG heart-rate
pipeline in `src/dsp.js` (Morlet-wavelet band powers, aperiodic 1/f normalisation, quality-weighted channel
averaging, MSPTDfast heart-rate detection), plus the overall trace/spectrogram approach. Written by Bob Dougherty
and Soundtrip LLC; nouscope itself includes portions from Codrops / Tiago Canzian.

```
MIT License

Copyright 2025 Soundtrip LLC — portions Copyright 2022 Codrops / Tiago Canzian

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## muse-js — runtime dependency, bundled in the built site (MIT)

Web Bluetooth client for Muse headsets. We use the Soundtrip fork (branch `muse3`, adds Muse S Athena and
fixes): https://github.com/soundtrip-health/muse-js — forked from https://github.com/urish/muse-js

```
The MIT License (MIT)

Copyright (c) 2017 Uri Shaked and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## RxJS — runtime dependency, bundled in the built site (Apache-2.0)

https://github.com/ReactiveX/rxjs — Copyright (c) 2015–present Google, Inc., Netflix, Inc., Microsoft Corp.
and contributors. Licensed under the Apache License, Version 2.0: https://www.apache.org/licenses/LICENSE-2.0

## Brain Dynamics Lab muse-lsl — specification (same lab)

The signal-quality "horseshoe index" in `src/quality.js` (peak-to-peak amplitude, muscle ratio, line noise,
saturation, drift; thresholds and hysteresis) re-implements the specification used in the lab's muse-lsl
research app, so class numbers match research numbers.

## Methods

The algorithms above come from the published literature; nouscope's `docs/algorithms.md` lists the full
references. Principal ones:

- Seymour, R. A., Alexander, N., & Maguire, E. A. (2022). Robust estimation of 1/f activity improves oscillatory
  burst detection. *European Journal of Neuroscience* (fBOSC — aperiodic background fit).
- Whitten, T. A., Hughes, A. M., Dickson, C. T., & Caplan, J. B. (2011). A better oscillation detection method
  robustly extracts EEG rhythms across brain state changes. *NeuroImage* (BOSC — Morlet wavelet power).
- Bishop, S. M., & Ercole, A. (2018). Multi-scale peak and trough detection optimised for periodic and
  quasi-periodic neuroscience data. (MSPTD) — and Charlton, P. H. et al. (MSPTDfast, 2024), the faster variant used
  by nouscope for pulse detection.

## Trademark

Muse™ is a trademark of Interaxon Inc. This project is independent and is not affiliated with, endorsed by, or
sponsored by Interaxon.
