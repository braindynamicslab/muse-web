// Signal-quality "HSI" (horseshoe index) — port of muse-lsl's SignalProcessor.computeQuality
// (Packages/MuseCore/Sources/MuseCore/Processing/SignalProcessor.swift), same thresholds and hysteresis.
// Five components per channel, worst wins: amplitude (peak-to-peak), muscle ratio, line noise, saturation, drift.
// Levels: 0 good, 1 ok, 2 poor. Worsens immediately; improves only after 4 consecutive better windows (2 Hz).

const FS = 256
const HOP = FS / 2               // quality every 0.5 s
const BUF = FS * 4               // 4 s for drift
export const TH = {
  p2pMin: 10, p2pOK: 400, p2pPoor: 800,       // µV, 1 s window
  muscleOK: 0.3, musclePoor: 0.6,             // power 40–80 Hz / 1–40 Hz
  lineOK: 3, linePoor: 8,                     // line ±2 Hz / median of 30–80 Hz surround
  rail: 1000 * 0.98, satPoor: 0.01,           // fraction of samples at the rails
  driftPoor: 0.2, driftOK: 0.5,               // detrended p2p / raw p2p over 4 s
  improveAfter: 4,
}
export const LEVEL = ['good', 'ok', 'poor']

const HANN = new Float64Array(FS).map((_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / FS))   // periodic Hann
const COS = [], SIN = []
for (let k = 0; k <= 80; k++) {
  const c = new Float64Array(FS), s = new Float64Array(FS)
  for (let n = 0; n < FS; n++) { c[n] = Math.cos((2 * Math.PI * k * n) / FS); s[n] = Math.sin((2 * Math.PI * k * n) / FS) }
  COS.push(c); SIN.push(s)
}

function detrend(x) {
  const N = x.length; let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < N; i++) { sx += i; sy += x[i]; sxx += i * i; sxy += i * x[i] }
  const den = N * sxx - sx * sx, b = den ? (N * sxy - sx * sy) / den : 0, a = (sy - b * sx) / N
  return x.map((v, i) => v - (a + b * i))
}
const p2p = (x) => { let lo = Infinity, hi = -Infinity; for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v } return hi - lo }
const median = (a) => { const s = [...a].sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

export class HSI {
  lineHz = 60                               // US mains
  levels = [2, 2, 2, 2]                     // after hysteresis
  detail = [0, 1, 2, 3].map(() => ({ p2p: 0, muscle: 0, line: 0, sat: 0, drift: 1, worst: 'amplitude', raw: 2 }))
  onUpdate = null
  constructor() { this.reset() }
  reset() {
    this._b = [0, 1, 2, 3].map(() => new Float32Array(BUF)); this._n = 0; this._next = FS
    this._streak = [0, 0, 0, 0]; this.levels = [2, 2, 2, 2]
  }
  push(d) {
    const i = this._n % BUF
    for (let c = 0; c < 4; c++) this._b[c][i] = Number.isNaN(d[c]) ? 0 : d[c]
    this._n++
    if (this._n >= this._next) { this._next = this._n + HOP; this._compute() }
  }
  _last(c, m) { const out = new Float64Array(m), b = this._b[c]; for (let k = 0; k < m; k++) out[k] = b[(this._n - m + k) % BUF]; return out }
  _compute() {
    for (let c = 0; c < 4; c++) {
      const x = this._last(c, FS)
      const q = { p2p: p2p(x) }
      q.sat = x.reduce((s, v) => s + (Math.abs(v) >= TH.rail ? 1 : 0), 0) / FS
      const dx = detrend(x)
      const P = new Float64Array(81)
      for (let k = 1; k <= 80; k++) {
        let re = 0, im = 0; const cc = COS[k], ss = SIN[k]
        for (let n = 0; n < FS; n++) { const v = dx[n] * HANN[n]; re += v * cc[n]; im += v * ss[n] }
        P[k] = re * re + im * im
      }
      let lf = 0, hf = 0
      for (let k = 1; k < 40; k++) lf += P[k]
      for (let k = 40; k < 80; k++) hf += P[k]
      q.muscle = lf > 0 ? hf / lf : 0
      const L = this.lineHz, lo = Math.max(1, L - 2), hi = Math.min(80, L + 2)
      let lp = 0; for (let k = lo; k <= hi; k++) lp += P[k]; lp /= hi - lo + 1
      const sur = []; for (let k = 30; k < 80; k++) if (k < lo || k > hi) sur.push(P[k])
      const med = median(sur); q.line = med > 0 ? lp / med : 0
      const m = Math.min(this._n, BUF), long = this._last(c, m), rp = p2p(long)
      q.drift = rp > 0 ? p2p(detrend(long)) / rp : 1
      const lev = {
        amplitude: q.p2p < TH.p2pMin || q.p2p > TH.p2pPoor ? 2 : q.p2p > TH.p2pOK ? 1 : 0,
        muscle: q.muscle > TH.musclePoor ? 2 : q.muscle > TH.muscleOK ? 1 : 0,
        line: q.line > TH.linePoor ? 2 : q.line > TH.lineOK ? 1 : 0,
        saturation: q.sat > TH.satPoor ? 2 : 0,
        drift: q.drift < TH.driftPoor ? 2 : q.drift < TH.driftOK ? 1 : 0,
      }
      let worst = 'amplitude', raw = -1
      for (const [k, v] of Object.entries(lev)) if (v > raw) { raw = v; worst = k }
      q.raw = raw; q.worst = worst; q.lev = lev
      this.detail[c] = q
      if (raw >= this.levels[c]) { this.levels[c] = raw; this._streak[c] = 0 }
      else if (++this._streak[c] >= TH.improveAfter) { this.levels[c] = raw; this._streak[c] = 0 }
    }
    this.onUpdate?.(this.levels, this.detail)
  }
}

export const REASON = {
  amplitude: 'signal too flat or too large — sensor not touching skin',
  muscle: 'muscle/jaw tension — relax face and jaw',
  line: 'electrical noise — sensor not making good skin contact',
  saturation: 'signal clipping — reseat the headband',
  drift: 'slow drift — sensor moving or skin still drying; hold still',
}
