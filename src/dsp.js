// Signal processing ported from nouscope (MIT, Soundtrip LLC / Bob Dougherty):
//   https://github.com/soundtrip-health/nouscope  (src/js/managers/EEGManager.js, docs/algorithms.md §3, §4, §6)
// Kept numerically identical to nouscope except where marked "DEVIATION" (also: the spectrogram / absolute-power
// spectrum removes each window's mean first, so DC offset and slow drift don't leak into delta).
//
// EEG: raw µV (no filtering — same as nouscope) → per-channel RMS quality → 256-sample windows every 128
//      samples → delta by Hann-DFT (bins 1–3), theta/alpha/beta/gamma by Morlet wavelet power → quality-weighted
//      channel average (up to 2 bad channels dropped) → 1/f (aperiodic) model fit → divide by expected power →
//      relative shares summing to 1 → EMA smoothing.
// PPG: 0.5 Hz high-pass → 3.5 Hz low-pass → 6 s window → MSPTDfast v2 peak detection → median IBI → BPM.

export const EEG_FS = 256
const EEG_BUF = 256
export const BANDS = ['delta', 'theta', 'alpha', 'beta', 'gamma']
const WAVELET_FREQS = { theta: 6, alpha: 10, beta: 20, gamma: 40 }
const TAU = 6, TAU_THETA = 4
const DFT_BINS = [1, 2, 3]
const AP_FIT_FREQS = [6, 10, 20, 40]
const AP_FIT_BANDS = ['theta', 'alpha', 'beta', 'gamma']
const AP_UPDATE_INTERVAL = 10, AP_SMOOTH = 0.3, AP_MIN_REFITS = 3
const BAND_SMOOTH = 0.35
const BAND_FREQ = { delta: 2, theta: 6, alpha: 10, beta: 20, gamma: 40 }
export const SPEC_BINS = 80           // DEVIATION: nouscope uses 50. 80 Hz so jaw/muscle (EMG) activity above 40 Hz is visible; 1 Hz bins
const SQ_WIN = 256, SQ_LOW = 50, SQ_HIGH = 100
const MARGINAL_WEIGHT = 0.5

export class BandPipeline {
  // Which bands take part in the relative-power normalisation. nouscope default excludes delta (movement-prone).
  normalizeBands = new Set(['theta', 'alpha', 'beta', 'gamma'])
  bandPower = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
  quality = ['poor', 'poor', 'poor', 'poor']
  rms = [0, 0, 0, 0]
  weights = [0, 0, 0, 0]
  onBands = null     // (bandPower, ready) each analysis window (~2 Hz)
  onColumn = null    // (Float32Array log10 power, bins 1..SPEC_BINS)
  // Which electrodes feed band power, spectrogram and comparisons:
  //   'weighted'  — quality-weighted average, poor channels dropped (nouscope/HSI behaviour; default)
  //   'posterior' — TP9 + TP10 (behind the ears; closest to the posterior alpha rhythm), quality ignored
  //   'frontal'   — AF7 + AF8, quality ignored
  //   'all'       — all four, equal weights, quality ignored
  //   'tp9' | 'tp10' | 'af7' | 'af8' — a single electrode, quality ignored
  channelMode = 'weighted'
  bandAbs = { delta: -99, theta: -99, alpha: -99, beta: -99, gamma: -99 }   // absolute band power, dB re 1 µV²
  useExternalQuality = false   // true: `quality` is set from outside (muse-lsl HSI) instead of nouscope's RMS rule

  constructor() {
    this._reset()
    this._kernels()
  }
  _reset() {
    this._buf = [0, 1, 2, 3].map(() => new Float32Array(EEG_BUF))   // circular analysis windows
    this._n = 0
    this._sq = 0; this._an = 0
    this._ap = { a: 0, b: -1.5 }; this._apWin = 0; this._apRefits = 0
    for (const b of BANDS) { this.bandPower[b] = 0; this.bandAbs[b] = -99 }
    this._absInit = false
    this.quality = ['poor', 'poor', 'poor', 'poor']
  }
  reset() { this._reset() }
  get ready() { return this._apRefits >= AP_MIN_REFITS }
  /** Seconds of warm-up left before band values appear (≈ AP_MIN_REFITS refits × 5 s). */
  get warmupFraction() { return Math.min(1, (this._apRefits * AP_UPDATE_INTERVAL + this._apWin) / (AP_MIN_REFITS * AP_UPDATE_INTERVAL)) }

  /** Feed one raw 4-channel sample (µV). NaN → 0, as in nouscope. */
  push(d) {
    const i = this._n % EEG_BUF
    for (let c = 0; c < 4; c++) this._buf[c][i] = Number.isNaN(d[c]) ? 0 : d[c]
    this._n++
    if (++this._sq >= 64) { this._sq = 0; if (!this.useExternalQuality) this._updateQuality() }
    if (++this._an >= EEG_BUF / 2) {
      this._an = 0
      if (this._n >= EEG_BUF) this._compute()
    }
  }
  _win(c) {   // chronological 256-sample window
    const out = new Float32Array(EEG_BUF), b = this._buf[c], n = this._n
    for (let k = 0; k < EEG_BUF; k++) out[k] = b[(n - EEG_BUF + k) % EEG_BUF]
    return out
  }
  _updateQuality() {
    const n = Math.min(this._n, SQ_WIN)
    if (n < 10) return
    for (let c = 0; c < 4; c++) {
      const w = this._win(c).subarray(EEG_BUF - n)
      let m = 0; for (const v of w) m += v; m /= n
      let s = 0; for (const v of w) s += (v - m) ** 2
      const rms = Math.sqrt(s / n)
      this.rms[c] = rms
      // DEVIATION: rms < 0.5 µV (flat line = no signal / sensor not connected) is 'poor'; nouscope calls it 'good'.
      this.quality[c] = rms < 0.5 ? 'poor' : rms < SQ_LOW ? 'good' : rms < SQ_HIGH ? 'marginal' : 'poor'
    }
  }
  _weights() {
    const single = { tp9: 0, af7: 1, af8: 2, tp10: 3 }[this.channelMode]
    if (single !== undefined) { const w = [0, 0, 0, 0]; w[single] = 1; return w }
    if (this.channelMode === 'posterior') return [0.5, 0, 0, 0.5]
    if (this.channelMode === 'frontal') return [0, 0.5, 0.5, 0]
    if (this.channelMode === 'all') return [0.25, 0.25, 0.25, 0.25]
    const SCORE = { good: 2, marginal: 1, poor: 0 }
    const W = { good: 1, marginal: MARGINAL_WEIGHT, poor: 0 }
    const cand = [0, 1, 2, 3].filter((c) => SCORE[this.quality[c]] <= 0).sort((a, b) => SCORE[this.quality[a]] - SCORE[this.quality[b]])
    const dropped = new Set(cand.slice(0, 2))
    const w = this.quality.map((q, c) => (dropped.has(c) ? 0 : W[q]))
    const tot = w.reduce((a, b) => a + b, 0)
    if (tot > 0) return w.map((x) => x / tot)
    const active = [0, 1, 2, 3].filter((c) => !dropped.has(c))
    const f = [0, 0, 0, 0]; for (const c of active) f[c] = 1 / active.length
    return f
  }
  _compute() {
    const wins = [0, 1, 2, 3].map((c) => this._win(c))
    const chBands = wins.map((s) => this._channelBands(s))
    const w = this._weights(); this.weights = w
    const tw = w.reduce((a, b) => a + b, 0)
    const raw = {}
    for (const b of BANDS) { let s = 0; for (let c = 0; c < 4; c++) s += chBands[c][b] * w[c]; raw[b] = tw > 0 ? s / tw : 0 }
    if (++this._apWin >= AP_UPDATE_INTERVAL) { this._apWin = 0; this._refit(chBands, w, tw) }
    const res = this._normalize(raw)
    for (const b of BANDS) this.bandPower[b] += BAND_SMOOTH * (res[b] - this.bandPower[b])
    // spectrogram column (same weights)
    if (tw > 0) {
      const col = new Float32Array(SPEC_BINS), lin = new Float64Array(SPEC_BINS)
      const means = wins.map((x) => { let t = 0; for (const v of x) t += v; return t / EEG_BUF })   // DEVIATION: remove DC so it can't leak into the 1–3 Hz bins
      for (let k = 1; k <= SPEC_BINS; k++) {
        const { re, im } = this._dft[k]; let p = 0
        for (let c = 0; c < 4; c++) {
          if (w[c] === 0) continue
          let r = 0, m = 0; const s = wins[c], mu = means[c]
          for (let n = 0; n < EEG_BUF; n++) { const v = s[n] - mu; r += re[n] * v; m += im[n] * v }
          p += (r * r + m * m) * w[c]
        }
        lin[k - 1] = p / tw
        col[k - 1] = Math.log10(lin[k - 1] + 1e-10)
      }
      // Absolute band power (µV², shown in dB): sum of 1 Hz PSD bins. PSD = |X|²·2/(fs·Σw²) for a Hann window.
      const SC = 2 / (EEG_FS * this._hannSS)
      const sum = (a, b) => { let t = 0; for (let k = a; k <= b; k++) t += lin[k - 1]; return t * SC }
      const edges = { delta: [1, 3], theta: [4, 7], alpha: [8, 12], beta: [13, 29], gamma: [30, 40] }
      for (const b of BANDS) {
        const db = 10 * Math.log10(Math.max(sum(...edges[b]), 1e-9))
        this.bandAbs[b] = this._absInit ? this.bandAbs[b] + BAND_SMOOTH * (db - this.bandAbs[b]) : db
      }
      this._absInit = true
      this.onColumn?.(col)
    }
    this.onBands?.(this.bandPower, this.ready, this.bandAbs)
  }
  _channelBands(sig) {
    let delta = 0
    for (const k of DFT_BINS) {
      const { re, im } = this._dft[k]; let r = 0, m = 0
      for (let n = 0; n < EEG_BUF; n++) { r += re[n] * sig[n]; m += im[n] * sig[n] }
      delta += r * r + m * m
    }
    return { delta, theta: this._wav(sig, 'theta'), alpha: this._wav(sig, 'alpha'), beta: this._wav(sig, 'beta'), gamma: this._wav(sig, 'gamma') }
  }
  _wav(sig, band) {
    const { re, im, half } = this._wavelets[band], N = sig.length, kl = re.length
    const start = half, end = N - 1 - half
    if (start > end) return 0
    let tot = 0, cnt = 0
    for (let i = start; i <= end; i++) {
      let r = 0, m = 0; const base = i - half
      for (let k = 0; k < kl; k++) { const s = sig[base + k]; r += re[k] * s; m += im[k] * s }
      tot += r * r + m * m; cnt++
    }
    return cnt ? tot / cnt : 0
  }
  _refit(chBands, w, tw) {
    if (tw === 0) return
    const xs = AP_FIT_FREQS.map(Math.log10)
    const ys = AP_FIT_BANDS.map((b) => { let s = 0; for (let c = 0; c < 4; c++) s += chBands[c][b] * w[c]; const p = s / tw; return p > 0 ? Math.log10(p) : -10 })
    const n = xs.length; let sx = 0, sy = 0, sxx = 0, sxy = 0
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i] }
    const den = n * sxx - sx * sx
    const b = Math.abs(den) < 1e-12 ? 0 : (n * sxy - sx * sy) / den
    const a = Math.abs(den) < 1e-12 ? sy / n : (sy - b * sx) / n
    const sm = this._apRefits === 0 ? 1 : AP_SMOOTH
    this._ap.a = (1 - sm) * this._ap.a + sm * a
    this._ap.b = (1 - sm) * this._ap.b + sm * b
    this._apRefits++
  }
  _normalize(raw) {
    const zero = { delta: 0, theta: 0, alpha: 0, beta: 0, gamma: 0 }
    if (this._apRefits < AP_MIN_REFITS) return zero
    const { a, b } = this._ap
    let total = 0; const norm = {}
    for (const [band, f] of Object.entries(BAND_FREQ)) {
      if (!this.normalizeBands.has(band)) { norm[band] = 0; continue }
      const expected = Math.pow(10, a + b * Math.log10(f))
      norm[band] = raw[band] > 0 ? raw[band] / expected : 0
      total += norm[band]
    }
    if (total === 0) { const n = this.normalizeBands.size, eq = n ? 1 / n : 0; for (const k of BANDS) norm[k] = this.normalizeBands.has(k) ? eq : 0; return norm }
    for (const k of BANDS) if (this.normalizeBands.has(k)) norm[k] /= total
    return norm
  }
  _kernels() {
    const N = EEG_BUF
    this._wavelets = {}
    for (const [band, f] of Object.entries(WAVELET_FREQS)) {
      const tau = band === 'theta' ? TAU_THETA : TAU
      const sigma = tau / (2 * Math.PI * f), A = 1 / Math.sqrt(sigma * Math.sqrt(Math.PI))
      const half = Math.ceil(3 * sigma * EEG_FS), len = 2 * half + 1
      const re = new Float32Array(len), im = new Float32Array(len)
      for (let i = 0; i < len; i++) { const t = (i - half) / EEG_FS, g = A * Math.exp(-(t * t) / (2 * sigma * sigma)); re[i] = g * Math.cos(2 * Math.PI * f * t); im[i] = g * Math.sin(2 * Math.PI * f * t) }
      this._wavelets[band] = { re, im, half }
    }
    this._dft = {}
    const hann = new Float32Array(N); for (let n = 0; n < N; n++) hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1))
    this._hannSS = hann.reduce((a, v) => a + v * v, 0)
    for (let k = 1; k <= SPEC_BINS; k++) {
      const re = new Float32Array(N), im = new Float32Array(N)
      for (let n = 0; n < N; n++) { const ang = (2 * Math.PI * k * n) / N; re[n] = hann[n] * Math.cos(ang); im[n] = hann[n] * Math.sin(ang) }
      this._dft[k] = { re, im }
    }
  }
}

// ───────────────────────── PPG / heart rate (MSPTDfast v2) ─────────────────────────
const PPG_FS = 64, PPG_WIN = PPG_FS * 6, PPG_STEP = PPG_FS
const HP_A = 1 / (1 + (2 * Math.PI * 0.5) / PPG_FS)
const LP_A = ((2 * Math.PI * 3.5) / PPG_FS) / (1 + (2 * Math.PI * 3.5) / PPG_FS)
const DS = Math.floor(PPG_FS / 20), DS_FS = PPG_FS / DS
const HR_MIN = 30, HR_MAX = 200, REFINE_TOL = Math.ceil(PPG_FS * 0.05), MIN_PEAK_DIST = Math.round(0.3 * PPG_FS)

function detrend(sig) {
  const N = sig.length; if (N < 2) return sig.slice()
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < N; i++) { sx += i; sy += sig[i]; sxx += i * i; sxy += i * sig[i] }
  const den = N * sxx - sx * sx; if (den === 0) return sig.slice()
  const slope = (N * sxy - sx * sy) / den, ic = (sy - slope * sx) / N
  return sig.map((v, i) => v - (slope * i + ic))
}
function msptd(sig, fs, minHz = HR_MIN / 60) {
  const N = sig.length; if (N < 4) return []
  const L = Math.ceil(N / 2) - 1, durn = N / fs
  const maxScale = Math.min(L, Math.floor(L / (durn * minHz))); if (maxScale < 1) return []
  const x = detrend(sig)
  const mMax = new Uint8Array(maxScale * N)
  for (let k = 1; k <= maxScale; k++) { const row = (k - 1) * N; for (let i = k; i < N - k; i++) if (x[i] > x[i - k] && x[i] > x[i + k]) mMax[row + i] = 1 }
  let lam = 0, best = 0
  for (let k = 0; k < maxScale; k++) { let s = 0; for (let i = 0; i < N; i++) s += mMax[k * N + i]; if (s > best) { best = s; lam = k } }
  const peaks = []
  for (let i = 0; i < N; i++) { let ok = true; for (let k = 0; k <= lam && ok; k++) if (!mMax[k * N + i]) ok = false; if (ok) peaks.push(i) }
  return peaks
}

export class HeartRate {
  bpm = null
  display = []              // filtered samples, last 6 s (for plotting)
  constructor() { this._hx = 0; this._hy = 0; this._ly = 0; this._step = 0 }
  reset() { this.bpm = null; this.display = []; this._hx = this._hy = this._ly = 0; this._step = 0 }
  push(raw) {
    const hp = HP_A * (this._hy + raw - this._hx); this._hx = raw; this._hy = hp
    const lp = (1 - LP_A) * this._ly + LP_A * hp; this._ly = lp
    this.display.push(lp); if (this.display.length > PPG_WIN) this.display.shift()
    if (++this._step >= PPG_STEP) { this._step = 0; this._run() }
  }
  _run() {
    const win = this.display; if (win.length < PPG_WIN) return
    const ds = []; for (let i = 0; i < win.length; i += DS) ds.push(win[i])
    const dsPeaks = msptd(ds, DS_FS); if (dsPeaks.length < 2) return
    const refined = dsPeaks.map((p) => {
      const c = p * DS, lo = Math.max(0, c - REFINE_TOL), hi = Math.min(win.length - 1, c + REFINE_TOL)
      let mv = -Infinity, mi = c; for (let i = lo; i <= hi; i++) if (win[i] > mv) { mv = win[i]; mi = i }
      return mi
    }).sort((a, b) => a - b)
    const peaks = [refined[0]]
    for (let i = 1; i < refined.length; i++) if (refined[i] - peaks[peaks.length - 1] >= MIN_PEAK_DIST) peaks.push(refined[i])
    if (peaks.length < 2) return
    const ibis = []
    for (let i = 1; i < peaks.length; i++) { const ibi = (peaks[i] - peaks[i - 1]) / PPG_FS, hr = 60 / ibi; if (hr >= HR_MIN && hr <= HR_MAX) ibis.push(ibi) }
    if (!ibis.length) return
    ibis.sort((a, b) => a - b)
    const m = ibis.length >> 1, med = ibis.length % 2 ? ibis[m] : (ibis[m - 1] + ibis[m]) / 2
    this.bpm = Math.round(60 / med)
  }
}
