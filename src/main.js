import { MuseClient, zipSamples } from 'muse-js'
import SimulatedMuse from './sim.js'
import { BandPipeline, HeartRate, BANDS, SPEC_BINS } from './dsp.js'
import { HSI, LEVEL, REASON } from './quality.js'
import { makeZip } from './zip.js'
import { SampleClock } from './clock.js'
import { WEEKS, CLAIMS, BAND_BINS, BAND_NAMES } from './weeks.js'
import { psd, derive, alphaMetrics, peakAbove, peakLabel, FREQS, NF, DF, REFERENCES, ELECTRODES } from './spectrum.js'

// ---------- constants ----------
const FS = 256                 // EEG sample rate
const WIN_S = 8                // EEG trace window (s)
const N = FS * WIN_S + 64
const CH = ['TP9', 'AF7', 'AF8', 'TP10']
const CH_INFO = ['left ear', 'left forehead', 'right forehead', 'right ear']
const COLORS = ['#4da3ff', '#3ecf8e', '#f5b942', '#c78bff']
const HP_FC = 0.5                          // display-only high-pass (Hz); analysis uses raw µV like nouscope
const SPEC_COLS = 120                      // 2 columns/s × 60 s
const BAND_WIN_MS = 60000
const BAND_COLORS = { delta: '#7f8cff', theta: '#3ecf8e', alpha: '#f5b942', beta: '#ef7b5b', gamma: '#c78bff' }
const BAND_LABEL = { delta: 'δ delta', theta: 'θ theta', alpha: 'α alpha', beta: 'β beta', gamma: 'γ gamma' }
const PRESETS = ['Eyes open', 'Eyes closed', 'Blink', 'Jaw clench', 'Mental math', 'Music', 'Head movement']
const LAYERS = ['bands', 'spectrogram', 'ppg', 'motion']
const SETTLE_S = 2      // ignore the first seconds of each block in summaries (transition + smoothing)
const ACC_FS = 52, ACC_N = ACC_FS * 6
const LEVEL_TO_Q = ['good', 'marginal', 'poor']

const $ = (id) => document.getElementById(id)
const params = new URLSearchParams(location.search)

// ---------- weekly preset (?week=N) and layers ----------
const weekCfg = WEEKS[params.get('week')] || null
const layerState = { bands: true, spectrogram: true, ppg: false, motion: false }
const layerParam = params.has('layers') ? params.get('layers').split(',') : (weekCfg && weekCfg.layers) || null
const lockedLayers = !!layerParam
if (lockedLayers) {
  for (const l of LAYERS) layerState[l] = layerParam.includes(l)
  $('layer-row').hidden = true
} else {
  for (const l of LAYERS) {
    const lab = document.createElement('label')
    lab.innerHTML = `<input type="checkbox" data-l="${l}"${layerState[l] ? ' checked' : ''}> ${{ ppg: 'Pulse (PPG)', spectrogram: 'Spectrogram', bands: 'Band power', motion: 'Head motion' }[l]}`
    lab.querySelector('input').addEventListener('change', (e) => { layerState[l] = e.target.checked; applyLayers() })
    $('layer-toggles').appendChild(lab)
  }
}
function applyLayers() {
  document.querySelectorAll('.layer').forEach((el) => { el.hidden = !layerState[el.dataset.layer] })
}
applyLayers()
if (weekCfg) {
  $('banner').hidden = false
  $('banner-title').textContent = weekCfg.title
  $('banner-body').innerHTML = weekCfg.banner
  document.title = `${weekCfg.title.split(' · ')[0]} · Brain Dynamics Lab`
}

if (!navigator.bluetooth) $('browser-warning').hidden = false

// ---------- state ----------
const eeg = {
  disp: CH.map(() => new Float32Array(N)),     // high-passed, display only
  t: new Float64Array(N),                      // sample timestamp (ms)
  n: 0,
  hpY: new Float64Array(4), hpX: new Float64Array(4), hpInit: false,
}
const pipe = new BandPipeline()
const hr = new HeartRate()
const hsi = new HSI()
pipe.useExternalQuality = true          // channel weights come from the muse-lsl HSI, not nouscope's RMS rule
const acc = { x: new Float32Array(ACC_N), y: new Float32Array(ACC_N), z: new Float32Array(ACC_N), n: 0 }
const rec = { t0: null, rows: [], blocks: [], current: null, blockT0: 0, curSettle: SETTLE_S, selected: null, claim: null,
              bandRows: [], bandHist: [], specRows: [], accRows: [], ppgRows: [], quality: [] }
const spec = { cols: [] }
let lastTs = 0, batteryPct = null
const clock = new SampleClock(FS)
let client = null, subs = [], connected = false, simulated = false

const blockAge = () => (rec.current ? (lastTs - rec.blockT0) / 1000 : 0)
pipe.onColumn = (col) => {
  spec.cols.push(col); if (spec.cols.length > SPEC_COLS) spec.cols.shift()
  if (rec.current) rec.specRows.push({ cond: rec.current, age: blockAge(), settle: rec.curSettle, col })
}
hsi.onUpdate = (levels, detail) => {
  pipe.quality = levels.map((l) => LEVEL_TO_Q[l])
  rec.quality.push([lastTs - rec.t0, ...levels, ...detail.map((q) => q.p2p)])
}
pipe.onBands = (bp, ready, abs) => {
  const vals = BANDS.map((b) => bp[b]), absv = BANDS.map((b) => abs[b])
  rec.bandHist.push({ t: lastTs, vals, abs: absv, ready })
  while (rec.bandHist.length && lastTs - rec.bandHist[0].t > BAND_WIN_MS + 5000) rec.bandHist.shift()
  rec.bandRows.push({ t: lastTs - rec.t0, cond: rec.current || '', age: blockAge(), settle: rec.curSettle, vals, abs: absv, ready, ch: `${pipe.channelMode}:${CH.filter((_, c) => pipe.weights[c] > 0).join('+')}` })
}

// ---------- connection ----------
async function connect(simulate) {
  setStatus(simulate ? 'Starting practice mode…' : 'Choose your Muse in the Bluetooth popup…')
  try {
    client = simulate ? new SimulatedMuse() : new MuseClient()
    client.enablePpg = true
    await client.connect()
    await client.start()
  } catch (err) {
    console.error(err)
    setStatus(`Could not connect: ${err.message || err}`)
    client = null
    return
  }
  simulated = simulate
  connected = true
  resetData()
  rec.t0 = null
  subs.push(zipSamples(client.eegReadings).subscribe((s) => onEegSample(s)))
  subs.push(client.ppgReadings.subscribe((r) => {
    if (r.ppgChannel !== 1) return
    const arrival = Date.now(), m = r.samples.length     // arrival-based, like accelerometer (muse-js PPG timestamps share the broken counter)
    r.samples.forEach((v, i) => { hr.push(v); if (rec.t0 !== null) rec.ppgRows.push([arrival - ((m - 1 - i) * 1000) / 64 - rec.t0, v, rec.current || '']) })
  }))
  subs.push(client.accelerometerData.subscribe((r) => {
    const arrival = Date.now(), m = r.samples.length     // accelerometer packets carry no timestamp
    r.samples.forEach((p, i) => {
      const k = acc.n % ACC_N; acc.x[k] = p.x; acc.y[k] = p.y; acc.z[k] = p.z; acc.n++
      if (rec.t0 !== null) rec.accRows.push([arrival - ((m - 1 - i) * 1000) / ACC_FS - rec.t0, p.x, p.y, p.z, rec.current || ''])
    })
  }))
  subs.push(client.telemetryData.subscribe((t) => { batteryPct = Math.round(t.batteryLevel); updateBattery() }))
  subs.push(client.connectionStatus.subscribe((c) => { if (!c && connected) onDisconnected() }))
  $('btn-connect').hidden = $('btn-sim').hidden = true
  $('btn-disconnect').hidden = false
  $('btn-download').disabled = false
  updateCurrentUi()
  setStatus(simulate ? 'Practice mode — simulated headset' : `Connected: ${client.deviceName || 'Muse'}`, true)
}
function disconnect() { try { client?.disconnect() } catch {} ; onDisconnected() }
function onDisconnected() {
  if (!connected) return
  connected = false
  subs.forEach((s) => s.unsubscribe()); subs = []
  endBlock()
  $('btn-connect').hidden = $('btn-sim').hidden = false
  $('btn-disconnect').hidden = true
  setStatus('Disconnected (your data is still here — you can download it)')
}
function setStatus(msg, on = false) { const el = $('status'); el.textContent = msg; el.classList.toggle('on', on) }
function resetData() {
  eeg.n = 0; eeg.hpInit = false; eeg.disp.forEach((x) => x.fill(0)); eeg.t.fill(0)
  pipe.reset(); hr.reset()
  spec.cols = []; hsi.reset(); clock.reset(); acc.n = 0; batteryPct = null
  rec.rows = []; rec.blocks = []; rec.current = null; rec.bandRows = []; rec.bandHist = []; rec.specRows = []; rec.accRows = []; rec.ppgRows = []; rec.quality = []
  updateCurrentUi(); updateBattery()
}

// ---------- EEG ingest ----------
const hpA = 1 / (1 + 2 * Math.PI * HP_FC / FS)
function onEegSample(s) {
  const d = s.data
  const ts = clock.stamp(s.index)      // our own clock — muse-js timestamps are unreliable (see clock.js)
  if (rec.t0 === null) rec.t0 = ts
  lastTs = ts
  const i = eeg.n % N
  eeg.t[i] = ts
  for (let c = 0; c < 4; c++) {
    const x = Number.isNaN(d[c]) ? 0 : d[c]
    if (!eeg.hpInit) { eeg.hpX[c] = x; eeg.hpY[c] = 0 }
    const y = hpA * (eeg.hpY[c] + x - eeg.hpX[c])
    eeg.hpX[c] = x; eeg.hpY[c] = y
    eeg.disp[c][i] = y
  }
  eeg.hpInit = true
  eeg.n++
  hsi.push(d)
  pipe.push(d)     // analysis pipeline sees the raw samples (nouscope: no filtering)
  rec.rows.push([ts - rec.t0, d[0], d[1], d[2], d[3], rec.current || ''])
}

// ---------- quality UI (muse-lsl HSI) ----------
function updateQuality() {
  if (eeg.n < FS) return
  const hint = []
  hsi.levels.forEach((l, c) => {
    const d = hsi.detail[c]
    if (l > 0) hint.push(`${CH[c]} (${CH_INFO[c]}): ${d.raw > 0 ? REASON[d.worst] : 'looks better now — hold still a few seconds'}`)
  })
  updateChannelWarning()
  const emg = $('emg-row'); emg.hidden = $('spec-range').value !== '80'
  if (!emg.hidden) emg.innerHTML = 'Muscle ratio (40–80 Hz ÷ 1–40 Hz): ' + CH.map((n, c) => { const m = hsi.detail[c].muscle; return `${n} <b style="color:${m > 0.6 ? 'var(--bad)' : m > 0.3 ? 'var(--mid)' : 'var(--good)'}">${m.toFixed(2)}</b>` }).join(' · ') + ' &nbsp;(clenching your jaw pushes it above ~0.6)'
  $('fit-hint').textContent = hint.length ? hint.join('  ·  ') : 'All four contacts look good. Sit still for a few seconds.'
  document.querySelectorAll('#quality .q').forEach((el, c) => {
    const d = hsi.detail[c]
    el.className = `q ${LEVEL_TO_Q[hsi.levels[c]]}`
    el.title = `${LEVEL[hsi.levels[c]]} — amplitude ${d.p2p.toFixed(0)} µV p-p · muscle ${d.muscle.toFixed(2)} · line noise ${d.line.toFixed(1)}× · clipping ${(d.sat * 100).toFixed(0)}% · drift ${d.drift.toFixed(2)}`
  })
}
const CH_MODE_LABEL = { weighted: 'best-contact channels', posterior: 'TP9 + TP10', frontal: 'AF7 + AF8', all: 'all four channels', tp9: 'TP9 only', tp10: 'TP10 only', af7: 'AF7 only', af8: 'AF8 only' }
function updateChannelWarning() {
  const poor = CH.filter((_, c) => hsi.levels[c] === 2)
  let msg = ''
  if (pipe.channelMode === 'weighted') {
    if (pipe.lockedWeights) {
      const used = CH.filter((_, c) => pipe.lockedWeights[c] > 0)
      const nowBad = used.filter((n) => hsi.levels[CH.indexOf(n)] === 2)
      $('lock-text').textContent = `Channels locked for this recording: ${used.join(', ')} — every block is analysed with the same channels.` +
        (nowBad.length ? ` ${nowBad.join(' and ')} ${nowBad.length > 1 ? 'have' : 'has'} poor contact now but ${nowBad.length > 1 ? 'stay' : 'stays'} included.` : '')
      $('lock-note').hidden = false
    } else {
      $('lock-note').hidden = true
      if (poor.length >= 2) msg = `${poor.join(' and ')} have poor contact and are being left out — these results come from the remaining channels only.`
    }
  } else {
    $('lock-note').hidden = true
    const idx = { posterior: [0, 3], frontal: [1, 2], all: [0, 1, 2, 3], tp9: [0], af7: [1], af8: [2], tp10: [3] }[pipe.channelMode]
    const bad = idx.filter((c) => hsi.levels[c] === 2).map((c) => CH[c])
    if (bad.length) msg = `${bad.join(' and ')} ${bad.length > 1 ? 'have' : 'has'} poor contact but ${bad.length > 1 ? 'are' : 'is'} still included — treat these results with caution.`
  }
  $('ch-warn').textContent = msg
}
$('btn-relock').addEventListener('click', () => { pipe.unlockWeights(); updateChannelWarning() })
$('quality').innerHTML = CH.map((n) => `<span class="q"><i></i>${n}</span>`).join('')
function updateBattery() {
  const el = $('battery')
  el.hidden = batteryPct === null
  if (batteryPct !== null) { el.textContent = `🔋 ${batteryPct}%`; el.style.color = batteryPct < 20 ? 'var(--bad)' : '' }
}

// ---------- drawing ----------
function fit(cv) {
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr)
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0)
  return [g, cv.clientWidth, cv.clientHeight]
}
/** Shade each experiment block and mark its start/stop edges. xOf maps ms → x. */
function drawBlocks(g, xOf, xMin, xMax, hgt, labelY) {
  for (const b of rec.blocks) {
    const x0 = Math.max(xMin, xOf(b.t0)), x1 = Math.min(xMax, b.t1 == null ? xMax : xOf(b.t1))
    if (x1 < xMin || x0 > xMax || x1 <= x0) continue
    g.fillStyle = 'rgba(77,163,255,0.10)'; g.fillRect(x0, 0, x1 - x0, hgt)
    g.strokeStyle = '#4da3ffaa'; g.setLineDash([4, 4]); g.beginPath()
    if (xOf(b.t0) >= xMin) { g.moveTo(xOf(b.t0), 0); g.lineTo(xOf(b.t0), hgt) }
    if (b.t1 != null && xOf(b.t1) <= xMax) { g.moveTo(xOf(b.t1), 0); g.lineTo(xOf(b.t1), hgt) }
    g.stroke(); g.setLineDash([])
    g.fillStyle = '#9ac8ff'; g.font = '12px sans-serif'; g.fillText(`${b.label}${b.t1 == null ? ' ●' : ''}`, x0 + 4, labelY)
  }
}
function drawEeg() {
  const [g, w, h] = fit($('cv-eeg'))
  g.clearRect(0, 0, w, h)
  const scale = +$('scale').value, lane = h / 4
  const tR = eeg.n ? eeg.t[(eeg.n - 1) % N] : 0
  const xOf = (t) => w * (1 - (tR - t) / (WIN_S * 1000))
  // lane separators + labels
  g.font = '12px sans-serif'
  for (let c = 0; c < 4; c++) {
    g.strokeStyle = '#1f2633'; g.beginPath(); g.moveTo(0, lane * (c + 1)); g.lineTo(w, lane * (c + 1)); g.stroke()
    g.fillStyle = COLORS[c]; g.fillText(`${CH[c]}`, 6, lane * c + 14)
  }
  if (!eeg.n) { g.fillStyle = '#8b95a8'; g.fillText('Connect a Muse (or start Practice mode) to see your EEG.', 80, h / 2); return }
  drawBlocks(g, xOf, 0, w, h, h - 6)
  const count = Math.min(eeg.n, N - 1)
  for (let c = 0; c < 4; c++) {
    g.strokeStyle = COLORS[c]; g.lineWidth = 1; g.beginPath()
    const mid = lane * (c + 0.5)
    for (let k = eeg.n - count; k < eeg.n; k++) {
      const i = k % N
      const x = xOf(eeg.t[i])
      if (x < 0) continue
      const v = Math.max(-1, Math.min(1, eeg.disp[c][i] / scale))
      const y = mid - v * lane * 0.48
      if (k === eeg.n - count || x < 0.5) g.moveTo(x, y); else g.lineTo(x, y)
    }
    g.stroke()
  }
}
function viridis(t) {
  t = Math.max(0, Math.min(1, t))
  const stops = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]]
  const p = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(p)), f = p - i
  return stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f))
}
function drawSpec() {
  if (!layerState.spectrogram) return
  const [g, w, h] = fit($('cv-spec'))
  g.clearRect(0, 0, w, h)
  const cols = spec.cols
  if (!cols.length) return
  const nb = +$('spec-range').value
  const flat = $('chk-flat').checked
  let lo, hi, med
  if (flat) {                         // display aid: subtract each frequency's typical level → alpha pops out
    med = new Float32Array(nb)
    for (let f = 0; f < nb; f++) { const v = cols.map((c) => c[f]).sort((a, b) => a - b); med[f] = v[Math.floor(v.length / 2)] }
    lo = -0.8; hi = 0.8
  } else {                            // nouscope scaling: 5th–90th percentile of visible values, capped, ≥2 decades
    const all = []; for (const c of cols) for (let f = 0; f < nb; f++) all.push(Math.min(c[f], 8.2))
    all.sort((a, b) => a - b)
    lo = all[Math.floor(all.length * 0.05)]; hi = all[Math.floor(all.length * 0.9)]
    if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1 }
  }
  const cw = w / SPEC_COLS, rh = h / nb
  for (let k = 0; k < cols.length; k++) {
    const x = w - (cols.length - k) * cw
    for (let f = 0; f < nb; f++) {
      const v = flat ? cols[k][f] - med[f] : Math.min(cols[k][f], 8.2)
      const [r, gg, b] = viridis((v - lo) / (hi - lo))
      g.fillStyle = `rgb(${r},${gg},${b})`
      g.fillRect(x, h - (f + 1) * rh, cw + 1, rh + 1)
    }
  }
  if (nb > 60) { g.fillStyle = 'rgba(15,18,24,0.75)'; g.fillRect(0, h - 62 * rh, w, 4 * rh) }   // 60 Hz mains band
  g.fillStyle = '#fff'; g.font = '11px sans-serif'
  for (const f of (nb > 60 ? [8, 13, 30, 60] : [4, 8, 13, 30])) g.fillText(`${f} Hz`, 4, h - f * rh - 2)
  if (nb > 60) { g.fillStyle = '#8b95a8'; g.fillText('60 Hz mains', w - 78, h - 62 * rh + 2 * rh + 4) }
  g.strokeStyle = '#ffffff55'; g.setLineDash([3, 4])
  for (const f of [8, 13]) { g.beginPath(); g.moveTo(0, h - f * rh); g.lineTo(w, h - f * rh); g.stroke() }
  g.setLineDash([])
}
const isAbs = () => $('pwr-mode').value === 'absolute'
function drawBands() {
  if (!layerState.bands) return
  const [g, w, h] = fit($('cv-bands'))
  g.clearRect(0, 0, w, h)
  const abs = isAbs()
  const withDelta = abs || pipe.normalizeBands.has('delta')
  const cur = pipe.bandPower, curAbs = pipe.bandAbs, have = eeg.n > FS
  $('band-chips').innerHTML = BANDS.map((b) => {
    const off = b === 'delta' && !withDelta
    const txt = abs ? (have ? `${curAbs[b].toFixed(1)} dB` : '–') : (pipe.ready && !off ? `${Math.round(cur[b] * 100)}%` : '–')
    return `<span class="chip${off ? ' off' : ''}"><i style="background:${BAND_COLORS[b]}"></i>${BAND_LABEL[b]} <b>${txt}</b></span>`
  }).join('')
  const note = $('band-note')
  if (!connected && !rec.bandHist.length) note.textContent = 'Connect to see band power.'
  else if (abs) note.textContent = `Absolute power of ${CH_MODE_LABEL[pipe.channelMode]}, in dB re 1 µV² (+3 dB ≈ twice the power). Each band is compared with its own earlier values — bands are not comparable in height. Gamma here is 30–40 Hz.`
  else if (!pipe.ready) note.textContent = `Calibrating the 1/f background model… ${Math.round(pipe.warmupFraction * 100)}% (about 15 s after connecting). Sit still.`
  else note.textContent = 'Shares add to 100%. A band rising means it gained power relative to the others, after correcting for the 1/f slope. Try Absolute for the raw change.'
  const hist = rec.bandHist.filter((p) => abs || p.ready)
  // y range
  let lo = 0, hi = 1, fmtY = (v) => `${Math.round(v * 100)}%`
  if (abs) {
    const vis = []
    for (const p of hist) BANDS.forEach((b, i) => { if (p.abs[i] > -90) vis.push(p.abs[i]) })
    lo = vis.length ? Math.floor(Math.min(...vis) - 1) : 0; hi = vis.length ? Math.ceil(Math.max(...vis) + 1) : 10
    if (hi - lo < 6) { const m = (hi + lo) / 2; lo = m - 3; hi = m + 3 }
    fmtY = (v) => `${v.toFixed(0)}`
  }
  const yOf = (v) => h - 14 - ((v - lo) / (hi - lo)) * (h - 20)
  g.font = '11px sans-serif'
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const v = lo + f * (hi - lo), py = yOf(v)
    g.strokeStyle = '#1f2633'; g.beginPath(); g.moveTo(30, py); g.lineTo(w, py); g.stroke()
    g.fillStyle = '#8b95a8'; g.fillText(fmtY(v), 2, py + 4)
  }
  if (hist.length < 2) return
  const tR = hist[hist.length - 1].t
  const xOf = (t) => 30 + (w - 30) * (1 - (tR - t) / BAND_WIN_MS)
  drawBlocks(g, xOf, 30, w, h - 14, 12)
  BANDS.forEach((b, bi) => {
    if (b === 'delta' && !withDelta) return
    g.strokeStyle = BAND_COLORS[b]; g.lineWidth = b === 'alpha' ? 2.5 : 1.5; g.beginPath()
    let first = true
    for (const p of hist) {
      const x = xOf(p.t); if (x < 30) continue
      const v = abs ? p.abs[bi] : Math.min(1, p.vals[bi])
      const y = yOf(v)
      first ? g.moveTo(x, y) : g.lineTo(x, y); first = false
    }
    g.stroke(); g.lineWidth = 1
  })
}

function drawPpg() {
  if (!layerState.ppg) return
  const [g, w, h] = fit($('cv-ppg'))
  g.clearRect(0, 0, w, h)
  $('bpm').textContent = hr.bpm ? `${hr.bpm} bpm` : '– bpm'
  const d = hr.display, cnt = d.length; if (cnt < 2) return
  let sd = 0; for (const v of d) sd += v * v; sd = Math.sqrt(sd / cnt) || 1
  g.strokeStyle = '#ef5b5b'; g.beginPath()
  for (let k = 0; k < cnt; k++) {
    const x = w * (1 - (cnt - k) / 384), y = h / 2 - (d[k] / (3 * sd)) * h / 2
    k ? g.lineTo(x, y) : g.moveTo(x, y)
  }
  g.stroke()
}

function drawMotion() {
  if (!layerState.motion) return
  const [g, w, h] = fit($('cv-motion')); g.clearRect(0, 0, w, h)
  const cnt = Math.min(acc.n, ACC_N); if (cnt < 4) return
  const arrs = [acc.x, acc.y, acc.z], cols = ['#ef5b5b', '#3ecf8e', '#4da3ff']
  const get = (a, k) => a[(acc.n - cnt + k) % ACC_N]
  let peak = 0.05, mag = 0
  const means = arrs.map((a) => { let m = 0; for (let k = 0; k < cnt; k++) m += get(a, k); return m / cnt })
  arrs.forEach((a, j) => { for (let k = 0; k < cnt; k++) peak = Math.max(peak, Math.abs(get(a, k) - means[j])) })
  arrs.forEach((a, j) => {
    g.strokeStyle = cols[j]; g.beginPath()
    for (let k = 0; k < cnt; k++) { const x = w * (1 - (cnt - k) / ACC_N), y = h / 2 - ((get(a, k) - means[j]) / peak) * (h / 2 - 6); k ? g.lineTo(x, y) : g.moveTo(x, y) }
    g.stroke()
  })
  // movement score: RMS deviation over the last 1 s
  const m1 = Math.min(cnt, ACC_FS); let s2 = 0
  for (let k = cnt - m1; k < cnt; k++) arrs.forEach((a, j) => { s2 += (get(a, k) - means[j]) ** 2 })
  mag = Math.sqrt(s2 / m1)
  $('motion-state').textContent = mag < 0.02 ? 'still' : mag < 0.08 ? 'small movement' : 'moving — expect artifacts'
  g.fillStyle = '#8b95a8'; g.font = '11px sans-serif'; g.fillText(`±${peak.toFixed(2)} g   red x · green y · blue z`, 6, 12)
}

// ---------- experiment: pick a condition, Start, Stop ----------
const conditions = [...PRESETS]
const seq = { active: false, steps: [], i: -1, tStep: 0, pre: true, override: false }
function renderConditionButtons() {
  $('markers').innerHTML = ''
  for (const p of conditions) {
    const b = document.createElement('button'); b.textContent = p
    b.addEventListener('click', () => { rec.selected = p; updateCurrentUi() })
    $('markers').appendChild(b)
  }
  refreshSeqSelects()
}
const nowMs = () => (eeg.n ? eeg.t[(eeg.n - 1) % N] : 0)
function startBlock(settle = SETTLE_S) {
  if (!connected || rec.current || !rec.selected) return
  if (!pipe.lockedWeights) pipe.lockWeights()     // same channels for every block of this recording
  rec.current = rec.selected; rec.blockT0 = nowMs(); rec.curSettle = settle
  rec.blocks.push({ label: rec.current, t0: rec.blockT0, t1: null, settle })
  updateCurrentUi()
}
function endBlock() {
  if (rec.current === null) return
  rec.blocks[rec.blocks.length - 1].t1 = nowMs(); rec.current = null
  updateCurrentUi()
}
function updateCurrentUi() {
  const running = rec.current !== null
  $('current').textContent = running ? `● ${rec.current}` : rec.selected ? `Selected: ${rec.selected}` : 'Pick a condition'
  $('current').style.color = running ? 'var(--bad)' : ''
  $('btn-start').disabled = !connected || running || !rec.selected || seq.active
  $('btn-stop').disabled = !running || seq.active
  document.querySelectorAll('#markers button').forEach((b) => {
    b.classList.toggle('sel', b.textContent === (running ? rec.current : rec.selected))
    b.disabled = running || seq.active
  })
  $('btn-custom').disabled = $('custom-label').disabled = running || seq.active
  $('btn-seq').disabled = !connected || seq.active
  $('btn-seq-stop').disabled = !seq.active
}
function addCustom() {
  const v = $('custom-label').value.trim(); if (!v) return
  if (!conditions.includes(v)) { conditions.push(v); renderConditionButtons() }
  rec.selected = v; $('custom-label').value = ''; updateCurrentUi()
}
$('btn-custom').addEventListener('click', addCustom)
$('custom-label').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustom() })
$('btn-start').addEventListener('click', () => startBlock())
$('btn-stop').addEventListener('click', endBlock)

// ---------- claims (Week 3): pick a claim, write a prediction first ----------
function initClaims() {
  if (!weekCfg || !weekCfg.claims) return
  $('claim-box').hidden = false
  $('claim-select').innerHTML = '<option value="">Choose your claim…</option>' + CLAIMS.map((c) => `<option value="${c.id}">${c.name}</option>`).join('')
  $('pred-band').innerHTML = '<option value="">which feature?</option>' + Object.entries(BAND_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')
  $('claim-select').addEventListener('change', (e) => applyClaim(e.target.value))
  for (const id of ['pred-band', 'pred-dir']) $(id).addEventListener('change', readPrediction)
}
function applyClaim(id) {
  const c = CLAIMS.find((x) => x.id === id); rec.claim = id || null
  $('claim-tips').innerHTML = c ? c.tips : ''
  if (!c) return
  conditions.splice(0, conditions.length, ...(c.conditions.length ? c.conditions : PRESETS))
  rec.selected = null; renderConditionButtons(); updateCurrentUi()
  const r = String(c.range || 40); $('spec-range').value = r; $('lab-max').value = r; lab.key = ''
  if (c.channels) setChannelMode(c.channels)
  $('pred-pair').textContent = 'for B compared with A in the Compare panel'
}
function readPrediction() { rec.prediction = { band: $('pred-band').value, dir: $('pred-dir').value } }

// ---------- guided runs: the app runs the blocks; teammates watch the big cue ----------
const CUE = [
  [/closed/i, 'Close your eyes and relax — stay still (don’t squeeze).'],
  [/open/i, 'Eyes open — look at one fixed spot, stay still.'],
  [/arith|math/i, 'Silent mental arithmetic — no talking, stay still.'],
  [/clench/i, 'Clench your jaw firmly, then relax.'],
  [/medit/i, 'Meditate, eyes closed.'],
  [/rest/i, 'Rest quietly — stay still.'],
]
const cueText = (label) => (CUE.find(([re]) => re.test(label)) || [0, ''])[1]
let audioCtx = null
function beep(freq = 880, ms = 120) {
  if (!$('seq-beep').checked) return
  try {
    audioCtx = audioCtx || new AudioContext()
    const o = audioCtx.createOscillator(), g = audioCtx.createGain()
    o.frequency.value = freq; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + ms / 1000)
  } catch {}
}
function refreshSeqSelects() {
  for (const id of ['seq-a', 'seq-b']) {
    const sel = $(id), cur = sel.value
    sel.innerHTML = conditions.map((c) => `<option>${c}</option>`).join('')
    if (conditions.includes(cur)) sel.value = cur
    else sel.value = conditions[id === 'seq-a' ? 0 : Math.min(1, conditions.length - 1)] || ''
  }
}
$('seq-select').addEventListener('change', () => { $('seq-ab').hidden = $('seq-select').value !== 'abab' })
$('seq-ab').hidden = true
function buildSteps() {
  const len = Math.max(10, +$('seq-len').value || 45)
  if ($('seq-select').value === 'alpha') return ['Eyes open (1)', 'Eyes closed', 'Eyes open (2)'].map((label) => ({ label, sec: len, settle: 5 }))
  const A = $('seq-a').value, B = $('seq-b').value, reps = +$('seq-reps').value, steps = []
  if (!A || !B || A === B) return []
  for (let r = 0; r < reps; r++) steps.push({ label: A, sec: len, settle: 3 }, { label: B, sec: len, settle: 3 })
  return steps
}
function showCue(cls, label, time, sub, frac, opts = {}) {
  const el = $('cue'); el.hidden = false; el.className = cls; el.dataset.src = opts.src || 'seq'
  $('cue-plus').style.visibility = opts.plus ? 'visible' : 'hidden'
  $('cue-label').textContent = label; $('cue-time').textContent = time; $('cue-sub').textContent = sub
  $('cue-bar').firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`
}
function startSeq() {
  if (!connected || seq.active) return
  const steps = buildSteps()
  if (!steps.length) { $('seq-warn').textContent = 'Pick two different conditions for A and B first.'; return }
  const badEars = [0, 3].filter((c) => hsi.levels[c] === 2).map((c) => CH[c])
  if (badEars.length && !seq.override) {
    seq.override = true; $('btn-seq').textContent = '▶ Start anyway'
    $('seq-warn').textContent = `${badEars.join(' and ')} contact is poor — fix it first (hair behind the ears, damp sensors), or press Start again to run anyway.`
    return
  }
  seq.override = false; $('seq-warn').textContent = ''; $('btn-seq').textContent = '▶ Start guided run'
  endBlock()
  for (const st of steps) if (!conditions.includes(st.label)) conditions.push(st.label)
  renderConditionButtons()
  Object.assign(seq, { active: true, steps, i: -1, pre: true, tStep: nowMs() })
  updateCurrentUi(); beep(660); seqTick()
}
function stopSeq(msg) {
  if (!seq.active) return
  seq.active = false; endBlock(); updateCurrentUi()
  showCue('done', msg, '', 'Download your data when you are finished.', 1)
  setTimeout(() => { if (!seq.active) $('cue').hidden = true }, 8000)
}
function beginStep(i) {
  seq.pre = false; seq.i = i; seq.tStep = nowMs()
  rec.selected = seq.steps[i].label; startBlock(seq.steps[i].settle); beep(880)
}
function seqTick() {
  if (!seq.active) return
  if (!connected) { stopSeq('Guided run stopped — disconnected'); return }
  const t = nowMs()
  if (seq.pre) {
    const left = 5000 - (t - seq.tStep)
    showCue('ready', 'Get ready…', `${Math.max(0, Math.ceil(left / 1000))} s`, `First: ${seq.steps[0].label}. ${cueText(seq.steps[0].label)}`, 1 - left / 5000, { plus: true })
    if (left <= 0) beginStep(0)
    return
  }
  const st = seq.steps[seq.i], left = st.sec * 1000 - (t - seq.tStep)
  const next = seq.steps[seq.i + 1]
  showCue(/closed|medit/i.test(st.label) ? 'closed' : 'running', `● ${st.label.toUpperCase()}`, `${Math.max(0, Math.ceil(left / 1000))} s`,
    `${cueText(st.label)}   ·   block ${seq.i + 1} of ${seq.steps.length}${next ? `   ·   next: ${next.label}` : '   ·   last block'}`, 1 - left / (st.sec * 1000), { plus: !/closed|medit/i.test(st.label) })
  if (left <= 0) {
    endBlock()
    if (next) beginStep(seq.i + 1)
    else { seq.active = false; updateCurrentUi(); beep(660, 250); showCue('done', '✔ Done', '', 'All blocks recorded. Open Compare / Spectrum lab below, then download your data.', 1); setTimeout(() => { if (!seq.active) $('cue').hidden = true }, 20000) }
  }
}
$('btn-seq').addEventListener('click', startSeq)
$('btn-seq-stop').addEventListener('click', () => stopSeq('Guided run stopped'))
setInterval(seqTick, 200)

// cue + fixation cross for manual Start/Stop blocks, and the optional big cross in the middle of the screen
const NO_FIX = /closed|medit/i
function updateFixOverlay() {
  const label = seq.active ? (seq.pre ? seq.steps[0].label : seq.steps[seq.i].label) : rec.current
  $('fix-overlay').hidden = !($('chk-fix').checked && label && !NO_FIX.test(label))
}
function manualCueTick() {
  updateFixOverlay()
  if (seq.active) return
  const el = $('cue')
  if (rec.current) {
    const closed = NO_FIX.test(rec.current), s = Math.max(0, Math.floor(blockAge()))
    showCue(closed ? 'closed' : 'running', `● ${rec.current.toUpperCase()}`, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
      cueText(rec.current) || 'Block running — press Stop when you finish.', 0, { plus: !closed, src: 'manual' })
  } else if (!el.hidden && el.dataset.src === 'manual') el.hidden = true
}
setInterval(manualCueTick, 200)
$('chk-fix').addEventListener('change', updateFixOverlay)

const blockCutoff = (r) => r.age < (r.settle ?? SETTLE_S)
function updateSummary() {
  const el = $('summary')
  if (!layerState.bands) { el.hidden = true; return }
  const abs = isAbs()
  const groups = new Map()
  for (const r of rec.bandRows) {
    if (!r.cond || blockCutoff(r) || (!abs && !r.ready)) continue
    if (!groups.has(r.cond)) groups.set(r.cond, { n: 0, sum: [0, 0, 0, 0, 0] })
    const g = groups.get(r.cond); g.n++; (abs ? r.abs : r.vals).forEach((v, i) => { g.sum[i] += v })
  }
  if (!groups.size) { el.hidden = true; return }
  const withDelta = abs || pipe.normalizeBands.has('delta')
  const cols = BANDS.map((b, i) => [b, i]).filter(([b]) => b !== 'delta' || withDelta)
  const refName = groups.has($('cmp-a').value) ? $('cmp-a').value : [...groups.keys()][0]
  const rows = [[refName, groups.get(refName)], ...[...groups.entries()].filter(([n]) => n !== refName)], base = groups.get(refName)
  let html = `<table><tr><th>Condition (mean ${abs ? 'band power, dB' : 'band share'})</th><th>time</th>` + cols.map(([b]) => `<th style="color:${BAND_COLORS[b]}">${BAND_LABEL[b].split(' ')[0]}</th>`).join('') + '</tr>'
  rows.forEach(([name, g], ri) => {
    html += `<tr><td>${name}${ri === 0 ? ' <span class="sub">(reference)</span>' : ''}</td><td>${Math.round(g.n / 2)} s</td>` + cols.map(([b, i]) => {
      const m = g.sum[i] / g.n, m0 = base.sum[i] / base.n
      if (abs) {
        if (ri === 0) return `<td>${m.toFixed(1)}</td>`
        const d = m - m0
        return `<td>${m.toFixed(1)} <span class="${d > 0.05 ? 'up' : d < -0.05 ? 'down' : ''}">(${d > 0 ? '+' : ''}${d.toFixed(1)} dB)</span></td>`
      }
      const pct = Math.round(m * 100)
      if (ri === 0 || m0 <= 0) return `<td>${pct}%</td>`
      const d = Math.round((m / m0 - 1) * 100)
      return `<td>${pct}% <span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">(${d > 0 ? '+' : ''}${d}%)</span></td>`
    }).join('') + '</tr>'
  })
  el.innerHTML = html + `</table><div class="sub">Change in brackets is relative to the reference row — the A you chose in Compare, otherwise the first condition you ran. The first seconds of each block are ignored (2 s; 3–5 s in guided runs).${abs ? '' : ' Relative values start ~15 s after connecting.'}</div>`
  el.hidden = false
}

// ---------- compare two conditions (average spectra and their difference) ----------
function condSpectrum(cond) {
  const rows = rec.specRows.filter((r) => r.cond === cond && !blockCutoff(r))
  if (rows.length < 4) return null
  const m = new Float32Array(SPEC_BINS)
  for (const r of rows) for (let f = 0; f < SPEC_BINS; f++) m[f] += r.col[f] / rows.length
  return { m, n: rows.length }
}
const F1 = Array.from({ length: SPEC_BINS }, (_, i) => i + 1)
function updateCompareOptions() {
  const names = [...new Set(rec.specRows.filter((r) => !blockCutoff(r)).map((r) => r.cond))].filter((n) => condSpectrum(n))
  const box = $('compare'); box.hidden = names.length < 2
  if (names.length < 2) return
  for (const id of ['cmp-a', 'cmp-b']) {
    const sel = $(id), cur = sel.value
    if (sel.options.length !== names.length || [...sel.options].some((o, i) => o.value !== names[i])) {
      sel.innerHTML = names.map((n) => `<option>${n}</option>`).join('')
      sel.value = names.includes(cur) ? cur : (id === 'cmp-a' ? names[0] : names[1])
    }
  }
}
const bandMean = (arr, name) => { let s = 0, n = 0; for (const [a, b] of BAND_BINS[name]) for (let f = a; f <= b; f++) { s += arr[f - 1]; n++ } return s / n }
function drawCompare() {
  if ($('compare').hidden) return
  const A = condSpectrum($('cmp-a').value), B = condSpectrum($('cmp-b').value)
  const [g, w, h] = fit($('cv-cmp')); g.clearRect(0, 0, w, h)
  if (!A || !B) return
  const nb = +$('spec-range').value
  const L = 36, top = h * 0.55, fx = (f) => L + ((f - 1) / (nb - 1)) * (w - L - 6)
  g.fillStyle = 'rgba(245,185,66,0.10)'; g.fillRect(fx(8), 0, fx(13) - fx(8), h)
  if (nb > 60) { g.fillStyle = 'rgba(139,149,168,0.18)'; g.fillRect(fx(58), 0, fx(62) - fx(58), h) }
  g.font = '11px sans-serif'; g.fillStyle = '#f5b942'; g.fillText('alpha', fx(8) + 3, 11)
  const dbA = Array.from(A.m, (v) => 10 * v), dbB = Array.from(B.m, (v) => 10 * v)
  const vis = (arr) => arr.slice(0, nb)
  const lo = Math.min(...vis(dbA), ...vis(dbB)) - 1, hi = Math.max(...vis(dbA), ...vis(dbB)) + 1
  const yT = (v) => top - 6 - ((v - lo) / (hi - lo)) * (top - 22)
  g.strokeStyle = '#1f2633'; g.beginPath(); g.moveTo(L, top); g.lineTo(w, top); g.stroke()
  const line = (arr, col) => { g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); vis(arr).forEach((v, i) => { const x = fx(i + 1), y = yT(v); i ? g.lineTo(x, y) : g.moveTo(x, y) }); g.stroke(); g.lineWidth = 1 }
  line(dbA, '#8b95a8'); line(dbB, '#4da3ff')
  g.fillStyle = '#8b95a8'; g.fillText(`A: ${$('cmp-a').value}`, L + 4, 12 + 12); g.fillStyle = '#4da3ff'; g.fillText(`B: ${$('cmp-b').value}`, L + 4, 12 + 26)
  g.fillStyle = '#8b95a8'; g.fillText('dB', 4, 12)
  const diff = dbB.map((v, i) => v - dbA[i]), mx = Math.max(3, ...vis(diff).map(Math.abs)), mid = top + (h - top) / 2, amp = (h - top) / 2 - 14
  g.strokeStyle = '#3a4459'; g.beginPath(); g.moveTo(L, mid); g.lineTo(w, mid); g.stroke()
  const bw = (w - L - 6) / nb
  vis(diff).forEach((d, i) => { g.fillStyle = d >= 0 ? '#3ecf8e' : '#ef5b5b'; const y = (d / mx) * amp; g.fillRect(fx(i + 1) - bw / 2, d >= 0 ? mid - y : mid, bw - 1, Math.abs(y)) })
  g.fillStyle = '#8b95a8'; g.fillText('B − A (dB)', 4, top + 12); g.fillText(`±${mx.toFixed(0)}`, 4, mid - amp)
  for (const f of (nb > 60 ? [8, 13, 30, 60] : [4, 8, 13, 30])) { g.fillStyle = '#8b95a8'; g.fillText(`${f}`, fx(f) - 5, h - 2) }
  g.fillText('Hz', w - 18, h - 2)
  const fmt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
  const pa = peakAbove(F1, dbA, 8, 13, 0), pb = peakAbove(F1, dbB, 8, 13, 0)
  const pk = (p) => (p.strength === 'none' ? 'no clear peak' : `${p.iaf.toFixed(1)} Hz, ${p.height.toFixed(1)} dB above background${p.strength === 'weak' ? ' (weak)' : ''}`)
  let txt = `B vs A — theta ${fmt(bandMean(diff, 'theta'))} · alpha ${fmt(bandMean(diff, 'alpha'))} · beta ${fmt(bandMean(diff, 'beta'))}${nb > 60 ? ` · 40–80 Hz ${fmt(bandMean(diff, 'hf'))}` : ''}  (3 dB ≈ 2× power; A used ${A.n / 2} s, B ${B.n / 2} s)\nAlpha peak (coarse, 1 Hz bins; Spectrum lab has the precise IAF) — A: ${pk(pa)} · B: ${pk(pb)}   [channels: ${CH_MODE_LABEL[pipe.channelMode]}]`
  const pr = rec.prediction
  if (pr && pr.band && pr.dir) {
    const d = bandMean(diff, pr.band), obs = d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'same'
    txt += `\nYour prediction — ${BAND_NAMES[pr.band]} ${{ up: 'goes UP', down: 'goes DOWN', same: 'does not change' }[pr.dir]}: observed ${fmt(d)} → ${obs === pr.dir ? '✔ matches' : '✘ does not match'}`
  }
  $('cmp-note').textContent = txt
}

// ---------- Spectrum lab: compare channels, or compare references, on a finished block ----------
const lab = { key: '', res: null, eMode: '' }
const lowerBound = (tRel) => { let lo = 0, hi = rec.rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rec.rows[m][0] < tRel) lo = m + 1; else hi = m } return lo }
const usableBlocks = (cond) => rec.blocks.filter((b) => b.label === cond && b.t1 != null && (b.t1 - b.t0) / 1000 - (b.settle ?? SETTLE_S) >= 4.2)
function labSegments(cond) {
  const segs = []
  for (const b of usableBlocks(cond)) {
    const i0 = lowerBound(b.t0 - rec.t0 + (b.settle ?? SETTLE_S) * 1000), i1 = lowerBound(b.t1 - rec.t0)
    if (i1 - i0 < 1024) continue
    segs.push([0, 1, 2, 3].map((c) => { const a = new Float64Array(i1 - i0); for (let i = i0; i < i1; i++) a[i - i0] = rec.rows[i][1 + c]; return a }))
  }
  return segs
}
const LAB_PALETTE = ['#8b95a8', '#4da3ff', '#3ecf8e', '#f5b942', '#ef7b5b', '#c78bff', '#e6e9ef']
function updateLabOptions() {
  const names = [...new Set(rec.blocks.filter((b) => b.t1 != null).map((b) => b.label))].filter((n) => usableBlocks(n).length)
  $('lab').hidden = !names.length
  if (!names.length) return
  const mode = $('lab-mode').value
  const sel = $('lab-cond'), cur = sel.value
  if (sel.options.length !== names.length || [...sel.options].some((o, i) => o.value !== names[i])) {
    sel.innerHTML = names.map((n) => `<option>${n}</option>`).join('')
    sel.value = names.includes(cur) ? cur : names[names.length - 1]
  }
  $('lab-cond-wrap').hidden = mode !== 'reference' && mode !== 'channels'
  $('lab-e-wrap').hidden = mode === 'channels'
  if (lab.eMode !== mode) {       // electrode choices depend on the view ("both ears" only makes sense when comparing blocks)
    const prev = $('lab-e').value
    $('lab-e').innerHTML = '<option value="0">TP9</option><option value="3">TP10</option><option value="1">AF7</option><option value="2">AF8</option>' + (mode === 'blocks' ? '<option value="ears">Both ears (TP9 + TP10)</option>' : '')
    $('lab-e').value = [...$('lab-e').options].some((o) => o.value === prev) ? prev : (mode === 'blocks' ? 'ears' : '0')
    lab.eMode = mode; lab.key = ''
  }
}
function computeLab() {
  const mode = $('lab-mode').value, cond = $('lab-cond').value, eRaw = $('lab-e').value, max = +$('lab-max').value
  const done = rec.blocks.filter((b) => b.t1 != null).length
  const key = [mode, cond, eRaw, max, done].join('|')
  if (key === lab.key) return
  lab.key = key
  const nf = Math.round(max / DF)
  const mk = (name, color, segs, getters) => {      // average the PSD over getters (e.g. both ears), then alpha metrics
    let pw = null, n = 0
    for (const get of getters) { const r = psd(segs.map(get), nf); n = r.n; pw = pw ? pw.map((v, i) => v + r.pw[i]) : Float64Array.from(r.pw) }
    for (let k = 0; k < pw.length; k++) pw[k] /= getters.length
    return { name, color, pw, n, m: alphaMetrics(pw) }
  }
  const e = eRaw === 'ears' ? 'ears' : +eRaw
  let sigs = []
  if (mode === 'blocks') {
    const labels = [...new Set(rec.blocks.filter((b) => b.t1 != null).map((b) => b.label))].filter((n) => usableBlocks(n).length)
    const getters = e === 'ears' ? [(X) => derive(X, 0, 'device'), (X) => derive(X, 3, 'device')] : [(X) => derive(X, e, 'device')]
    sigs = labels.map((label, i) => mk(label, LAB_PALETTE[i % LAB_PALETTE.length], labelSegs(label), getters))
  } else {
    const segs = labSegments(cond)
    if (!segs.length) { lab.res = null; return }
    sigs = mode === 'channels'
      ? [0, 3, 1, 2].map((c) => mk(ELECTRODES[c], COLORS[c], segs, [(X) => derive(X, c, 'device')]))
      : REFERENCES.map((r, i) => mk(r.label, ['#e6e9ef', '#4da3ff', '#3ecf8e', '#ef7b5b'][i], segs, [(X) => derive(X, e === 'ears' ? 0 : e, r.id)]))
  }
  lab.res = { mode, max, nf, cond, e: e === 'ears' ? 'ears' : e, sigs }
}
const labelSegs = (label) => labSegments(label)
function drawLab() {
  if ($('lab').hidden) return
  computeLab()
  const [g, w, h] = fit($('cv-lab')); g.clearRect(0, 0, w, h)
  const R = lab.res; if (!R || !R.sigs.length) return
  const k0 = Math.round(1 / DF) - 1, nf = R.nf
  const db = (v) => 10 * Math.log10(Math.max(v, 1e-12))
  let lo = Infinity, hi = -Infinity
  for (const s of R.sigs) for (let k = k0; k < nf; k++) { const v = db(s.pw[k]); if (v < lo) lo = v; if (v > hi) hi = v }
  lo -= 1; hi += 1
  const L = 36, pad = 16, fx = (f) => L + ((f - 1) / (R.max - 1)) * (w - L - 6), yOf = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - pad - 8)
  g.fillStyle = 'rgba(245,185,66,0.10)'; g.fillRect(fx(8), 0, fx(13) - fx(8), h - pad)
  if (R.max > 60) { g.fillStyle = 'rgba(139,149,168,0.18)'; g.fillRect(fx(58), 0, fx(62) - fx(58), h - pad) }
  g.font = '11px sans-serif'; g.fillStyle = '#f5b942'; g.fillText('alpha', fx(8) + 3, 11)
  g.strokeStyle = '#1f2633'; g.fillStyle = '#8b95a8'
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) * i) / 4, y = yOf(v); g.beginPath(); g.moveTo(L, y); g.lineTo(w, y); g.stroke(); g.fillText(v.toFixed(0), 4, y + 4) }
  for (const f of (R.max > 60 ? [8, 13, 30, 60] : [4, 8, 13, 30])) g.fillText(`${f}`, fx(f) - 5, h - 2)
  g.fillText('Hz   (dB re 1 µV²/Hz)', w - 118, h - 2)
  R.sigs.forEach((s, si) => {
    g.strokeStyle = s.color; g.lineWidth = 1.8; g.beginPath()
    for (let k = k0; k < nf; k++) { const x = fx(FREQS[k]), y = yOf(db(s.pw[k])); k === k0 ? g.moveTo(x, y) : g.lineTo(x, y) }
    g.stroke(); g.lineWidth = 1
    if (s.m.strength !== 'none') { const x = fx(s.m.iaf); g.fillStyle = s.color; g.beginPath(); g.moveTo(x, 16); g.lineTo(x - 4, 8); g.lineTo(x + 4, 8); g.closePath(); g.fill() }
    g.fillStyle = s.color; g.textAlign = 'right'; g.fillText(s.name, w - 10, 14 + si * 13); g.textAlign = 'left'
  })
  const base = R.sigs[0].m
  const deltaKey = R.mode === 'reference' ? 'bandDb' : R.mode === 'blocks' ? 'aboveDb' : null
  const dcell = (s, key, i) => (i && deltaKey === key ? ` <span class="${s.m[key] - base[key] >= 0 ? 'up' : 'down'}">(${s.m[key] - base[key] >= 0 ? '+' : ''}${(s.m[key] - base[key]).toFixed(1)})</span>` : '')
  $('lab-table').innerHTML = `<table><tr><th>${R.mode === 'blocks' ? 'Block' : 'Signal'}</th><th>raw 8–13 Hz power</th><th>alpha above 1/f background</th><th>alpha peak (IAF)</th><th>peak above 1/f</th></tr>` +
    R.sigs.map((s, i) => `<tr><td style="color:${s.color}">${s.name}</td><td>${s.m.bandDb.toFixed(1)} dB${dcell(s, 'bandDb', i)}</td><td>${s.m.aboveDb.toFixed(1)} dB${dcell(s, 'aboveDb', i)}</td><td>${peakLabel(s.m)}</td><td>${s.m.strength === 'none' ? '–' : s.m.height.toFixed(1) + ' dB'}</td></tr>`).join('') + '</table>'
  const eName = R.e === 'ears' ? 'both ears (TP9 + TP10)' : ELECTRODES[R.e]
  let note = ''
  if (R.mode === 'reference') {
    const pw = R.sigs.map((s) => s.m.bandDb), clear = R.sigs.filter((s) => s.m.strength === 'clear').map((s) => s.m.iaf)
    note = `Same recording, ${eName}: raw alpha power spans ${(Math.max(...pw) - Math.min(...pw)).toFixed(1)} dB across references` +
      (clear.length > 1 ? `, while the clear peak moves by only ${(Math.max(...clear) - Math.min(...clear)).toFixed(2)} Hz.` : ', and the peaks here are too weak (under 3 dB above background) to compare their position reliably.') +
      ' With only four electrodes an “average reference” is a rough approximation.' +
      (R.e === 0 || R.e === 3 ? ' For an ear electrode, “linked ears” and “bipolar” have the same shape: linked = bipolar ÷ 2, so it sits 6 dB lower.' : '')
  } else if (R.mode === 'blocks') {
    const best = R.sigs.reduce((a, b) => (b.m.aboveDb > a.m.aboveDb ? b : a))
    note = `${eName}: alpha above the 1/f background is highest in “${best.name}” (${best.m.aboveDb.toFixed(1)} dB). Raw 8–13 Hz power can mislead when the low-frequency background differs between blocks (eye movements, blinks); “above 1/f background” and the peak columns correct for that.`
  } else {
    const t9 = R.sigs.find((s) => s.name === 'TP9').m, t10 = R.sigs.find((s) => s.name === 'TP10').m
    note = `TP9 vs TP10: alpha above background differs by ${Math.abs(t9.aboveDb - t10.aboveDb).toFixed(1)} dB; peaks ${peakLabel(t9)} vs ${peakLabel(t10)}. Check both ear contacts were green — a poor ear sensor can hide alpha.`
  }
  $('lab-note').textContent = note + `  [${R.sigs[0].n} windows of 4 s${R.mode === 'blocks' ? ' (first block)' : `, ${usableBlocks(R.cond).length} block(s)`}]`
}
for (const id of ['lab-cond', 'lab-mode', 'lab-e', 'lab-max']) $(id).addEventListener('change', () => { lab.key = '' })

// ---------- result card (PNG) for the debrief ----------
function saveCard() {
  const cv = document.createElement('canvas'); cv.width = 1400; cv.height = 900
  const g = cv.getContext('2d')
  g.fillStyle = '#0f1218'; g.fillRect(0, 0, 1400, 900)
  g.fillStyle = '#e6e9ef'; g.font = 'bold 34px sans-serif'; g.fillText('Brain Dynamics Lab · PSYC 20N', 40, 56)
  g.fillStyle = '#8b95a8'; g.font = '20px sans-serif'
  const claim = CLAIMS.find((c) => c.id === rec.claim)
  g.fillText(`${claim ? claim.name : 'Experiment'}   ·   ${new Date().toLocaleDateString()}`, 40, 92)
  g.fillText(`A: ${$('cmp-a').value}     B: ${$('cmp-b').value}`, 40, 124)
  g.drawImage($('cv-cmp'), 40, 150, 1320, 460)
  g.fillStyle = '#e6e9ef'; g.font = '19px sans-serif'
  let y = 650
  for (const line of $('cmp-note').textContent.split('\n')) {
    let cur = ''
    for (const wd of line.split(' ')) { if ((cur + wd).length > 118) { g.fillText(cur, 40, y); y += 28; cur = '' } cur += wd + ' ' }
    g.fillText(cur, 40, y); y += 30
  }
  g.fillStyle = '#8b95a8'; g.font = '16px sans-serif'; g.fillText('bdl.stanford.edu/muse-web · classroom observation, not research data', 40, 880)
  cv.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `result-card-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000) })
}
$('btn-card').addEventListener('click', saveCard)

const csvQuote = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
function downloadZip() {
  if (!rec.rows.length) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const tag = `muse-${simulated ? 'practice-' : ''}${stamp}`
  const f3 = (v) => v.toFixed(3)
  const files = [
    { name: `${tag}/eeg.csv`, text: 'time_s,TP9,AF7,AF8,TP10,condition\n' + rec.rows.map((r) => `${(r[0] / 1000).toFixed(4)},${r[1].toFixed(2)},${r[2].toFixed(2)},${r[3].toFixed(2)},${r[4].toFixed(2)},${csvQuote(r[5])}`).join('\n') + '\n' },
    { name: `${tag}/bands.csv`, text: 'time_s,rel_delta,rel_theta,rel_alpha,rel_beta,rel_gamma,abs_delta_dB,abs_theta_dB,abs_alpha_dB,abs_beta_dB,abs_gamma_dB,rel_ready,channels,condition\n' + rec.bandRows.map((r) => `${(r.t / 1000).toFixed(3)},${r.vals.map((v) => v.toFixed(4)).join(',')},${r.abs.map((v) => v.toFixed(2)).join(',')},${r.ready ? 1 : 0},${r.ch},${csvQuote(r.cond)}`).join('\n') + '\n' },
    { name: `${tag}/signal_quality.csv`, text: 'time_s,hsi_TP9,hsi_AF7,hsi_AF8,hsi_TP10,p2p_TP9,p2p_AF7,p2p_AF8,p2p_TP10\n' + rec.quality.map((r) => `${(r[0] / 1000).toFixed(3)},${r.slice(1, 5).join(',')},${r.slice(5).map((v) => v.toFixed(1)).join(',')}`).join('\n') + '\n' },
    { name: `${tag}/accelerometer.csv`, text: 'time_s,x,y,z,condition\n' + rec.accRows.map((r) => `${(r[0] / 1000).toFixed(3)},${r[1].toFixed(4)},${r[2].toFixed(4)},${r[3].toFixed(4)},${csvQuote(r[4])}`).join('\n') + '\n' },
    { name: `${tag}/ppg_infrared.csv`, text: 'time_s,ppg_ir,condition\n' + rec.ppgRows.map((r) => `${(r[0] / 1000).toFixed(3)},${r[1]},${csvQuote(r[2])}`).join('\n') + '\n' },
    { name: `${tag}/blocks.csv`, text: 'condition,start_s,end_s,settle_s\n' + rec.blocks.map((b) => `${csvQuote(b.label)},${((b.t0 - rec.t0) / 1000).toFixed(3)},${b.t1 == null ? '' : ((b.t1 - rec.t0) / 1000).toFixed(3)},${b.settle ?? SETTLE_S}`).join('\n') + '\n' },
    { name: `${tag}/README.txt`, text: 'Brain Dynamics Lab (PSYC 20N)\neeg.csv: raw EEG, microvolts, 256 Hz. bands.csv (~2 Hz): rel_* = nouscope-style relative band shares (1/f-corrected, sum to 1; delta 0 unless included; valid when rel_ready=1, ~15 s after connecting); abs_*_dB = absolute band power in dB re 1 µV² (delta 1-3 Hz, theta 4-7, alpha 8-12, beta 13-29, gamma 30-40); channels = channel mode and the electrodes actually used, e.g. weighted:TP9+TP10 (weighted = best-contact auto, locked at the first block of a recording; posterior = TP9+TP10, frontal = AF7+AF8, all, or a single electrode tp9/tp10/af7/af8).\nsignal_quality.csv: muse-lsl HSI per channel (0 good, 1 ok, 2 poor) + peak-to-peak µV, 2 Hz. accelerometer.csv: g, 52 Hz. ppg_infrared.csv: raw counts, 64 Hz. blocks.csv: start/stop of each condition (settle_s = seconds ignored at the start of each block in summaries).\nTimes are seconds since the first EEG sample.\n' },
  ]
  const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files)); a.download = `${tag}.zip`; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}
$('btn-download').addEventListener('click', downloadZip)
function setChannelMode(v) { $('ch-mode').value = v; pipe.channelMode = v; pipe.unlockWeights(); spec.cols = []; updateChannelWarning() }
$('ch-mode').addEventListener('change', (e) => setChannelMode(e.target.value))
if (weekCfg && weekCfg.channels) setChannelMode(weekCfg.channels)
$('pwr-mode').addEventListener('change', (e) => { $('delta-label').hidden = e.target.value === 'absolute' })
$('chk-delta').addEventListener('change', (e) => {
  pipe.normalizeBands = new Set(e.target.checked ? BANDS : ['theta', 'alpha', 'beta', 'gamma'])
})

initClaims()
renderConditionButtons()

// ---------- buttons / loop ----------
$('btn-connect').addEventListener('click', () => connect(false))
$('btn-sim').addEventListener('click', () => connect(true))
$('btn-disconnect').addEventListener('click', disconnect)

let lastSlow = 0
function frame(now) {
  if (now - lastSlow > 250) {
    lastSlow = now
    if (connected) updateQuality()
    updateSummary(); updateCompareOptions(); updateLabOptions()
    $('panel-results').hidden = $('summary').hidden && $('compare').hidden && $('lab').hidden
    if (rec.t0 !== null && rec.rows.length) {
      const s = Math.floor(rec.rows[rec.rows.length - 1][0] / 1000)
      $('rec-time').textContent = `Recording ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` + (rec.current ? `  ·  ${rec.current}: ${Math.max(0, Math.floor(blockAge()))} s` : '')
    }
  }
  drawEeg(); drawBands(); drawSpec(); drawPpg(); drawMotion(); drawCompare(); drawLab()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
if (params.get('sim') === 'auto') connect(true)
