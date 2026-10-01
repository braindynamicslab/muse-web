import { MuseClient, zipSamples } from 'muse-js'
import SimulatedMuse from './sim.js'
import { BandPipeline, HeartRate, BANDS, SPEC_BINS } from './dsp.js'
import { HSI, LEVEL, REASON } from './quality.js'
import { makeZip } from './zip.js'

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

// ---------- layers ----------
const layerState = { bands: true, spectrogram: true, ppg: false, motion: false }
const lockedLayers = params.has('layers')
if (lockedLayers) {
  const on = params.get('layers').split(',')
  for (const l of LAYERS) layerState[l] = on.includes(l)
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
const rec = { t0: null, rows: [], blocks: [], current: null, blockT0: 0, selected: null,
              bandRows: [], bandHist: [], specRows: [], accRows: [], ppgRows: [], quality: [] }
const spec = { cols: [] }
let lastTs = 0, batteryPct = null
let client = null, subs = [], connected = false, simulated = false

const blockAge = () => (rec.current ? (lastTs - rec.blockT0) / 1000 : 0)
pipe.onColumn = (col) => {
  spec.cols.push(col); if (spec.cols.length > SPEC_COLS) spec.cols.shift()
  if (rec.current) rec.specRows.push({ cond: rec.current, age: blockAge(), col })
}
hsi.onUpdate = (levels, detail) => {
  pipe.quality = levels.map((l) => LEVEL_TO_Q[l])
  rec.quality.push([lastTs - rec.t0, ...levels, ...detail.map((q) => q.p2p)])
}
pipe.onBands = (bp, ready) => {
  if (!ready) return
  const vals = BANDS.map((b) => bp[b])
  rec.bandHist.push({ t: lastTs, vals })
  while (rec.bandHist.length && lastTs - rec.bandHist[0].t > BAND_WIN_MS + 5000) rec.bandHist.shift()
  rec.bandRows.push({ t: lastTs - rec.t0, cond: rec.current || '', age: blockAge(), vals })
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
    r.samples.forEach((v, i) => { hr.push(v); if (rec.t0 !== null) rec.ppgRows.push([r.timestamp + (i * 1000) / 64 - rec.t0, v, rec.current || '']) })
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
  spec.cols = []; hsi.reset(); acc.n = 0; batteryPct = null
  rec.rows = []; rec.blocks = []; rec.current = null; rec.bandRows = []; rec.bandHist = []; rec.specRows = []; rec.accRows = []; rec.ppgRows = []; rec.quality = []
  updateCurrentUi(); updateBattery()
}

// ---------- EEG ingest ----------
const hpA = 1 / (1 + 2 * Math.PI * HP_FC / FS)
function onEegSample(s) {
  const d = s.data
  if (rec.t0 === null) rec.t0 = s.timestamp
  lastTs = s.timestamp
  const i = eeg.n % N
  eeg.t[i] = s.timestamp
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
  rec.rows.push([s.timestamp - rec.t0, d[0], d[1], d[2], d[3], rec.current || ''])
}

// ---------- quality UI (muse-lsl HSI) ----------
function updateQuality() {
  if (eeg.n < FS) return
  const hint = []
  hsi.levels.forEach((l, c) => {
    const d = hsi.detail[c]
    if (l > 0) hint.push(`${CH[c]} (${CH_INFO[c]}): ${d.raw > 0 ? REASON[d.worst] : 'looks better now — hold still a few seconds'}`)
  })
  $('fit-hint').textContent = hint.length ? hint.join('  ·  ') : 'All four contacts look good. Sit still for a few seconds.'
  document.querySelectorAll('#quality .q').forEach((el, c) => {
    const d = hsi.detail[c]
    el.className = `q ${LEVEL_TO_Q[hsi.levels[c]]}`
    el.title = `${LEVEL[hsi.levels[c]]} — amplitude ${d.p2p.toFixed(0)} µV p-p · muscle ${d.muscle.toFixed(2)} · line noise ${d.line.toFixed(1)}× · clipping ${(d.sat * 100).toFixed(0)}% · drift ${d.drift.toFixed(2)}`
  })
}
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
  const flat = $('chk-flat').checked
  let lo, hi, med
  if (flat) {                         // display aid: subtract each frequency's typical level → alpha pops out
    med = new Float32Array(SPEC_BINS)
    for (let f = 0; f < SPEC_BINS; f++) { const v = cols.map((c) => c[f]).sort((a, b) => a - b); med[f] = v[Math.floor(v.length / 2)] }
    lo = -0.8; hi = 0.8
  } else {                            // nouscope scaling: 5th–90th percentile of visible values, capped, ≥2 decades
    const all = []; for (const c of cols) for (const v of c) all.push(Math.min(v, 8.2))
    all.sort((a, b) => a - b)
    lo = all[Math.floor(all.length * 0.05)]; hi = all[Math.floor(all.length * 0.9)]
    if (hi - lo < 2) { const m = (hi + lo) / 2; lo = m - 1; hi = m + 1 }
  }
  const cw = w / SPEC_COLS, rh = h / SPEC_BINS
  for (let k = 0; k < cols.length; k++) {
    const x = w - (cols.length - k) * cw
    for (let f = 0; f < SPEC_BINS; f++) {
      const v = flat ? cols[k][f] - med[f] : Math.min(cols[k][f], 8.2)
      const [r, gg, b] = viridis((v - lo) / (hi - lo))
      g.fillStyle = `rgb(${r},${gg},${b})`
      g.fillRect(x, h - (f + 1) * rh, cw + 1, rh + 1)
    }
  }
  g.fillStyle = '#fff'; g.font = '11px sans-serif'
  for (const f of [4, 8, 13, 30]) g.fillText(`${f} Hz`, 4, h - f * rh - 2)
  g.strokeStyle = '#ffffff55'; g.setLineDash([3, 4])
  for (const f of [8, 13]) { g.beginPath(); g.moveTo(0, h - f * rh); g.lineTo(w, h - f * rh); g.stroke() }
  g.setLineDash([])
}
function drawBands() {
  if (!layerState.bands) return
  const [g, w, h] = fit($('cv-bands'))
  g.clearRect(0, 0, w, h)
  const withDelta = pipe.normalizeBands.has('delta')
  const cur = pipe.bandPower
  $('band-chips').innerHTML = BANDS.map((b) => `<span class="chip${b === 'delta' && !withDelta ? ' off' : ''}"><i style="background:${BAND_COLORS[b]}"></i>${BAND_LABEL[b]} <b>${pipe.ready && (b !== 'delta' || withDelta) ? Math.round(cur[b] * 100) + '%' : '–'}</b></span>`).join('')
  const note = $('band-note')
  if (!connected && !rec.bandHist.length) note.textContent = 'Connect to see band power.'
  else if (!pipe.ready) note.textContent = `Calibrating the 1/f background model… ${Math.round(pipe.warmupFraction * 100)}% (about 15 s after connecting). Sit still.`
  else note.textContent = 'Shares add to 100%. A band rising means it gained power relative to the others, after correcting for the 1/f slope.'
  g.font = '11px sans-serif'
  for (const y of [0, 0.25, 0.5, 0.75, 1]) {
    const py = h - 14 - y * (h - 20)
    g.strokeStyle = '#1f2633'; g.beginPath(); g.moveTo(30, py); g.lineTo(w, py); g.stroke()
    g.fillStyle = '#8b95a8'; g.fillText(`${Math.round(y * 100)}%`, 2, py + 4)
  }
  const hist = rec.bandHist; if (hist.length < 2) return
  const tR = hist[hist.length - 1].t
  const xOf = (t) => 30 + (w - 30) * (1 - (tR - t) / BAND_WIN_MS)
  drawBlocks(g, xOf, 30, w, h - 14, 12)
  BANDS.forEach((b, bi) => {
    if (b === 'delta' && !withDelta) return
    g.strokeStyle = BAND_COLORS[b]; g.lineWidth = b === 'alpha' ? 2.5 : 1.5; g.beginPath()
    let first = true
    for (const p of hist) {
      const x = xOf(p.t); if (x < 30) continue
      const y = h - 14 - Math.min(1, p.vals[bi]) * (h - 20)
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
function renderConditionButtons() {
  $('markers').innerHTML = ''
  for (const p of conditions) {
    const b = document.createElement('button'); b.textContent = p
    b.addEventListener('click', () => { rec.selected = p; updateCurrentUi() })
    $('markers').appendChild(b)
  }
}
renderConditionButtons()
const nowMs = () => (eeg.n ? eeg.t[(eeg.n - 1) % N] : 0)
function startBlock() {
  if (!connected || rec.current || !rec.selected) return
  rec.current = rec.selected; rec.blockT0 = nowMs()
  rec.blocks.push({ label: rec.current, t0: rec.blockT0, t1: null })
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
  $('btn-start').disabled = !connected || running || !rec.selected
  $('btn-stop').disabled = !running
  document.querySelectorAll('#markers button').forEach((b) => {
    b.classList.toggle('sel', b.textContent === (running ? rec.current : rec.selected))
    b.disabled = running
  })
  $('btn-custom').disabled = $('custom-label').disabled = running
}
function addCustom() {
  const v = $('custom-label').value.trim(); if (!v) return
  if (!conditions.includes(v)) { conditions.push(v); renderConditionButtons() }
  rec.selected = v; $('custom-label').value = ''; updateCurrentUi()
}
$('btn-custom').addEventListener('click', addCustom)
$('custom-label').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustom() })
$('btn-start').addEventListener('click', startBlock)
$('btn-stop').addEventListener('click', endBlock)

function updateSummary() {
  const el = $('summary')
  if (!layerState.bands) { el.hidden = true; return }
  const groups = new Map()
  for (const r of rec.bandRows) {
    if (!r.cond || r.age < SETTLE_S) continue
    if (!groups.has(r.cond)) groups.set(r.cond, { n: 0, sum: [0, 0, 0, 0, 0] })
    const g = groups.get(r.cond); g.n++; r.vals.forEach((v, i) => { g.sum[i] += v })
  }
  if (!groups.size) { el.hidden = true; return }
  const withDelta = pipe.normalizeBands.has('delta')
  const cols = BANDS.map((b, i) => [b, i]).filter(([b]) => b !== 'delta' || withDelta)
  const rows = [...groups.entries()], base = rows[0][1]
  let html = '<table><tr><th>Condition (mean band share)</th><th>time</th>' + cols.map(([b]) => `<th style="color:${BAND_COLORS[b]}">${BAND_LABEL[b].split(' ')[0]}</th>`).join('') + '</tr>'
  rows.forEach(([name, g], ri) => {
    html += `<tr><td>${name}${ri === 0 ? ' <span class="sub">(reference)</span>' : ''}</td><td>${Math.round(g.n / 2)} s</td>` + cols.map(([b, i]) => {
      const m = g.sum[i] / g.n, m0 = base.sum[i] / base.n
      const pct = Math.round(m * 100)
      if (ri === 0 || m0 <= 0) return `<td>${pct}%</td>`
      const d = Math.round((m / m0 - 1) * 100)
      return `<td>${pct}% <span class="${d > 0 ? 'up' : d < 0 ? 'down' : ''}">(${d > 0 ? '+' : ''}${d}%)</span></td>`
    }).join('') + '</tr>'
  })
  el.innerHTML = html + '</table><div class="sub">Change in brackets is relative to the first condition you ran. The first 2 s of each block are ignored. Band values start ~15 s after connecting.</div>'
  el.hidden = false
}

// ---------- compare two conditions (average spectra and their difference) ----------
function condSpectrum(cond) {
  const rows = rec.specRows.filter((r) => r.cond === cond && r.age >= SETTLE_S)
  if (rows.length < 4) return null
  const m = new Float32Array(SPEC_BINS)
  for (const r of rows) for (let f = 0; f < SPEC_BINS; f++) m[f] += r.col[f] / rows.length
  return { m, n: rows.length }
}
function updateCompareOptions() {
  const names = [...new Set(rec.specRows.filter((r) => r.age >= SETTLE_S).map((r) => r.cond))].filter((n) => condSpectrum(n))
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
function drawCompare() {
  if ($('compare').hidden) return
  const A = condSpectrum($('cmp-a').value), B = condSpectrum($('cmp-b').value)
  const [g, w, h] = fit($('cv-cmp')); g.clearRect(0, 0, w, h)
  if (!A || !B) return
  const L = 36, top = h * 0.55, fx = (f) => L + ((f - 1) / (SPEC_BINS - 1)) * (w - L - 6)
  // alpha band shading
  g.fillStyle = 'rgba(245,185,66,0.10)'; g.fillRect(fx(8), 0, fx(13) - fx(8), h)
  g.font = '11px sans-serif'; g.fillStyle = '#f5b942'; g.fillText('alpha', fx(8) + 3, 11)
  // top: mean spectra in dB
  const dbA = Array.from(A.m, (v) => 10 * v), dbB = Array.from(B.m, (v) => 10 * v)
  const lo = Math.min(...dbA, ...dbB) - 1, hi = Math.max(...dbA, ...dbB) + 1
  const yT = (v) => top - 6 - ((v - lo) / (hi - lo)) * (top - 22)
  g.strokeStyle = '#1f2633'; g.beginPath(); g.moveTo(L, top); g.lineTo(w, top); g.stroke()
  const line = (arr, col) => { g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); arr.forEach((v, i) => { const x = fx(i + 1), y = yT(v); i ? g.lineTo(x, y) : g.moveTo(x, y) }); g.stroke(); g.lineWidth = 1 }
  line(dbA, '#8b95a8'); line(dbB, '#4da3ff')
  g.fillStyle = '#8b95a8'; g.fillText(`A: ${$('cmp-a').value}`, L + 4, 12 + 12); g.fillStyle = '#4da3ff'; g.fillText(`B: ${$('cmp-b').value}`, L + 4, 12 + 26)
  g.fillStyle = '#8b95a8'; g.fillText('dB', 4, 12)
  // bottom: B − A in dB
  const diff = dbB.map((v, i) => v - dbA[i]), mx = Math.max(3, ...diff.map(Math.abs)), mid = top + (h - top) / 2, amp = (h - top) / 2 - 14
  g.strokeStyle = '#3a4459'; g.beginPath(); g.moveTo(L, mid); g.lineTo(w, mid); g.stroke()
  const bw = (w - L - 6) / SPEC_BINS
  diff.forEach((d, i) => { g.fillStyle = d >= 0 ? '#3ecf8e' : '#ef5b5b'; const y = (d / mx) * amp; g.fillRect(fx(i + 1) - bw / 2, d >= 0 ? mid - y : mid, bw - 1, Math.abs(y)) })
  g.fillStyle = '#8b95a8'; g.fillText('B − A (dB)', 4, top + 12); g.fillText(`±${mx.toFixed(0)}`, 4, mid - amp)
  for (const f of [4, 8, 13, 30]) { g.fillStyle = '#8b95a8'; g.fillText(`${f}`, fx(f) - 5, h - 2) }
  g.fillText('Hz', w - 18, h - 2)
  const bandDiff = (lo, hi2) => { let s = 0, n = 0; for (let f = lo; f < hi2; f++) { s += diff[f - 1]; n++ } return s / n }
  const fmt = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`
  $('cmp-note').textContent = `B vs A — theta ${fmt(bandDiff(4, 8))} · alpha ${fmt(bandDiff(8, 13))} · beta ${fmt(bandDiff(13, 30))}  (3 dB ≈ 2× power; A used ${A.n / 2} s, B ${B.n / 2} s)`
}

const csvQuote = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
function downloadZip() {
  if (!rec.rows.length) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const tag = `muse-${simulated ? 'practice-' : ''}${stamp}`
  const f3 = (v) => v.toFixed(3)
  const files = [
    { name: `${tag}/eeg.csv`, text: 'time_s,TP9,AF7,AF8,TP10,condition\n' + rec.rows.map((r) => `${(r[0] / 1000).toFixed(4)},${r[1].toFixed(2)},${r[2].toFixed(2)},${r[3].toFixed(2)},${r[4].toFixed(2)},${csvQuote(r[5])}`).join('\n') + '\n' },
    { name: `${tag}/bands.csv`, text: 'time_s,delta,theta,alpha,beta,gamma,condition\n' + rec.bandRows.map((r) => `${(r.t / 1000).toFixed(3)},${r.vals.map((v) => v.toFixed(4)).join(',')},${csvQuote(r.cond)}`).join('\n') + '\n' },
    { name: `${tag}/signal_quality.csv`, text: 'time_s,hsi_TP9,hsi_AF7,hsi_AF8,hsi_TP10,p2p_TP9,p2p_AF7,p2p_AF8,p2p_TP10\n' + rec.quality.map((r) => `${(r[0] / 1000).toFixed(3)},${r.slice(1, 5).join(',')},${r.slice(5).map((v) => v.toFixed(1)).join(',')}`).join('\n') + '\n' },
    { name: `${tag}/accelerometer.csv`, text: 'time_s,x,y,z,condition\n' + rec.accRows.map((r) => `${(r[0] / 1000).toFixed(3)},${r[1].toFixed(4)},${r[2].toFixed(4)},${r[3].toFixed(4)},${csvQuote(r[4])}`).join('\n') + '\n' },
    { name: `${tag}/ppg_infrared.csv`, text: 'time_s,ppg_ir,condition\n' + rec.ppgRows.map((r) => `${(r[0] / 1000).toFixed(3)},${r[1]},${csvQuote(r[2])}`).join('\n') + '\n' },
    { name: `${tag}/blocks.csv`, text: 'condition,start_s,end_s\n' + rec.blocks.map((b) => `${csvQuote(b.label)},${((b.t0 - rec.t0) / 1000).toFixed(3)},${b.t1 == null ? '' : ((b.t1 - rec.t0) / 1000).toFixed(3)}`).join('\n') + '\n' },
    { name: `${tag}/README.txt`, text: 'Brain Dynamics Lab (PSYC 20N)\neeg.csv: raw EEG, microvolts, 256 Hz. bands.csv: nouscope-style relative band shares (1/f-corrected, sum to 1; delta 0 unless included), ~2 Hz, starts ~15 s after connecting.\nsignal_quality.csv: muse-lsl HSI per channel (0 good, 1 ok, 2 poor) + peak-to-peak µV, 2 Hz. accelerometer.csv: g, 52 Hz. ppg_infrared.csv: raw counts, 64 Hz. blocks.csv: start/stop of each condition.\nTimes are seconds since the first EEG sample.\n' },
  ]
  const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files)); a.download = `${tag}.zip`; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}
$('btn-download').addEventListener('click', downloadZip)
$('chk-delta').addEventListener('change', (e) => {
  pipe.normalizeBands = new Set(e.target.checked ? BANDS : ['theta', 'alpha', 'beta', 'gamma'])
})

// ---------- buttons / loop ----------
$('btn-connect').addEventListener('click', () => connect(false))
$('btn-sim').addEventListener('click', () => connect(true))
$('btn-disconnect').addEventListener('click', disconnect)

let lastSlow = 0
function frame(now) {
  if (now - lastSlow > 250) {
    lastSlow = now
    if (connected) updateQuality()
    updateSummary(); updateCompareOptions()
    if (rec.t0 !== null && rec.rows.length) {
      const s = Math.floor(rec.rows[rec.rows.length - 1][0] / 1000)
      $('rec-time').textContent = `Recording ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` + (rec.current ? `  ·  ${rec.current}: ${Math.max(0, Math.floor(blockAge()))} s` : '')
    }
  }
  drawEeg(); drawBands(); drawSpec(); drawPpg(); drawMotion(); drawCompare()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
if (params.get('sim') === 'auto') connect(true)
