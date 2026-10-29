import { MuseClient, zipSamples } from 'muse-js'
import SimulatedMuse from './sim.js'
import { BandPipeline, HeartRate, BANDS, SPEC_BINS } from './dsp.js'
import { HSI, LEVEL, REASON } from './quality.js'
import { makeZip } from './zip.js'
import { SampleClock } from './clock.js'
import { MuseLink, BACKOFF_MS } from './link.js'
import * as store from './store.js'
import { createWeek5, STEPS as W5_STEPS } from './week5.js'
import { createProject, STEPS as PJ_STEPS, TASKS as PJ_TASKS, INTERVENTIONS as PJ_IVS } from './project.js'
import { WEEKS, CLAIMS, BAND_BINS, BAND_NAMES, SCRIPTS, RATINGS } from './weeks.js'
import { slidingSpectra, bandSeries, motionSeries, epochsAround, meanEpoch, permutationBand, STEP_S, NF as EV_NF } from './events.js'
import { psd, derive, alphaMetrics, bandMetrics, meanPsd, peakAbove, peakLabel, FREQS, NF, DF, REFERENCES, ELECTRODES } from './spectrum.js'

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
              bandRows: [], bandHist: [], specRows: [], accRows: [], ppgRows: [], quality: [], events: [], gaps: [], exportedAt: 0, sid: null }
const spec = { cols: [] }
let lastTs = 0, batteryPct = null
const clock = new SampleClock(FS)
let streamSubs = [], connected = false, simulated = false, hasPpg = false, pendingContinue = false, gapsSeen = 0

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

// ---------- connection (state machine in link.js; recording state lives here and is never touched by a reconnect) ----------
const link = new MuseLink({
  wantPpg: () => layerState.ppg,
  onState: (state, info) => onLinkState(state, info),
  onStream: (c, info) => attachStream(c, info),
})
if (params.get('debug') === '1') { window.__link = link; window.__Sim = SimulatedMuse; window.__backoff = BACKOFF_MS }      // test hooks only: __link.client.dropLink(), .stall(ms), __Sim.failNext = n

/** Student-facing dialog with several buttons; resolves with the chosen value. */
function choose(title, body, buttons) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title; $('modal-body').innerHTML = body; $('modal-timer').textContent = ''
    const foot = $('modal-foot'), old = foot.querySelectorAll('.choice'); old.forEach((b) => b.remove())
    $('modal-btn').hidden = true
    for (const b of buttons) {
      const el = document.createElement('button'); el.className = 'choice' + (b.primary ? ' primary' : ''); el.textContent = b.text
      el.addEventListener('click', () => { foot.querySelectorAll('.choice').forEach((x) => x.remove()); $('modal-btn').hidden = false; $('modal').hidden = true; resolve(b.value) })
      foot.appendChild(el)
    }
    $('modal').hidden = false; $('cue').hidden = true
  })
}
const recMinutes = () => (rec.rows.length ? (rec.rows[rec.rows.length - 1][0] / 60000).toFixed(1) : '0')

async function connect(simulate) {
  if (link.busy) return
  pendingContinue = false
  if (rec.rows.length > FS * 5) {            // a recording already exists: never silently discard it
    const canContinue = simulated === !!simulate
    const choice = await choose('You already have a recording',
      `<div class="modal-sub">There are <b>${recMinutes()} min</b> of ${simulated ? 'practice' : 'headset'} data in this tab${rec.exportedAt >= rec.rows.length ? ' (already downloaded)' : ' that you have <b>not downloaded</b>'}.</div>`,
      [...(canContinue ? [{ text: '▶ Continue this recording (the gap is marked)', value: 'continue', primary: true }] : []),
        { text: 'Download it first', value: 'download' }, { text: 'Start a new recording (clears this one)', value: 'new' }, { text: 'Cancel', value: 'cancel' }])
    if (choice === 'cancel') return
    if (choice === 'download') { downloadZip(); return }
    pendingContinue = choice === 'continue'
  }
  setStatus(simulate ? 'Starting practice mode…' : 'Choose your Muse in the Bluetooth popup…')
  simulated = !!simulate
  try { await link.connect(simulate) } catch (err) {
    console.error(err)
    setStatus(`Could not connect: ${err.message || err}`)
  }
}
function attachStream(c, info) {
  streamSubs.forEach((s) => s.unsubscribe()); streamSubs = []        // never two sets of subscriptions
  if (info.first && !pendingContinue) resetData()
  else { clock.newStream(); pipe.markGap(); hsi.markGap(); eeg.hpInit = false }   // continuing: mark the discontinuity
  pendingContinue = false
  connected = true
  hasPpg = !!c.ppgReadings
  streamSubs.push(zipSamples(c.eegReadings).subscribe((s) => onEegSample(s)))
  if (c.ppgReadings) streamSubs.push(c.ppgReadings.subscribe((r) => {
    if (r.ppgChannel !== 1) return
    const arrival = Date.now(), m = r.samples.length     // arrival-based (muse-js PPG timestamps share the broken counter)
    r.samples.forEach((v, i) => { hr.push(v); if (rec.t0 !== null) rec.ppgRows.push([arrival - ((m - 1 - i) * 1000) / 64 - rec.t0, v, rec.current || '']) })
  }))
  streamSubs.push(c.accelerometerData.subscribe((r) => {
    const arrival = Date.now(), m = r.samples.length     // accelerometer packets carry no timestamp
    r.samples.forEach((p, i) => {
      const k = acc.n % ACC_N; acc.x[k] = p.x; acc.y[k] = p.y; acc.z[k] = p.z; acc.n++
      if (rec.t0 !== null) rec.accRows.push([arrival - ((m - 1 - i) * 1000) / ACC_FS - rec.t0, p.x, p.y, p.z, rec.current || ''])
    })
  }))
  streamSubs.push(c.telemetryData.subscribe((t) => { batteryPct = Math.round(t.batteryLevel); updateBattery() }))
  $('btn-download').disabled = false
  updateCurrentUi()
}
function disconnect() {
  link.userDisconnect(); endBlock()
}
let recoveredFlash = 0
function onLinkState(state, info = {}) {
  const idle = state === 'idle', up = state === 'streaming'
  connected = !idle
  $('btn-connect').hidden = $('btn-sim').hidden = !idle
  $('btn-disconnect').hidden = idle
  $('btn-reconnect').hidden = !(state === 'reconnecting' || state === 'lost' || state === 'stalled')
  if (up && (info.recovered || info.recoveredFrom)) recoveredFlash = Date.now()
  if (state === 'streaming') setStatus(link.simulate ? 'Practice mode — simulated headset' : `Connected: ${link.client?.deviceName || 'Muse'}`, true)
  else if (state === 'connecting') setStatus('Connecting…')
  else if (state === 'stalled') setStatus('Data stopped arriving…')
  else if (state === 'reconnecting') setStatus('Headset disconnected — reconnecting…')
  else if (state === 'lost') setStatus('Connection lost')
  else if (idle) setStatus(rec.rows.length ? 'Disconnected (your data is still here — download it or press Connect to continue)' : 'Not connected')
  updateCurrentUi(); renderLinkBanner()
}
function renderLinkBanner() {
  const el = $('link-banner'), st = link.state, mins = recMinutes()
  let cls = '', html = ''
  if (st === 'reconnecting') {
    cls = 'warn'; html = `<b>⚠ Headset disconnected — reconnecting…</b> attempt ${Math.max(1, link.attempt)} of ${link.maxAttempts}. Your recording so far (${mins} min) is safe. Keep the Muse on and close to the laptop.`
  } else if (st === 'stalled') {
    cls = 'warn'; html = `<b>⚠ No data from the headset for ${Math.round((Date.now() - link.since) / 1000) + 3} s</b> — trying to recover. Your recording so far (${mins} min) is safe.`
  } else if (st === 'lost') {
    cls = 'bad'; html = `<b>✖ Could not reconnect automatically.</b> Your recording (${mins} min) is safe. Turn the Muse off and on, then press <b>Reconnect</b>.`
  } else if (st === 'streaming' && Date.now() - recoveredFlash < 7000 && rec.gaps.length) {
    const g = rec.gaps[rec.gaps.length - 1]; cls = 'ok'; html = `<b>✔ Reconnected.</b> ${((g.end - g.start) / 1000).toFixed(1)} s of data are missing (marked in your recording).`
  }
  el.hidden = !html; el.className = cls
  $('btn-reconnect2').hidden = !(st === 'reconnecting' || st === 'lost' || st === 'stalled')
  if (html) { $('link-text').innerHTML = html; $('btn-link-dl').hidden = !(st === 'lost' || st === 'reconnecting') || !rec.rows.length }
}
$('btn-reconnect').addEventListener('click', async () => {
  $('btn-reconnect').disabled = true; setStatus('Reconnecting…')
  const r = await link.reconnect(); $('btn-reconnect').disabled = false
  if (!r.ok) setStatus(`Could not reconnect: ${r.error}`)
})
$('btn-link-dl').addEventListener('click', () => downloadZip())
$('btn-reconnect2').addEventListener('click', () => $('btn-reconnect').click())
setInterval(renderLinkBanner, 500)
window.addEventListener('pagehide', () => link.shutdown())           // free the headset so a refreshed page can connect at once
window.addEventListener('beforeunload', (e) => { const w5 = (week5 && (week5.state.running || (week5.hasData() && !week5.state.exported))) || (project && (project.state.running || project.anyUnsaved())); if ((rec.rows.length > FS * 10 && rec.exportedAt < rec.rows.length) || w5) { e.preventDefault(); e.returnValue = '' } })

function setStatus(msg, on = false) { const el = $('status'); el.textContent = msg; el.classList.toggle('on', on) }
function resetData() {
  eeg.n = 0; eeg.hpInit = false; eeg.disp.forEach((x) => x.fill(0)); eeg.t.fill(0)
  pipe.reset(); hr.reset()
  spec.cols = []; hsi.reset(); clock.reset(); acc.n = 0; batteryPct = null; gapsSeen = 0
  rec.t0 = null; rec.exportedAt = 0; rec.sid = null; ck.eeg = ck.acc = ck.ppg = ck.seq = 0; ck.labels = []
  rec.rows = []; rec.blocks = []; rec.current = null; rec.bandRows = []; rec.bandHist = []; rec.specRows = []; rec.accRows = []; rec.ppgRows = []; rec.quality = []; rec.events = []; rec.gaps = []
  updateCurrentUi(); updateBattery()
}

// ---------- local checkpoints (IndexedDB) and recovery ----------
const ck = { eeg: 0, acc: 0, ppg: 0, seq: 0, labels: [], busy: false, ok: true }
const labelIdx = (l) => { if (!l) return -1; let i = ck.labels.indexOf(l); if (i < 0) { ck.labels.push(l); i = ck.labels.length - 1 } return i }
function startSessionStore() {
  rec.sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  store.startSession({ id: rec.sid, startedAt: Date.now(), simulated }).catch((e) => { ck.ok = false; showSaveStatus() })
  store.prune().catch(() => {})
}
function showSaveStatus(t) {
  const el = $('save-status'); if (!el) return
  el.textContent = ck.ok ? (t ? `Auto-saved on this computer at ${new Date(t).toLocaleTimeString()}` : '') : 'Auto-save is unavailable in this browser window — download your data often'
}
function snapshotState() {
  return { labels: ck.labels, blocks: rec.blocks.map((b) => ({ ...b })), events: rec.events, gaps: rec.gaps, participant: $('participant').value, claim: rec.claim,
    t0: rec.t0, simulated, link: link.log.slice(-300), diag: link.diagnostics(), savedAt: Date.now() }
}
async function doCheckpoint() {
  if (!ck.ok || ck.busy || !rec.sid || rec.rows.length === 0) return
  const nE = rec.rows.length, nA = rec.accRows.length, nP = rec.ppgRows.length
  if (nE === ck.eeg && nA === ck.acc && nP === ck.ppg && !rec.blocks.some((b) => b.t1 == null) ) { /* nothing new, still refresh state below */ }
  ck.busy = true
  try {
    const chunks = []
    const mk = (kind, rows, from, w) => {
      const n = rows.length - from; if (n <= 0) return
      const t = new Float64Array(n), v = new Float32Array(n * w), cond = new Int16Array(n)
      for (let i = 0; i < n; i++) { const r = rows[from + i]; t[i] = r[0]; for (let j = 0; j < w; j++) v[i * w + j] = r[1 + j]; cond[i] = labelIdx(r[1 + w]) }
      chunks.push({ kind, seq: ck.seq++, n, t, v, cond, w })
    }
    mk('eeg', rec.rows, ck.eeg, 4); mk('acc', rec.accRows, ck.acc, 3); mk('ppg', rec.ppgRows, ck.ppg, 1)
    await store.checkpoint(rec.sid, chunks, snapshotState(), nE)
    ck.eeg = nE; ck.acc = nA; ck.ppg = nP; showSaveStatus(Date.now())
  } catch (e) { ck.ok = false; showSaveStatus(); console.warn('checkpoint failed', e) } finally { ck.busy = false }
}
setInterval(doCheckpoint, 5000)
window.addEventListener('pagehide', () => { doCheckpoint() })
document.addEventListener('visibilitychange', () => { if (document.hidden) doCheckpoint() })

const csvq = (s) => (/[",\n]/.test(String(s)) ? `"${String(s).replace(/"/g, '""')}"` : String(s))
async function downloadRecovered(sid) {
  const { meta, state, chunks } = await store.loadSession(sid)
  const labels = state.labels || [], lab = (i) => (i >= 0 ? csvq(labels[i] ?? '') : '')
  const csv = (kind, header, fmt) => { const out = [header]; for (const c of chunks) if (c.kind === kind) for (let i = 0; i < c.n; i++) out.push(fmt(c, i)); return out.join('\n') + '\n' }
  const t0 = state.t0 ?? 0
  const files = [
    { name: 'eeg.csv', text: csv('eeg', 'time_s,TP9,AF7,AF8,TP10,condition', (c, i) => `${(c.t[i] / 1000).toFixed(4)},${[0, 1, 2, 3].map((j) => c.v[i * 4 + j].toFixed(2)).join(',')},${lab(c.cond[i])}`) },
    { name: 'accelerometer.csv', text: csv('acc', 'time_s,x,y,z,condition', (c, i) => `${(c.t[i] / 1000).toFixed(3)},${[0, 1, 2].map((j) => c.v[i * 3 + j].toFixed(4)).join(',')},${lab(c.cond[i])}`) },
    { name: 'ppg_infrared.csv', text: csv('ppg', 'time_s,ppg_ir,condition', (c, i) => `${(c.t[i] / 1000).toFixed(3)},${c.v[i]},${lab(c.cond[i])}`) },
    { name: 'blocks.csv', text: 'condition,start_s,end_s,settle_s,rate_stability,rate_effort,rate_meta_awareness,rate_sleepiness\n' + (state.blocks || []).map((b) => `${csvq(b.label)},${((b.t0 - t0) / 1000).toFixed(3)},${b.t1 == null ? '' : ((b.t1 - t0) / 1000).toFixed(3)},${b.settle ?? SETTLE_S},${b.ratings ? [b.ratings.stability, b.ratings.effort, b.ratings.meta, b.ratings.sleepy].join(',') : ',,,'}`).join('\n') + '\n' },
    { name: 'key_presses.csv', text: 'time_s,block\n' + (state.events || []).map((e) => `${((e.t - t0) / 1000).toFixed(3)},${csvq(e.block)}`).join('\n') + '\n' },
    { name: 'gaps.csv', text: 'start_s,end_s,duration_s,kind,lost_packets\n' + (state.gaps || []).map((g) => `${(g.start / 1000).toFixed(3)},${(g.end / 1000).toFixed(3)},${((g.end - g.start) / 1000).toFixed(3)},${g.kind},${g.packets}`).join('\n') + '\n' },
    { name: 'connection_log.csv', text: 'time_iso,time_s,state,event,detail\n' + (state.link || []).map((e) => { const { t, state: st, msg, ...rest } = e; return `${new Date(t).toISOString()},${((t - t0) / 1000).toFixed(3)},${st},${csvq(msg)},${csvq(JSON.stringify(rest))}` }).join('\n') + '\n' },
    { name: 'diagnostics.txt', text: Object.entries({ ...(state.diag || {}), recovered: true, recordingStarted: new Date(meta.startedAt).toISOString(), lastCheckpoint: new Date(meta.updatedAt).toISOString(), rows: meta.rows }).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' },
    { name: 'README.txt', text: 'Brain Dynamics Lab (PSYC 20N) — RECOVERED recording (the page was closed or crashed before you downloaded it).\nThis is the raw data saved by the automatic checkpoints (about every 5 s), so the last few seconds may be missing.\neeg.csv: raw EEG, microvolts, 256 Hz. accelerometer.csv: g. ppg_infrared.csv: raw counts. blocks.csv: start/stop of each condition and any ratings. key_presses.csv, gaps.csv, connection_log.csv, diagnostics.txt as in a normal download.\nbands.csv and signal_quality.csv are not included (they are computed live); they can be recomputed from eeg.csv.\nTimes are seconds since the first EEG sample.\n' },
  ]
  const who = (state.participant || '').trim().replace(/[^\w-]+/g, ''), stamp = new Date(meta.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const tag = `muse-recovered-${who ? who + '-' : ''}${meta.simulated ? 'practice-' : ''}${stamp}`
  const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files.map((f) => ({ ...f, name: `${tag}/${f.name}` })))); a.download = `${tag}.zip`; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  await store.markExported(sid, meta.rows)
}
async function recoveryCheck() {
  try {
    const all = await store.listSessions()
    const cand = all.find((x) => x.rows - (x.exportedRows || 0) > FS * 10)
    if (!cand) return
    const when = new Date(cand.startedAt).toLocaleString(), mins = (cand.rows / FS / 60).toFixed(1)
    $('recover-text').innerHTML = `<b>Found an unfinished recording from this computer</b> (${when}, about ${mins} min${cand.simulated ? ', practice data' : ''}) that was never downloaded.`
    $('recover-banner').hidden = false
    $('btn-rec-dl').onclick = async () => { await downloadRecovered(cand.id); $('recover-banner').hidden = true }
    $('btn-rec-discard').onclick = async () => { if (confirm('Delete this saved recording from this computer? This cannot be undone.')) { await store.deleteSession(cand.id); $('recover-banner').hidden = true; recoveryCheck() } }
  } catch { /* storage unavailable */ }
}
recoveryCheck()

// ---------- EEG ingest ----------
const hpA = 1 / (1 + 2 * Math.PI * HP_FC / FS)
function onEegSample(s) {
  const d = s.data
  const ts = clock.stamp(s.index)      // our own clock — muse-js timestamps are unreliable (see clock.js)
  link.touch()                          // heartbeat for the stall watchdog
  if (rec.t0 === null) { rec.t0 = ts; startSessionStore() }
  while (gapsSeen < clock.gaps.length) { const g = clock.gaps[gapsSeen++]; rec.gaps.push({ start: g.start - rec.t0, end: g.end - rec.t0, kind: g.kind, packets: g.packets || 0 }) }
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
/** Missing-data intervals (connection drops, lost packets): a shaded red band labelled "no data". */
function drawGaps(g, xOf, xMin, xMax, hgt) {
  for (const gp of rec.gaps) {
    if (rec.t0 === null) break
    const x0 = Math.max(xMin, xOf(rec.t0 + gp.start)), x1 = Math.min(xMax, xOf(rec.t0 + gp.end))
    if (x1 < xMin || x0 > xMax || x1 - x0 < 0.5) continue
    g.fillStyle = 'rgba(239,91,91,0.16)'; g.fillRect(x0, 0, Math.max(2, x1 - x0), hgt)
    if (x1 - x0 > 40) { g.fillStyle = '#ef9a9a'; g.font = '11px sans-serif'; g.fillText(`no data ${((gp.end - gp.start) / 1000).toFixed(1)} s`, x0 + 4, 14) }
  }
}
/** Key presses ("my mind wandered"): a red tick with a small triangle at the top. */
function drawPresses(g, xOf, xMin, xMax, hgt) {
  for (const ev of rec.events) {
    const x = xOf(ev.t); if (x < xMin || x > xMax) continue
    g.strokeStyle = 'rgba(239,91,91,0.85)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hgt); g.stroke(); g.lineWidth = 1
    g.fillStyle = '#ef5b5b'; g.beginPath(); g.moveTo(x, 8); g.lineTo(x - 4, 0); g.lineTo(x + 4, 0); g.closePath(); g.fill()
  }
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
  drawGaps(g, xOf, 0, w, h)
  drawPresses(g, xOf, 0, w, h)
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
      const brk = k === eeg.n - count || x < 0.5 || eeg.t[i] - eeg.t[(k - 1 + N) % N] > 100      // > 100 ms between samples = a gap
      if (brk) g.moveTo(x, y); else g.lineTo(x, y)
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
  drawGaps(g, xOf, 30, w, h - 14)
  drawPresses(g, xOf, 30, w, h - 14)
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
  if (connected && !hasPpg) { g.fillStyle = '#8b95a8'; g.font = '13px sans-serif'; g.fillText('The pulse stream is off (it adds Bluetooth load). Turn on the Pulse layer, then Disconnect and Connect again.', 10, h / 2); return }
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
  if (!connected || link.state !== 'streaming' || rec.current || !rec.selected) return
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
  $('btn-start').disabled = link.state !== 'streaming' || running || !rec.selected || seq.active
  $('btn-stop').disabled = !running || seq.active
  document.querySelectorAll('#markers button').forEach((b) => {
    b.classList.toggle('sel', b.textContent === (running ? rec.current : rec.selected))
    b.disabled = running || seq.active
  })
  $('btn-custom').disabled = $('custom-label').disabled = running || seq.active
  $('btn-seq').disabled = link.state !== 'streaming' || seq.active
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
// A run is a list of steps. Each step can have a read-aloud script screen before its block and a ratings screen
// after it. Phases: pre (countdown) → [script → block → rate] per step → done.
const timeScale = +params.get('timescale') || 1       // dev/rehearsal: ?timescale=6 runs guided blocks 6× faster
const CUE = [
  [/key presses/i, 'Focused attention — press the SPACEBAR when you notice your mind has wandered, then return.'],
  [/focused attention/i, 'Focused attention — eyes closed, repeat your calming word, stay still.'],
  [/open monitoring/i, 'Open monitoring — eyes closed, notice whatever arises, stay still.'],
  [/rest \(eyes closed\)/i, 'Rest — eyes closed, stay still.'],
  [/closed/i, 'Close your eyes and relax — stay still (don’t squeeze).'],
  [/open/i, 'Eyes open — look at one fixed spot, stay still.'],
  [/arith|math/i, 'Silent mental arithmetic — no talking, stay still.'],
  [/clench/i, 'Clench your jaw firmly, then relax.'],
  [/medit/i, 'Meditate, eyes closed.'],
  [/rest/i, 'Rest quietly — stay still.'],
]
const cueText = (label) => (CUE.find(([re]) => re.test(label)) || [0, ''])[1]
const NO_FIX = /closed|medit|focused attention|open monitoring/i      // eyes closed: no fixation cross
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
const SEQ_LEN = { alpha: 45, abab: 45, meditation: 180, press: 240 }
function onSeqSelect() {
  const v = $('seq-select').value
  $('seq-ab').hidden = v !== 'abab'
  $('med-opts').hidden = v !== 'meditation'
  $('seq-len').value = SEQ_LEN[v]
}
$('seq-select').addEventListener('change', onSeqSelect)
onSeqSelect()

function buildSteps() {
  const v = $('seq-select').value, len = Math.max(10, +$('seq-len').value || SEQ_LEN[v])
  const T = (x) => Math.max(3, Math.round(x / timeScale)), S = (x) => Math.max(2, Math.round(x / timeScale))
  if (v === 'alpha') return ['Eyes open (1)', 'Eyes closed', 'Eyes open (2)'].map((label) => ({ label, sec: T(len), settle: S(5) }))
  if (v === 'meditation') {
    const order = $('med-order').value === 'om-fa' ? ['om', 'fa'] : ['fa', 'om'], name = { fa: 'Focused attention', om: 'Open monitoring' }
    return [
      { label: 'Rest (eyes closed)', sec: T(60), settle: S(10), script: SCRIPTS.rest, scriptSec: T(25), rate: false, closed: true },
      ...order.map((k) => ({ label: name[k], sec: T(len), settle: S(10), script: SCRIPTS[k], scriptSec: T(50), rate: true, closed: true })),
    ]
  }
  if (v === 'press') return [{ label: 'Focused attention + key presses', sec: T(len), settle: S(10), script: SCRIPTS.press, scriptSec: T(50), rate: true, closed: true, press: true }]
  const A = $('seq-a').value, B = $('seq-b').value, reps = +$('seq-reps').value, steps = []
  if (!A || !B || A === B) return []
  for (let r = 0; r < reps; r++) steps.push({ label: A, sec: T(len), settle: S(3) }, { label: B, sec: T(len), settle: S(3) })
  return steps
}

// --- key presses ("my mind wandered") ---
const press = { enabled: false }
const pressCount = () => (rec.current ? rec.events.filter((e) => e.block === rec.current && e.t >= rec.blockT0).length : 0)
function setPress(on, locked = false) {
  press.enabled = on; $('chk-press').checked = on; $('chk-press').disabled = locked
  $('btn-press').hidden = !on || !rec.current
  if (on) document.activeElement?.blur?.()          // a focused button would otherwise react to the spacebar
}
function recordPress() {
  if (!press.enabled || !rec.current) return false
  rec.events.push({ t: nowMs(), block: rec.current })
  const el = $('cue'); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 220)
  return true
}
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !press.enabled || !rec.current) return
  e.preventDefault(); if (!e.repeat) recordPress()
}, true)
document.addEventListener('keyup', (e) => { if (e.code === 'Space' && press.enabled && rec.current) e.preventDefault() }, true)
$('btn-press').addEventListener('click', recordPress)
$('chk-press').addEventListener('change', (e) => { if (!seq.active) setPress(e.target.checked) })

// --- modal: read-aloud script / ratings ---
function showModal(title, html, btnText, onBtn) {
  $('modal-title').textContent = title; $('modal-body').innerHTML = html
  $('modal-btn').textContent = btnText; $('modal-btn').onclick = onBtn; $('modal-btn').disabled = false
  $('modal-timer').textContent = ''; $('modal').hidden = false; $('cue').hidden = true
}
function hideModal() { $('modal').hidden = true; $('modal-btn').onclick = null }
function showScript(st) {
  showModal(`Read aloud: ${st.script.title}`,
    `<div class="modal-sub">Reader: speak slowly and quietly. When you finish, stay silent — the block starts automatically (or press the button when the participant is ready).</div>` +
    st.script.lines.map((l) => `<p class="script-line">${l}</p>`).join('') +
    `<div class="modal-sub">${st.closed ? 'Participant: close your eyes when you are ready.' : ''} Next: ${st.label}, ${st.sec >= 60 ? Math.round(st.sec / 6) / 10 + ' min' : st.sec + ' s'}.</div>`,
    '▶ Start the block now', beginBlock)
}
function showRatings(st) {
  const ans = {}
  const body = `<div class="modal-sub">Answer right away, about the practice you just did (“${st.label}”). 1 – 5.</div>` +
    RATINGS.map((r) => `<div class="rate-row" data-r="${r.id}"><div class="rate-q"><b>${r.name}</b>${r.q}</div>
      <div class="rate-btns"><span class="rate-lab">${r.lo}</span>${[1, 2, 3, 4, 5].map((n) => `<button data-v="${n}">${n}</button>`).join('')}<span class="rate-lab r">${r.hi}</span></div></div>`).join('')
  showModal(`Ratings — ${st.label}`, body, 'Continue', () => {
    const blk = seq.lastBlock; if (blk) blk.ratings = { ...ans }
    hideModal(); nextStep()
  })
  $('modal-btn').disabled = true
  $('modal-body').querySelectorAll('.rate-row').forEach((row) => row.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    ans[row.dataset.r] = +b.dataset.v
    row.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b))
    $('modal-btn').disabled = RATINGS.some((r) => ans[r.id] == null)
  })))
}

function showCue(cls, label, time, sub, frac, opts = {}) {
  const el = $('cue'); el.hidden = false; el.className = cls; el.dataset.src = opts.src || 'seq'
  $('cue-plus').style.visibility = opts.plus ? 'visible' : 'hidden'
  $('cue-label').textContent = label; $('cue-time').textContent = time; $('cue-sub').textContent = sub
  $('cue-bar').firstElementChild.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`
}
function startSeq() {
  if (!connected || link.state !== 'streaming' || seq.active) return
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
  Object.assign(seq, { active: true, steps, i: -1, phase: 'pre', tPhase: nowMs(), lastBlock: null })
  updateCurrentUi(); beep(660); seqTick()
}
function stopSeq(msg) {
  if (!seq.active) return
  seq.active = false; hideModal(); endBlock(); setPress(false); updateCurrentUi()
  showCue('done', msg, '', 'Download your data when you are finished.', 1)
  setTimeout(() => { if (!seq.active) $('cue').hidden = true }, 8000)
}
function enterStep(i) {
  seq.i = i
  const st = seq.steps[i]
  if (st.script) { seq.phase = 'script'; seq.tPhase = nowMs(); showScript(st) } else beginBlock()
}
function beginBlock() {
  hideModal()
  const st = seq.steps[seq.i]
  seq.phase = 'block'; seq.tPhase = nowMs()
  rec.selected = st.label; startBlock(st.settle); beep(880)
  setPress(!!st.press, true)
}
function afterBlock() {
  const st = seq.steps[seq.i]
  seq.lastBlock = rec.blocks[rec.blocks.length - 1]
  endBlock(); setPress(false, false)
  if (st.rate) { seq.phase = 'rate'; showRatings(st) } else nextStep()
}
function nextStep() {
  if (seq.i + 1 < seq.steps.length) enterStep(seq.i + 1)
  else { seq.active = false; seq.phase = ''; updateCurrentUi(); beep(660, 250); showCue('done', '✔ Done', '', 'All blocks recorded. Open the results below, then download your data.', 1); setTimeout(() => { if (!seq.active) $('cue').hidden = true }, 20000) }
}
function seqTick() {
  if (!seq.active) return
  if (link.state === 'idle') { stopSeq('Guided run stopped — disconnected'); return }
  const t = nowMs()
  if (seq.phase === 'pre') {
    const left = 5000 - (t - seq.tPhase)
    showCue('ready', 'Get ready…', `${Math.max(0, Math.ceil(left / 1000))} s`, `First: ${seq.steps[0].label}.`, 1 - left / 5000, { plus: !seq.steps[0].closed })
    if (left <= 0) enterStep(0)
    return
  }
  const st = seq.steps[seq.i]
  if (seq.phase === 'script') {
    const left = st.scriptSec * 1000 - (t - seq.tPhase)
    $('modal-timer').textContent = `The block starts automatically in ${Math.max(0, Math.ceil(left / 1000))} s`
    if (left <= 0) beginBlock()
    return
  }
  if (seq.phase === 'block') {
    const left = st.sec * 1000 - (t - seq.tPhase), next = seq.steps[seq.i + 1]
    const closed = st.closed ?? NO_FIX.test(st.label)
    showCue(closed ? 'closed' : 'running', `● ${st.label.toUpperCase()}`, `${Math.max(0, Math.ceil(left / 1000))} s`,
      `${cueText(st.label)}   ·   block ${seq.i + 1} of ${seq.steps.length}${next ? `   ·   next: ${next.label}` : '   ·   last block'}${st.press ? `   ·   key presses: ${pressCount()}` : ''}   ·   teammates: stay silent`,
      1 - left / (st.sec * 1000), { plus: !closed })
    $('btn-press').hidden = !(st.press && rec.current)
    if (left <= 0) afterBlock()
  }
}
$('btn-seq').addEventListener('click', startSeq)
$('btn-seq-stop').addEventListener('click', () => stopSeq('Guided run stopped'))
setInterval(seqTick, 200)

// cue + fixation cross for manual Start/Stop blocks, and the optional big cross in the middle of the screen
function updateFixOverlay() {
  const st = seq.active && seq.steps[seq.i >= 0 ? seq.i : 0]
  const label = seq.active ? (seq.phase === 'pre' ? seq.steps[0].label : seq.phase === 'block' ? st.label : null) : rec.current
  const closed = seq.active && st ? (st.closed ?? NO_FIX.test(label || '')) : NO_FIX.test(label || '')
  $('fix-overlay').hidden = !($('chk-fix').checked && label && !closed)
}
function manualCueTick() {
  updateFixOverlay()
  if (seq.active) return
  const el = $('cue')
  if (rec.current) {
    const closed = NO_FIX.test(rec.current), s = Math.max(0, Math.floor(blockAge()))
    showCue(closed ? 'closed' : 'running', `● ${rec.current.toUpperCase()}`, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
      (cueText(rec.current) || 'Block running — press Stop when you finish.') + (press.enabled ? `   ·   key presses: ${pressCount()}` : ''), 0, { plus: !closed, src: 'manual' })
    $('btn-press').hidden = !press.enabled
  } else {
    if (!el.hidden && el.dataset.src === 'manual') el.hidden = true
    $('btn-press').hidden = true
  }
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
/** Split the sample range [i0, i1) wherever consecutive samples are > 50 ms apart (a connection gap). */
function splitAtGaps(i0, i1) {
  const out = []; let a = i0
  for (let i = i0 + 1; i < i1; i++) if (rec.rows[i][0] - rec.rows[i - 1][0] > 50) { out.push([a, i]); a = i }
  out.push([a, i1]); return out
}
function labSegments(cond) {
  const segs = []
  for (const b of usableBlocks(cond)) {
    const i0 = lowerBound(b.t0 - rec.t0 + (b.settle ?? SETTLE_S) * 1000), i1 = lowerBound(b.t1 - rec.t0)
    for (const [a, z] of splitAtGaps(i0, i1)) {        // windows never straddle a gap
      if (z - a < 1024) continue
      segs.push([0, 1, 2, 3].map((c) => { const arr = new Float64Array(z - a); for (let i = a; i < z; i++) arr[i - a] = rec.rows[i][1 + c]; return arr }))
    }
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

// ---------- Practice results (Week 4): alpha at the ears, theta at the forehead, ratings ----------
const PRACTICE_LABELS = ['Rest (eyes closed)', 'Focused attention', 'Open monitoring', 'Focused attention + key presses']
const prac = { key: '', rows: [], html: '' }
function computePractice() {
  const labels = PRACTICE_LABELS.filter((l) => usableBlocks(l).length)
  const key = [labels.join('|'), rec.blocks.filter((b) => b.t1 != null).length, rec.blocks.filter((b) => b.ratings).length, rec.events.length].join('#')
  if (key === prac.key) return
  prac.key = key
  prac.rows = labels.map((label) => {
    const segs = labSegments(label)
    const ears = meanPsd(segs, [0, 3], 160, 512), fore = meanPsd(segs, [1, 2], 160, 512)
    const rated = rec.blocks.filter((b) => b.label === label && b.ratings), rate = {}
    for (const r of RATINGS) rate[r.id] = rated.length ? rated.reduce((s, b) => s + b.ratings[r.id], 0) / rated.length : null
    return {
      label, secs: usableBlocks(label).reduce((s, b) => s + (b.t1 - b.t0) / 1000 - (b.settle ?? SETTLE_S), 0),
      alpha: alphaMetrics(ears.pw), theta: bandMetrics(fore.pw, 4, 8, [[1.5, 3], [14, 35]]), rate,
      presses: rec.events.filter((e) => e.block === label).length,
    }
  })
  prac.html = ''
}
const fnum = (v, d = 1) => (v == null ? '–' : v.toFixed(d))
function practiceSummaryLine() {
  const fa = prac.rows.find((r) => r.label === 'Focused attention'), om = prac.rows.find((r) => r.label === 'Open monitoring')
  if (!fa || !om) return ''
  const alphaHi = fa.alpha.aboveDb === om.alpha.aboveDb ? null : fa.alpha.aboveDb > om.alpha.aboveDb ? fa.label : om.label
  const fs = fa.rate.stability, os = om.rate.stability
  const stabHi = fs == null || os == null || fs === os ? null : fs > os ? fa.label : om.label
  const haveRatings = fs != null && os != null
  if (!alphaHi) return ''
  return `Higher alpha (above 1/f, ears): ${alphaHi}.` + (stabHi ? ` Higher rated stability: ${stabHi}. ${stabHi === alphaHi ? 'They agree here' : 'They differ here'} — with one participant and two practices this is a description, not a test.` : haveRatings ? ' Stability was rated the same for both practices.' : ' Add ratings to compare with stability.')
}
function updatePracticePanel() {
  computePractice()
  $('panel-practice').hidden = !prac.rows.length
  if (!prac.rows.length || prac.html) return
  const th = (t) => `<th>${t}</th>`
  prac.html = '<table><tr>' + ['Practice', 'time', 'alpha above 1/f (ears)', 'alpha peak (ears)', 'theta above 1/f (forehead)', 'Stability', 'Effort', 'Meta-aware.', 'Sleepiness', 'key presses'].map(th).join('') + '</tr>' +
    prac.rows.map((r) => `<tr><td>${r.label}</td><td>${Math.round(r.secs)} s</td><td>${fnum(r.alpha.aboveDb)} dB</td><td>${peakLabel(r.alpha)}</td><td>${fnum(r.theta.aboveDb)} dB</td>` +
      RATINGS.map((q) => `<td>${r.rate[q.id] == null ? '–' : fnum(r.rate[q.id], r.rate[q.id] % 1 ? 1 : 0)}</td>`).join('') + `<td>${r.presses || '–'}</td></tr>`).join('') + '</table>'
  $('practice-table').innerHTML = prac.html
  $('practice-note').textContent = (practiceSummaryLine() + ' “Above 1/f” compares band power with a smooth background fitted outside the band, so 0 dB means no bump. Alpha is read at the ears (TP9 + TP10) and theta at the forehead (AF7 + AF8); the Muse cannot see true frontal-midline theta. Ratings: 1 (low) – 5 (high).').trim()
}
function savePracticeCard() {
  const cv = document.createElement('canvas'); cv.width = 1400; cv.height = 760
  const g = cv.getContext('2d'); g.fillStyle = '#0f1218'; g.fillRect(0, 0, 1400, 760)
  g.fillStyle = '#e6e9ef'; g.font = 'bold 34px sans-serif'; g.fillText('Brain Dynamics Lab · PSYC 20N — Meditation practices', 40, 56)
  g.fillStyle = '#8b95a8'; g.font = '20px sans-serif'
  const who = $('participant').value.trim()
  g.fillText(`${who ? 'Participant ' + who + '   ·   ' : ''}${new Date().toLocaleDateString()}`, 40, 92)
  const cols = [['Practice', 40, 'left'], ['alpha above 1/f (ears)', 420, 'right'], ['alpha peak', 560, 'right'], ['theta above 1/f (fh)', 740, 'right'], ['Stability', 850, 'right'], ['Effort', 940, 'right'], ['Meta-aware.', 1060, 'right'], ['Sleepy', 1150, 'right'], ['presses', 1250, 'right']]
  g.font = 'bold 17px sans-serif'; g.fillStyle = '#e6e9ef'
  for (const [t, x, al] of cols) { g.textAlign = al; g.fillText(t, x, 150) }
  g.font = '19px sans-serif'; let y = 195
  for (const r of prac.rows) {
    const cells = [r.label, `${fnum(r.alpha.aboveDb)} dB`, peakLabel(r.alpha), `${fnum(r.theta.aboveDb)} dB`, ...RATINGS.map((q) => (r.rate[q.id] == null ? '–' : fnum(r.rate[q.id], r.rate[q.id] % 1 ? 1 : 0))), r.presses || '–']
    cols.forEach(([, x, al], i) => { g.textAlign = al; g.fillStyle = i ? '#e6e9ef' : '#9ac8ff'; g.fillText(String(cells[i]), x, y) })
    y += 44
  }
  g.textAlign = 'left'; g.fillStyle = '#e6e9ef'; g.font = '19px sans-serif'; y += 20
  const note = practiceSummaryLine() || 'Compare each practice with rest, and your ratings with the EEG.'
  let cur = ''
  for (const wd of note.split(' ')) { if ((cur + wd).length > 120) { g.fillText(cur, 40, y); y += 28; cur = '' } cur += wd + ' ' }
  g.fillText(cur, 40, y)
  g.fillStyle = '#8b95a8'; g.font = '16px sans-serif'; g.fillText('bdl.stanford.edu/muse-web · classroom observation, not research data · one participant', 40, 740)
  cv.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `practice-results-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000) })
}
$('btn-practice-card').addEventListener('click', savePracticeCard)

// ---------- Mind-wandering windows: −10 s → key press → +10 s ----------
const evp = { key: '', res: null }
const EV_COLORS = { theta: '#3ecf8e', alpha: '#f5b942', beta: '#ef7b5b', motion: '#ef5b5b' }
function updateEventsOptions() {
  const names = [...new Set(rec.events.map((e) => e.block))].filter((l) => rec.blocks.some((b) => b.label === l && b.t1 != null))
  $('panel-events').hidden = !names.length
  if (!names.length) return
  const sel = $('ev-block'), cur = sel.value
  if (sel.options.length !== names.length || [...sel.options].some((o, i) => o.value !== names[i])) {
    sel.innerHTML = names.map((n) => `<option>${n}</option>`).join('')
    sel.value = names.includes(cur) ? cur : names[names.length - 1]
  }
}
function computeEvents() {
  const label = $('ev-block').value, chSel = $('ev-ch').value
  const cand = rec.blocks.filter((b) => b.label === label && b.t1 != null && rec.events.some((e) => e.block === label && e.t >= b.t0 && e.t <= b.t1))
  const b = cand[cand.length - 1]
  const key = [label, chSel, rec.events.length, b ? b.t1 : 0].join('|')
  if (key === evp.key) return
  evp.key = key
  if (!b) { evp.res = null; return }
  const i0 = lowerBound(b.t0 - rec.t0), i1 = lowerBound(b.t1 - rec.t0)
  if (i1 - i0 < FS * 30) { evp.res = { tooShort: true }; return }
  const chIdx = chSel === 'ears' ? [0, 3] : chSel === 'fore' ? [1, 2] : [0, 1, 2, 3]
  const signals = chIdx.map((c) => { const a = new Float64Array(i1 - i0); for (let i = i0; i < i1; i++) a[i - i0] = rec.rows[i][1 + c]; return a })
  const sp = slidingSpectra(signals)
  const start = rec.rows[i0][0], end = rec.rows[i1 - 1][0]
  const gapsIn = rec.gaps.filter((g) => g.end > start && g.start < end).map((g) => ({ s: (g.start - start) / 1000, e: (g.end - start) / 1000 }))
  const shift = (t) => t - gapsIn.reduce((a, g) => a + (g.e < t ? g.e - g.s : 0), 0)          // samples are contiguous across a gap
  const wall = rec.events.filter((e) => e.block === label && e.t >= b.t0 && e.t <= b.t1).map((e) => (e.t - rec.t0 - start) / 1000)
  const nearGap = wall.filter((p) => gapsIn.some((g) => g.e > p - 10 && g.s < p + 10))
  const all = wall.filter((p) => !nearGap.includes(p)).map(shift)
  const bands = { theta: [4, 8], alpha: [8, 13], beta: [13, 30] }
  const series = {}
  for (const [k, [lo, hi]] of Object.entries(bands)) series[k] = { s: bandSeries(sp, lo, hi), norm: true }
  series.motion = { s: motionSeries(rec.accRows, start, end, sp.tc), norm: false }
  const res = { label, chSel, total: wall.length, nearGap: nearGap.length, hasGaps: gapsIn.length > 0, series: {}, used: [], skipped: [], nw: sp.nw }
  for (const [k, { s, norm }] of Object.entries(series)) {
    const ep = epochsAround(s, sp.tc, all, 10, 10, norm)
    if (!ep.epochs.length) continue
    const avg = meanEpoch(ep.epochs), band = permutationBand(s, sp.tc, ep.used.length, 10, 10, norm, 300)
    let nOut = 0; if (band) for (let q = 0; q < avg.length; q++) if (avg[q] > band.hi[q] || avg[q] < band.lo[q]) nOut++
    res.series[k] = { epochs: ep.epochs, avg, band, nOut }
    res.used = ep.used; res.skipped = ep.skipped
  }
  // mini spectrograms around each press (1–30 Hz, flattened by each frequency's block median)
  const med = new Float32Array(EV_NF)
  for (let f = 0; f < EV_NF; f++) { const v = []; for (let w = 0; w < sp.nw; w++) v.push(Math.log10(sp.S[w * EV_NF + f] + 1e-12)); v.sort((x, y) => x - y); med[f] = v[v.length >> 1] }
  res.minis = res.used.map((p) => {
    const W = 41, c = document.createElement('canvas'); c.width = W; c.height = EV_NF
    const g = c.getContext('2d'), img = g.createImageData(W, EV_NF)
    for (let k = 0; k < W; k++) {
      const wi = Math.round((p - 10 + k * STEP_S - sp.tc[0]) / STEP_S)
      for (let f = 0; f < EV_NF; f++) {
        const v = Math.log10(sp.S[wi * EV_NF + f] + 1e-12) - med[f], [r, gg, bb] = viridis(0.5 + v / 1.6)
        const o = ((EV_NF - 1 - f) * W + k) * 4; img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = bb; img.data[o + 3] = 255
      }
    }
    g.putImageData(img, 0, 0); return c
  })
  evp.res = res
}
function drawEventsPanel() {
  if ($('panel-events').hidden) return
  computeEvents()
  const R = evp.res
  const [g, w, h] = fit($('cv-ev-avg')); g.clearRect(0, 0, w, h)
  const [g2, w2, h2] = fit($('cv-ev-spec')); g2.clearRect(0, 0, w2, h2)
  if (!R) { $('ev-summary').textContent = ''; return }
  if (R.tooShort) { $('ev-summary').textContent = 'This block is too short for a ±10 s analysis.'; return }
  if (!R.used.length) { $('ev-summary').textContent = `${R.total} key press(es) in this block, but none has a full ±10 s window of data around it (presses in the first or last 10 s are skipped). Try a longer block.`; return }
  $('ev-summary').textContent = `${R.used.length} of ${R.total} presses used` + (R.skipped.length ? ` (${R.skipped.length} too close to the start or end of the block)` : '') + (R.nearGap ? ` (${R.nearGap} within 10 s of a connection gap)` : '') + (R.hasGaps ? ' This block contains a connection gap; head-movement timing after it is approximate.' : '') + ` Grey = each press; colour = their average; shaded = what random times give (95% range).`
  const keys = ['theta', 'alpha', 'beta', 'motion'], titles = { theta: 'theta 4–8 Hz (change, dB)', alpha: 'alpha 8–13 Hz (change, dB)', beta: 'beta 13–30 Hz (change, dB)', motion: 'head movement (accelerometer, g)' }
  const cw = w / 2, chh = h / 2, L = 38, pad = 18
  keys.forEach((k, qi) => {
    const S = R.series[k]; if (!S) return
    const x0 = (qi % 2) * cw, y0 = Math.floor(qi / 2) * chh, pw = cw - L - 10, ph = chh - pad - 22
    let lo = Infinity, hi = -Infinity
    for (const e of S.epochs) for (const v of e) { if (v < lo) lo = v; if (v > hi) hi = v }
    if (S.band) for (let q = 0; q < S.avg.length; q++) { lo = Math.min(lo, S.band.lo[q]); hi = Math.max(hi, S.band.hi[q]) }
    if (hi - lo < 1e-9) { hi = lo + 1 }
    const fx = (q) => x0 + L + (q / 40) * pw, fy = (v) => y0 + 22 + (1 - (v - lo) / (hi - lo)) * ph
    g.fillStyle = '#c9d1e0'; g.font = '12px sans-serif'; g.fillText(titles[k], x0 + L, y0 + 14)
    g.strokeStyle = '#1f2633'; g.strokeRect(x0 + L, y0 + 22, pw, ph)
    if (S.band) { g.fillStyle = 'rgba(139,149,168,0.25)'; g.beginPath(); for (let q = 0; q < 41; q++) g.lineTo(fx(q), fy(S.band.hi[q])); for (let q = 40; q >= 0; q--) g.lineTo(fx(q), fy(S.band.lo[q])); g.closePath(); g.fill() }
    g.strokeStyle = 'rgba(160,170,190,0.35)'; for (const e of S.epochs) { g.beginPath(); e.forEach((v, q) => (q ? g.lineTo(fx(q), fy(v)) : g.moveTo(fx(q), fy(v)))); g.stroke() }
    g.strokeStyle = EV_COLORS[k]; g.lineWidth = 2.6; g.beginPath(); S.avg.forEach((v, q) => (q ? g.lineTo(fx(q), fy(v)) : g.moveTo(fx(q), fy(v)))); g.stroke(); g.lineWidth = 1
    g.strokeStyle = '#ef5b5b'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(fx(20), y0 + 22); g.lineTo(fx(20), y0 + 22 + ph); g.stroke(); g.setLineDash([])
    g.fillStyle = '#8b95a8'; for (const [q, t] of [[0, '−10 s'], [10, '−5'], [20, 'press'], [30, '+5'], [40, '+10 s']]) g.fillText(t, fx(q) - (q === 40 ? 28 : 10), y0 + 22 + ph + 13)
    g.fillText(hi.toFixed(1), x0 + 2, y0 + 30); g.fillText(lo.toFixed(1), x0 + 2, y0 + 22 + ph)
  })
  const n = R.used.length, cols = Math.min(6, n), rows = Math.ceil(Math.min(n, 12) / cols), cwd = w2 / cols, chd = h2 / rows
  g2.imageSmoothingEnabled = false; g2.font = '11px sans-serif'
  R.minis.slice(0, 12).forEach((c, i) => {
    const x = (i % cols) * cwd + 3, y = Math.floor(i / cols) * chd + 3
    g2.drawImage(c, x, y + 12, cwd - 6, chd - 18)
    g2.strokeStyle = '#ef5b5b'; g2.beginPath(); g2.moveTo(x + (cwd - 6) / 2, y + 12); g2.lineTo(x + (cwd - 6) / 2, y + chd - 6); g2.stroke()
    g2.fillStyle = '#8b95a8'; g2.fillText(`press ${i + 1} (at ${R.used[i].toFixed(0)} s)`, x, y + 9)
  })
  const out = keys.filter((k) => R.series[k]).map((k) => `${k}: ${R.series[k].nOut}/41`).join(' · ')
  $('ev-note').textContent = `Points where the average leaves the random-times band — ${out} (pure chance gives about 2 of 41 per panel). Few presses make averages noisy; the press itself moves the head, so check the movement panel before believing a change at 0 s. The press marks when you noticed you had wandered, not when the wandering began.`
}
for (const id of ['ev-block', 'ev-ch']) $(id).addEventListener('change', () => { evp.key = '' })

const csvQuote = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
function eegFiles(tag) {
  if (!rec.rows.length) return []
  const files = [
    { name: `${tag}/eeg.csv`, text: 'time_s,TP9,AF7,AF8,TP10,condition\n' + rec.rows.map((r) => `${(r[0] / 1000).toFixed(4)},${r[1].toFixed(2)},${r[2].toFixed(2)},${r[3].toFixed(2)},${r[4].toFixed(2)},${csvQuote(r[5])}`).join('\n') + '\n' },
    { name: `${tag}/bands.csv`, text: 'time_s,rel_delta,rel_theta,rel_alpha,rel_beta,rel_gamma,abs_delta_dB,abs_theta_dB,abs_alpha_dB,abs_beta_dB,abs_gamma_dB,rel_ready,channels,condition\n' + rec.bandRows.map((r) => `${(r.t / 1000).toFixed(3)},${r.vals.map((v) => v.toFixed(4)).join(',')},${r.abs.map((v) => v.toFixed(2)).join(',')},${r.ready ? 1 : 0},${r.ch},${csvQuote(r.cond)}`).join('\n') + '\n' },
    { name: `${tag}/signal_quality.csv`, text: 'time_s,hsi_TP9,hsi_AF7,hsi_AF8,hsi_TP10,p2p_TP9,p2p_AF7,p2p_AF8,p2p_TP10\n' + rec.quality.map((r) => `${(r[0] / 1000).toFixed(3)},${r.slice(1, 5).join(',')},${r.slice(5).map((v) => v.toFixed(1)).join(',')}`).join('\n') + '\n' },
    { name: `${tag}/accelerometer.csv`, text: 'time_s,x,y,z,condition\n' + rec.accRows.map((r) => `${(r[0] / 1000).toFixed(3)},${r[1].toFixed(4)},${r[2].toFixed(4)},${r[3].toFixed(4)},${csvQuote(r[4])}`).join('\n') + '\n' },
    { name: `${tag}/ppg_infrared.csv`, text: 'time_s,ppg_ir,condition\n' + rec.ppgRows.map((r) => `${(r[0] / 1000).toFixed(3)},${r[1]},${csvQuote(r[2])}`).join('\n') + '\n' },
    { name: `${tag}/blocks.csv`, text: 'condition,start_s,end_s,settle_s,rate_stability,rate_effort,rate_meta_awareness,rate_sleepiness\n' + rec.blocks.map((b) => `${csvQuote(b.label)},${((b.t0 - rec.t0) / 1000).toFixed(3)},${b.t1 == null ? '' : ((b.t1 - rec.t0) / 1000).toFixed(3)},${b.settle ?? SETTLE_S},${b.ratings ? [b.ratings.stability, b.ratings.effort, b.ratings.meta, b.ratings.sleepy].join(',') : ',,,'}`).join('\n') + '\n' },
    { name: `${tag}/gaps.csv`, text: 'start_s,end_s,duration_s,kind,lost_packets\n' + rec.gaps.map((g) => `${(g.start / 1000).toFixed(3)},${(g.end / 1000).toFixed(3)},${((g.end - g.start) / 1000).toFixed(3)},${g.kind},${g.packets}`).join('\n') + '\n' },
    { name: `${tag}/connection_log.csv`, text: 'time_iso,time_s,state,event,detail\n' + link.log.map((e) => { const { t, state, msg, ...rest } = e; return `${new Date(t).toISOString()},${rec.t0 === null ? '' : ((t - rec.t0) / 1000).toFixed(3)},${state},${csvQuote(msg)},${csvQuote(JSON.stringify(rest))}` }).join('\n') + '\n' },
    { name: `${tag}/diagnostics.txt`, text: Object.entries({ ...link.diagnostics(), exported: new Date().toISOString(), recordingMinutes: recMinutes(), gaps: rec.gaps.length, missingSeconds: (rec.gaps.reduce((a, g) => a + (g.end - g.start), 0) / 1000).toFixed(1), lostPackets: clock.lostPackets }).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' },
    { name: `${tag}/key_presses.csv`, text: 'time_s,block\n' + rec.events.map((e) => `${((e.t - rec.t0) / 1000).toFixed(3)},${csvQuote(e.block)}`).join('\n') + '\n' },
    { name: `${tag}/README.txt`, text: 'Brain Dynamics Lab (PSYC 20N)\neeg.csv: raw EEG, microvolts, 256 Hz. bands.csv (~2 Hz): rel_* = nouscope-style relative band shares (1/f-corrected, sum to 1; delta 0 unless included; valid when rel_ready=1, ~15 s after connecting); abs_*_dB = absolute band power in dB re 1 µV² (delta 1-3 Hz, theta 4-7, alpha 8-12, beta 13-29, gamma 30-40); channels = channel mode and the electrodes actually used, e.g. weighted:TP9+TP10 (weighted = best-contact auto, locked at the first block of a recording; posterior = TP9+TP10, frontal = AF7+AF8, all, or a single electrode tp9/tp10/af7/af8).\nsignal_quality.csv: muse-lsl HSI per channel (0 good, 1 ok, 2 poor) + peak-to-peak µV, 2 Hz. accelerometer.csv: g, 52 Hz. ppg_infrared.csv: raw counts, 64 Hz. blocks.csv: start/stop of each condition (settle_s = seconds ignored at the start of each block in summaries; rate_* = 1-5 ratings given right after a practice, blank if none). key_presses.csv: spacebar presses (my mind wandered), time and block. gaps.csv: intervals with no EEG (connection drops or lost packets) — time in eeg.csv stays aligned to the wall clock, so rows jump across a gap. connection_log.csv / diagnostics.txt: connection events and environment, for troubleshooting.\nTimes are seconds since the first EEG sample.\n' },
  ]
  rec.exportedAt = rec.rows.length
  if (rec.sid) store.markExported(rec.sid, rec.rows.length).catch(() => {})
  return files
}
function downloadZip() {
  if (!rec.rows.length) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const who = ($('participant').value || '').trim().replace(/[^\w-]+/g, '')
  const tag = `muse-${who ? who + '-' : ''}${simulated ? 'practice-' : ''}${stamp}`
  const files = eegFiles(tag)
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

// ---------- experiment bar (always visible at the top) + Guided / Explore modes + Week 5 ----------
const isBeh = !!weekCfg?.behavioral
let mode = isBeh ? 'guided' : 'eeg'
let week5 = null
let project = null
const expState = { sig: '', primary: null, secondary: null }
function setMode(m) {
  mode = m
  document.body.classList.toggle('mode-guided', m === 'guided'); document.body.classList.toggle('mode-explore', m === 'explore')
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m))
  if (m === 'guided') setTimeout(() => { week5?.drawChart(); project?.render() }, 60)
  updateExpBar(true)
}
function startBeh() {
  const who = $('beh-who').value.trim(), iv = $('beh-iv').value
  if (!who || !iv) { $('beh-status').textContent = 'Enter the participant’s initials and choose an intervention first.'; (who ? $('beh-iv') : $('beh-who')).focus(); return }
  week5.start({ participant: who, intervention: iv, beep: $('beh-beep').checked })
}
if (isBeh) {
  week5 = createWeek5({ $, choose, setBusy: () => {} })
  document.body.classList.add('beh'); $('mode-tabs').hidden = false; $('panel-behavior').hidden = false
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)))
  $('beh-start').addEventListener('click', startBeh)
  $('beh-download').addEventListener('click', () => week5.download())
  $('beh-continue').addEventListener('click', () => { setMode('explore'); window.scrollTo(0, 0) })
  $('beh-card').addEventListener('click', () => week5.card())
  $('task-abort').addEventListener('click', () => week5.abort())
  document.addEventListener('week5-change', () => updateExpBar(true))
  const old = week5.recover()
  if (old) {
    $('beh-recover').hidden = false
    $('beh-recover-text').innerHTML = `<b>Found unsaved Week 5 data</b> from this computer (${new Date(old.savedAt).toLocaleString()}, ${old.participant || 'no initials'}).`
    $('beh-rec-dl').onclick = () => { week5.adopt(old); week5.download(); $('beh-recover').hidden = true }
    $('beh-rec-load').onclick = () => { week5.adopt(old); $('beh-recover').hidden = true }
    $('beh-rec-discard').onclick = () => { if (confirm('Delete this saved experiment data from this computer? This cannot be undone.')) { week5.clearStored(); $('beh-recover').hidden = true } }
  }
  setMode('guided'); week5.render()
}
const isProj = !!weekCfg?.project
const projectHooks = {
  eegLive: () => connected && link.state === 'streaming',
  phaseStart: (label) => { if (!projectHooks.eegLive()) return false; if (rec.current) endBlock(); rec.selected = label; startBlock(0); return rec.current === label },
  phaseEnd: () => { if (rec.current) endBlock() },
  eegFiles: (tag) => eegFiles(tag),
  eegStats: (label) => {
    const rows = rec.bandRows.filter((r) => r.cond === label && r.ready); if (rows.length < 3) return null
    const t0 = rows[0].t, use = rows.filter((r) => r.t - t0 >= 5000); if (use.length < 3) return null
    const m = (i) => use.reduce((a, r) => a + r.abs[i], 0) / use.length
    return { seconds: (use[use.length - 1].t - t0) / 1000, theta: m(1), alpha: m(2), beta: m(3) }
  },
}
function projUnit() {
  const t = PJ_TASKS[$('proj-task').value]; $('proj-amount-label').textContent = t.unit === 'trials' ? 'Trials' : 'Seconds'
  $('proj-amount').value = t.def; projEstimate()
}
function projEstimate() {
  const t = PJ_TASKS[$('proj-task').value], a = +$('proj-amount').value || t.def, taskMin = (t.unit === 'trials' ? a * 1.8 / 60 : a / 60), iv = +$('proj-min').value || 0
  $('proj-estimate').textContent = `About ${Math.round(2 * taskMin + iv + 1)} minutes in total (estimate; no limits are enforced).`
}
function startProj() {
  const who = $('proj-who').value.trim()
  if (!who) { $('proj-status').textContent = 'Enter the participant’s initials first.'; $('proj-who').focus(); return }
  if (project.state.running) return
  project.start({ participant: who, group: $('proj-group').value.trim(), hypothesis: $('proj-hypothesis').value.trim(), task: $('proj-task').value, amount: $('proj-amount').value,
    intervention: $('proj-iv').value, ivMinutes: $('proj-min').value, beep: $('proj-beep').checked })
}
if (isProj) {
  project = createProject({ $, choose, hooks: projectHooks })
  document.body.classList.add('proj'); $('mode-tabs').hidden = false; $('panel-project').hidden = false
  $('mode-tabs').querySelector('[data-mode="guided"]').textContent = 'My Project'
  document.querySelectorAll('#mode-tabs button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)))
  $('proj-task').innerHTML = Object.entries(PJ_TASKS).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('')
  $('proj-iv').innerHTML = Object.entries(PJ_IVS).map(([k, t]) => `<option value="${k}">${t.name}</option>`).join('')
  $('proj-iv').value = 'imagery'
  $('proj-task').addEventListener('change', projUnit); $('proj-amount').addEventListener('input', projEstimate); $('proj-min').addEventListener('input', projEstimate)
  projUnit()
  $('proj-start').addEventListener('click', startProj)
  $('proj-again').addEventListener('click', () => { project.showSetup(); window.scrollTo(0, 0) })
  $('proj-download').addEventListener('click', () => project.download())
  $('task-abort').addEventListener('click', () => project.abort())
  document.addEventListener('project-change', () => updateExpBar(true))
  const old = project.recover()
  if (old) {
    $('proj-recover').hidden = false
    $('proj-recover-text').innerHTML = `<b>Found unsaved project data</b> from this computer (${new Date(old.savedAt).toLocaleString()}, ${old.runs.length} run${old.runs.length > 1 ? 's' : ''}).`
    $('proj-rec-dl').onclick = () => { project.adopt(old); project.download(); $('proj-recover').hidden = true }
    $('proj-rec-load').onclick = () => { project.adopt(old); $('proj-recover').hidden = true }
    $('proj-rec-discard').onclick = () => { if (confirm('Delete this saved project data from this computer? This cannot be undone.')) { project.clearStored(); $('proj-recover').hidden = true } }
  }
  setMode('guided'); project.render()
  setInterval(() => { if (!project.state.running) project.render() }, 2000)
}
function expContext() {
  if (isProj && mode === 'guided') {
    const { cur, running } = project.state, has = project.hasData()
    return {
      title: weekCfg.title, steps: PJ_STEPS, done: !!cur?.done, cur: cur?.done ? 4 : running || cur?.startedAt ? cur.stepIndex : 0,
      sub: running ? 'Running — follow the instructions on screen.' : cur?.done ? 'Run complete — run another participant or download.' : 'Design your experiment, enter initials, then start.',
      primary: running ? { text: 'Quit', act: () => project.abort() } : has && cur?.done ? { text: '⬇ Download all runs (.zip)', act: () => project.download() } : { text: '▶ Start run', act: startProj },
      secondary: !running && has && cur?.done ? { text: '▶ Run another', act: () => project.showSetup() } : null,
    }
  }
  if (isBeh && mode === 'guided') {
    const s = week5.state, has = week5.hasData()
    return {
      title: weekCfg.title, steps: W5_STEPS, done: s.done, cur: s.done ? 4 : s.running || s.startedAt ? s.stepIndex : 0,
      sub: s.running ? 'Running — follow the instructions on screen.' : s.done ? 'Complete — save your results.' : s.aborted ? 'Stopped early — you can still download the partial data.' : 'Enter initials, choose an intervention, then start.',
      primary: s.running ? { text: 'Quit', act: () => week5.abort() } : has ? { text: '⬇ Download data (.zip)', act: () => week5.download() } : { text: '▶ Start experiment', act: startBeh },
      secondary: !s.running && has ? { text: '▶ Run again', act: () => week5.showSetup() } : null,
    }
  }
  const st = link.state, blocksDone = rec.blocks.some((b) => b.t1 != null), recording = seq.active || rec.current !== null
  const poorEars = [0, 3].filter((c) => hsi.levels[c] === 2).map((c) => CH[c]), earsOk = !poorEars.length
  const ready = st === 'streaming' && earsOk
  let cur = 0
  if (recording) cur = 1
  else if (blocksDone) cur = rec.rows.length && rec.exportedAt >= rec.rows.length ? 3 : 2
  else if (ready) cur = 1
  let sub, primary
  if (st === 'idle') { sub = rec.rows.length ? 'Disconnected — your recording is still here.' : 'Connect your Muse (or use Practice) to begin.'; primary = { text: 'Connect Muse', act: () => connect(false) } }
  else if (st === 'connecting') { sub = 'Connecting…'; primary = { text: 'Connecting…', disabled: true } }
  else if (st === 'reconnecting' || st === 'lost' || st === 'stalled') { sub = 'Connection problem — your recording is safe.'; primary = { text: 'Reconnect', act: () => $('btn-reconnect').click() } }
  else if (seq.active) { sub = 'Guided run in progress — follow the cue.'; primary = { text: '■ Stop run', act: () => stopSeq('Guided run stopped') } }
  else if (rec.current !== null) { sub = `Recording: ${rec.current}`; primary = { text: '■ Stop block', act: endBlock } }
  else {
    sub = !earsOk ? `${poorEars.join(' and ')} contact is poor — adjust the headband before starting.` : blocksDone ? 'Compare your conditions below, then download your data.' : 'Contacts look good — start when ready.'
    primary = { text: `▶ Start: ${$('seq-select').selectedOptions[0].text.split(':')[0]}`, act: startSeq }
  }
  return { title: weekCfg ? weekCfg.title : 'Free recording', steps: ['Prepare', 'Record', 'Compare', 'Export'], cur, done: false, sub, primary,
    secondary: rec.rows.length && st !== 'connecting' ? { text: '⬇ Download data', act: () => downloadZip() } : null }
}
function updateExpBar(force) {
  const c = expContext()
  const sig = JSON.stringify([c.title, c.sub, c.cur, c.done, c.steps, c.primary?.text, c.primary?.disabled, c.secondary?.text])
  if (!force && sig === expState.sig) return
  expState.sig = sig; expState.primary = c.primary; expState.secondary = c.secondary
  $('exp-title').textContent = c.title; $('exp-sub').textContent = c.sub
  $('exp-steps').innerHTML = c.steps.map((st, i) => `<span class="step ${c.done || i < c.cur ? 'done' : i === c.cur ? 'cur' : ''}">${i + 1} ${st}</span>`).join('')
  $('exp-actions').innerHTML = (c.secondary ? `<button data-act="secondary">${c.secondary.text}</button>` : '') + (c.primary ? `<button class="primary" data-act="primary"${c.primary.disabled ? ' disabled' : ''}>${c.primary.text}</button>` : '')
}
$('exp-actions').addEventListener('click', (e) => { const b = e.target.closest('[data-act]'); if (b) (b.dataset.act === 'primary' ? expState.primary : expState.secondary)?.act?.() })
$('seq-select').addEventListener('change', () => updateExpBar(true))
setInterval(() => updateExpBar(false), 400)
updateExpBar(true)

// ---------- buttons / loop ----------
$('btn-connect').addEventListener('click', () => connect(false))
$('btn-sim').addEventListener('click', () => connect(true))
$('btn-disconnect').addEventListener('click', disconnect)

let lastSlow = 0
function frame(now) {
  if (now - lastSlow > 250) {
    lastSlow = now
    if (connected) updateQuality()
    updateSummary(); updateCompareOptions(); updateLabOptions(); updatePracticePanel(); updateEventsOptions()
    $('panel-results').hidden = $('summary').hidden && $('compare').hidden && $('lab').hidden
    if (rec.t0 !== null && rec.rows.length) {
      const s = Math.floor(rec.rows[rec.rows.length - 1][0] / 1000)
      $('rec-time').textContent = `Recording ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` + (rec.current ? `  ·  ${rec.current}: ${Math.max(0, Math.floor(blockAge()))} s` : '')
    }
  }
  drawEeg(); drawBands(); drawSpec(); drawPpg(); drawMotion(); drawCompare(); drawLab(); drawEventsPanel()
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
if (params.get('sim') === 'auto') connect(true)
