// Event-locked analysis for the "mind-wandering" key presses (classroom adaptation of Hasenkamp et al. 2012).
// Pure functions, no DOM. Band power is computed over the whole block in short sliding windows (2 s, hop 0.5 s,
// 0.5 Hz resolution); each press gets a −10 s … +10 s epoch; epochs are averaged and compared with epochs cut at
// random times in the same block (a permutation control), so students can see whether presses look any different
// from chance.

export const FS = 256
export const WIN = 512                       // 2 s
export const HOP = 128                       // 0.5 s
export const STEP_S = HOP / FS               // 0.5 s between window centres
export const NF = 60                         // 0.5 … 30 Hz
export const FREQS = Float64Array.from({ length: NF }, (_, k) => (k + 1) * 0.5)
const HANN = Float64Array.from({ length: WIN }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (WIN - 1)))
const SS = HANN.reduce((a, v) => a + v * v, 0)
const SC = 2 / (FS * SS)

let TAB = null
function tables() {
  if (TAB) return TAB
  const cos = new Float32Array(NF * WIN), sin = new Float32Array(NF * WIN)
  for (let k = 0; k < NF; k++) for (let n = 0; n < WIN; n++) { const a = (2 * Math.PI * FREQS[k] * n) / FS; cos[k * WIN + n] = HANN[n] * Math.cos(a); sin[k * WIN + n] = HANN[n] * Math.sin(a) }
  return (TAB = { cos, sin })
}

/** Sliding-window power spectra of the MEAN power across the given signals (Float64Array each, same length).
 *  Returns { nw, S: Float32Array(nw*NF) in µV²/Hz, tc: window-centre times in s from the first sample }. */
export function slidingSpectra(signals) {
  const n = signals[0].length, nw = n >= WIN ? Math.floor((n - WIN) / HOP) + 1 : 0
  const { cos, sin } = tables()
  const S = new Float32Array(nw * NF), tc = new Float64Array(nw), x = new Float64Array(WIN)
  for (let w = 0; w < nw; w++) {
    const st = w * HOP; tc[w] = (st + WIN / 2) / FS
    for (const sig of signals) {
      let m = 0; for (let i = 0; i < WIN; i++) m += sig[st + i]; m /= WIN
      for (let i = 0; i < WIN; i++) x[i] = sig[st + i] - m
      for (let k = 0; k < NF; k++) {
        let re = 0, im = 0; const o = k * WIN
        for (let i = 0; i < WIN; i++) { re += x[i] * cos[o + i]; im += x[i] * sin[o + i] }
        S[w * NF + k] += ((re * re + im * im) * SC) / signals.length
      }
    }
  }
  return { nw, S, tc }
}

const dB = (v) => 10 * Math.log10(Math.max(v, 1e-12))
export const BAND_EDGES = { theta: [4, 8], alpha: [8, 13], beta: [13, 30] }
/** Band power (dB re 1 µV²) per window for [lo, hi) Hz. */
export function bandSeries({ nw, S }, lo, hi) {
  const out = new Float64Array(nw)
  for (let w = 0; w < nw; w++) { let s = 0; for (let k = 0; k < NF; k++) if (FREQS[k] >= lo && FREQS[k] < hi) s += S[w * NF + k] * 0.5; out[w] = dB(s) }
  return out
}

/** Head-movement series from accelerometer rows [[t_ms_rel, x, y, z], …] over [t0, t1] (ms rel): RMS deviation from
 *  the block mean in 0.5 s bins, on the same time grid as `tc` (window centres, s from t0). */
export function motionSeries(rows, t0, t1, tc) {
  const sel = rows.filter((r) => r[0] >= t0 && r[0] <= t1)
  const out = new Float64Array(tc.length)
  if (sel.length < 4) return out
  const mean = [1, 2, 3].map((j) => sel.reduce((a, r) => a + r[j], 0) / sel.length)
  const dev = sel.map((r) => ({ t: (r[0] - t0) / 1000, d: (r[1] - mean[0]) ** 2 + (r[2] - mean[1]) ** 2 + (r[3] - mean[2]) ** 2 }))
  let j = 0
  for (let w = 0; w < tc.length; w++) {
    let s = 0, c = 0
    while (j < dev.length && dev[j].t < tc[w] - STEP_S / 2) j++
    for (let q = j; q < dev.length && dev[q].t < tc[w] + STEP_S / 2; q++) { s += dev[q].d; c++ }
    out[w] = c ? Math.sqrt(s / c) : (w ? out[w - 1] : 0)
  }
  return out
}

const nEpoch = (pre, post) => Math.round((pre + post) / STEP_S) + 1
/** Epochs around event times (s from block start). Epoch k holds the series at time p − pre + k·STEP_S.
 *  normalize: subtract each epoch's own mean (so lines show change within the window). Events too close to the
 *  block edges (window would run out of data) are skipped. */
export function epochsAround(series, tc, events, pre = 10, post = 10, normalize = true) {
  const m = nEpoch(pre, post), out = [], used = [], skipped = []
  const tFirst = tc[0], tLast = tc[tc.length - 1]
  for (const p of events) {
    if (p - pre < tFirst - 1e-9 || p + post > tLast + 1e-9) { skipped.push(p); continue }
    const e = new Float64Array(m)
    for (let k = 0; k < m; k++) e[k] = series[Math.round((p - pre + k * STEP_S - tFirst) / STEP_S)]
    if (normalize) { let mu = 0; for (const v of e) mu += v; mu /= m; for (let k = 0; k < m; k++) e[k] -= mu }
    out.push(e); used.push(p)
  }
  return { epochs: out, used, skipped }
}
export function meanEpoch(epochs) {
  const m = epochs[0].length, out = new Float64Array(m)
  for (const e of epochs) for (let k = 0; k < m; k++) out[k] += e[k] / epochs.length
  return out
}

/** Permutation control: the average epoch (same normalisation) for the same number of events placed uniformly at
 *  random in the valid range of the block, repeated nIter times. Returns the 2.5th and 97.5th percentile at every
 *  time point, i.e. what "no relation to the presses" looks like for this block and this many presses. */
export function permutationBand(series, tc, nEvents, pre = 10, post = 10, normalize = true, nIter = 300, rand = Math.random) {
  const m = nEpoch(pre, post), lo = tc[0] + pre, hi = tc[tc.length - 1] - post
  if (nEvents < 1 || hi <= lo) return null
  const acc = Array.from({ length: m }, () => new Float64Array(nIter))
  for (let it = 0; it < nIter; it++) {
    const ev = Array.from({ length: nEvents }, () => lo + rand() * (hi - lo))
    const { epochs } = epochsAround(series, tc, ev, pre, post, normalize)
    const me = meanEpoch(epochs)
    for (let k = 0; k < m; k++) acc[k][it] = me[k]
  }
  const loA = new Float64Array(m), hiA = new Float64Array(m)
  for (let k = 0; k < m; k++) { const s = Array.from(acc[k]).sort((a, b) => a - b); loA[k] = s[Math.floor(0.025 * (nIter - 1))]; hiA[k] = s[Math.ceil(0.975 * (nIter - 1))] }
  return { lo: loA, hi: hiA }
}
