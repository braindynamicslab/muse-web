// High-resolution spectra from stored raw EEG, for the Spectrum lab (channels / references) and for IAF.
// Pure functions, no DOM. Windows are 4 s (1024 samples, 0.25 Hz resolution), Hann, mean removed, hop 1 s.
// PSD scaling 2/(fs·Σw²) so power is in µV²/Hz (same convention as the live absolute band power in dsp.js).

export const FS = 256
export const WIN = 1024
export const HOP = 256
export const DF = FS / WIN                 // 0.25 Hz
export const NF = 320                      // 0.25 … 80 Hz
export const FREQS = Float64Array.from({ length: NF }, (_, k) => (k + 1) * DF)
const HANN = Float64Array.from({ length: WIN }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (WIN - 1)))
const SS = HANN.reduce((a, v) => a + v * v, 0)
const SC = 2 / (FS * SS)

let TAB = null
function tables() {
  if (TAB) return TAB
  const cos = new Float32Array(NF * WIN), sin = new Float32Array(NF * WIN)
  for (let k = 0; k < NF; k++) {
    const f = FREQS[k]
    for (let n = 0; n < WIN; n++) { const a = (2 * Math.PI * f * n) / FS; cos[k * WIN + n] = HANN[n] * Math.cos(a); sin[k * WIN + n] = HANN[n] * Math.sin(a) }
  }
  return (TAB = { cos, sin })
}

/** Welch-style average PSD (µV²/Hz at FREQS) over the windows of the given segments. segs: array of Float64Array. */
export function psd(segs) {
  const { cos, sin } = tables()
  const pw = new Float64Array(NF); let n = 0
  const x = new Float64Array(WIN)
  for (const s of segs) {
    for (let st = 0; st + WIN <= s.length; st += HOP) {
      let m = 0; for (let i = 0; i < WIN; i++) m += s[st + i]; m /= WIN
      for (let i = 0; i < WIN; i++) x[i] = s[st + i] - m
      for (let k = 0; k < NF; k++) {
        let re = 0, im = 0; const o = k * WIN
        for (let i = 0; i < WIN; i++) { re += x[i] * cos[o + i]; im += x[i] * sin[o + i] }
        pw[k] += (re * re + im * im) * SC
      }
      n++
    }
  }
  if (n) for (let k = 0; k < NF; k++) pw[k] /= n
  return { pw, n }
}

export const ELECTRODES = ['TP9', 'AF7', 'AF8', 'TP10']          // row order in eeg.csv / rec.rows
const PARTNER = [3, 2, 1, 0]                                     // contralateral electrode in the same row
export const REFERENCES = [
  { id: 'device', label: 'Device reference (as recorded)' },
  { id: 'average', label: 'Average of all four' },
  { id: 'linked', label: 'Linked ears (mean of TP9, TP10)' },
  { id: 'bipolar', label: 'Bipolar (minus the other side)' },
]

/** X = [tp9, af7, af8, tp10] Float64Arrays. Returns the signal for electrode e under a reference. */
export function derive(X, e, ref) {
  const n = X[0].length, out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const v = X[e][i]
    if (ref === 'device') out[i] = v
    else if (ref === 'average') out[i] = v - (X[0][i] + X[1][i] + X[2][i] + X[3][i]) / 4
    else if (ref === 'linked') out[i] = v - (X[0][i] + X[3][i]) / 2
    else if (ref === 'bipolar') out[i] = v - X[PARTNER[e]][i]
  }
  return out
}

const dB = (v) => 10 * Math.log10(Math.max(v, 1e-12))

/** Peak above the 1/f background, for any frequency grid. f: frequencies (Hz, ascending, uniform), db: power in dB.
 *  Background = line fit (log f vs dB) to 2–6 and 15–35 Hz. Peak = largest residual within [lo, hi] (default 7.5–13.5 Hz, one bin inside the edges) that is a local
 *  maximum, refined by parabolic interpolation → sub-bin frequency. Strength: 'clear' ≥ 3 dB, 'weak' ≥ 1.5 dB
 *  above background (pure noise reaches ~2 dB somewhere in the search range, so anything lower is called no peak). */
export function peakAbove(f, db, lo = 7.5, hi = 13.5, margin = 1) {
  const xs = [], ys = []
  for (let k = 0; k < f.length; k++) if ((f[k] >= 2 && f[k] <= 6) || (f[k] >= 15 && f[k] <= 35)) { xs.push(Math.log10(f[k])); ys.push(db[k]) }
  const n = xs.length; let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i] }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n
  const res = (k) => db[k] - (a + b * Math.log10(f[k]))
  const df = f[1] - f[0]
  let bk = -1, br = -Infinity
  for (let k = 1; k < f.length - 1; k++) if (f[k] - margin * df >= lo - 1e-9 && f[k] + margin * df <= hi + 1e-9) { const r = res(k); if (r > br) { br = r; bk = k } }
  if (bk < 0) return { iaf: null, height: 0, strength: 'none' }
  let iaf = null, height = br, strength = 'none'
  const local = res(bk) >= res(bk - 1) && res(bk) >= res(bk + 1)
  if (local) {
    const r0 = res(bk - 1), r1 = res(bk), r2 = res(bk + 1), den = r0 - 2 * r1 + r2
    const d = den !== 0 ? (0.5 * (r0 - r2)) / den : 0
    height = r1 - 0.25 * (r0 - r2) * d
    strength = height >= 3 ? 'clear' : height >= 1.5 ? 'weak' : 'none'
    if (strength !== 'none') iaf = f[bk] + d * df
  }
  return { iaf, height, strength }
}

/** Alpha metrics from a high-resolution PSD (µV²/Hz): alpha band power (8–13 Hz, dB re 1 µV²) + peak above 1/f. */
export function alphaMetrics(pw) {
  let band = 0
  for (let k = 0; k < NF; k++) if (FREQS[k] >= 8 && FREQS[k] < 13) band += pw[k] * DF
  return { bandDb: dB(band), ...peakAbove(FREQS, Array.from(pw, dB)) }
}

export const peakLabel = (m) => (m.strength === 'none' ? 'no clear peak' : `${m.iaf.toFixed(1)} Hz${m.strength === 'weak' ? ' (weak)' : ''}`)
