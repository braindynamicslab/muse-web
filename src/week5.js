// Week 5 guided experiment: baseline arrow (Flanker) task → 5-minute intervention → arrow task again.
// No Muse needed. All data stay in this browser (a small localStorage checkpoint protects against an accidental
// refresh); students download a ZIP at the end. Nothing is sent anywhere.

import { runFlanker, runStroop, runTimer, summarize, trialsToCsv } from './behavior.js'
import { SCRIPTS } from './weeks.js'
import { makeZip } from './zip.js'

const KEY = 'muse-web-week5-v1'
const TS = +new URLSearchParams(location.search).get('timescale') || 1      // rehearsal only: ?timescale=6 shortens everything
export const N_PRACTICE = Math.max(3, Math.round(8 / TS)), N_TEST = Math.max(6, Math.round(60 / TS)), INTERVENTION_SECONDS = Math.max(5, Math.round(300 / TS))
export const STEPS = ['Setup', 'Arrow task (baseline)', 'Intervention', 'Arrow task (again)', 'Results']
export const INTERVENTIONS = {
  fa: 'Focused-attention meditation', exercise: 'Physical exercise', stroop: 'Stroop cognitive training', rest: 'Quiet rest',
}
const pct = (v) => (v == null ? '–' : `${(v * 100).toFixed(0)}%`)
const ms = (v) => (v == null ? '–' : `${Math.round(v)} ms`)
const sgn = (v, f) => (v == null ? '–' : `${v > 0 ? '+' : ''}${f(v)}`)

export function createWeek5({ $, choose, setBusy }) {
  const blank = () => ({ participant: '', intervention: '', phase: 'setup', stepIndex: 0, running: false, done: false, aborted: false, exported: false,
    startedAt: null, endedAt: null, times: {}, practice: [], baseline: [], post: [], stroop: [], beep: false })
  let st = blank(), ctl = null, forcedSetup = false
  const ui = { get stage() { return $('task-stage') }, setTitle: (t) => { $('task-title').textContent = t }, setProgress: (t) => { $('task-progress').textContent = t }, setFoot: (h) => { $('task-foot').innerHTML = h } }

  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ ...st, savedAt: Date.now() })) } catch { /* private window */ } }
  const stamp = (k) => { st.times[k] = new Date().toISOString() }
  const hasUnfinished = () => st.startedAt && !st.done && !st.aborted && !st.exported
  const hasData = () => st.baseline.length + st.post.length + st.stroop.length > 0

  function overlay(on) { $('task').hidden = !on; setBusy?.(on); $('task-step').textContent = on ? `Step ${st.stepIndex + 1} of ${STEPS.length} · ${STEPS[st.stepIndex]}` : ''; if (on) document.activeElement?.blur?.() }
  const beep = () => { if (!st.beep) return; try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 660; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.35) } catch { /* no audio */ } }

  const arrowIntro = `<div class="modal-sub">You will see five arrows. Respond to the <b>MIDDLE</b> arrow only — ignore the others.</div>
    <p class="script-line" style="font-size:44px;letter-spacing:8px;text-align:center">←←←←← &nbsp; →→←→→</p>
    <div class="modal-sub">Middle arrow points <b>left</b>: press <b>←</b> (or <b>F</b>). Points <b>right</b>: press <b>→</b> (or <b>J</b>). Be as <b>fast and accurate</b> as you can. Sit comfortably with a finger on each key.</div>`

  async function arrowTask(phase) {
    const lbl = phase === 'baseline' ? 'Baseline' : 'After the intervention'
    const up = phase === 'post' && st.intervention !== 'exercise' ? '<div class="modal-sub" style="color:var(--good);font-size:16px">✔ The 5 minutes are up — open your eyes and get ready.</div>' : ''
    await choose(`Arrow task — ${lbl}`, up + arrowIntro + `<div class="modal-sub">${N_TEST} trials, about 2 minutes. No feedback during the real trials.</div>`, [{ text: '▶ Start', value: 1, primary: true }])
    overlay(true); stamp(phase + 'Start')
    st[phase] = []
    const rows = await runFlanker({ ui, n: N_TEST, phase, participant: st.participant, intervention: st.intervention, signal: ctl.signal })
    st[phase] = rows; stamp(phase + 'End'); persist(); overlay(false)
  }

  async function intervention() {
    st.phase = 'intervention'; st.stepIndex = 2; persist()
    const iv = st.intervention, secs = INTERVENTION_SECONDS
    stamp('interventionStart')
    if (iv === 'rest') {
      await choose('Intervention: quiet rest (5 minutes)', `<div class="modal-sub">Sit comfortably. No phone, no talking. Eyes open or closed — your choice (note which). Let your mind rest.</div>`, [{ text: '▶ Start the 5-minute rest', value: 1, primary: true }])
      overlay(true); await runTimer({ ui, seconds: secs, title: 'Quiet rest', lines: ['Sit quietly. Let your mind rest.', 'Teammates: stay silent. The screen says when time is up.'], signal: ctl.signal, onDone: beep }); overlay(false)
    } else if (iv === 'fa') {
      await choose('Intervention: focused attention (5 minutes)', `<div class="modal-sub">Reader: read this aloud, slowly and quietly. Then stay silent while the participant meditates for 5 minutes.</div>` + SCRIPTS.fa.lines.map((l) => `<p class="script-line">${l}</p>`).join(''), [{ text: '▶ Start the 5-minute practice', value: 1, primary: true }])
      overlay(true); await runTimer({ ui, seconds: secs, title: 'Focused attention', lines: ['Eyes closed. Silently repeat your calming word; return to it when distracted.', 'Teammates: stay silent. Tell the participant when the screen says time is up.'], signal: ctl.signal, onDone: beep }); overlay(false)
    } else if (iv === 'exercise') {
      const c = await choose('Intervention: physical exercise (5 minutes)', `<div class="modal-sub">Do <b>light-to-moderate</b> exercise you are comfortable with for 5 minutes — for example marching in place, jumping jacks, or climbing stairs. <b>Stop right away if you feel dizzy, short of breath, or any pain.</b> This is optional: you may choose another intervention instead.</div>`,
        [{ text: '▶ Start the 5-minute exercise', value: 'go', primary: true }, { text: 'Choose a different intervention', value: 'no' }])
      if (c === 'no') { st.aborted = true; throw new DOMException('declined', 'AbortError') }
      overlay(true); await runTimer({ ui, seconds: secs, title: 'Physical exercise', lines: ['Keep moving at a comfortable pace.', 'Stop immediately if you feel unwell.'], signal: ctl.signal, onDone: beep }); overlay(false)
      stamp('exerciseEnd')
      await choose('Time is up', `<div class="modal-sub">Stop exercising and sit down. When you are ready, start the arrow task — try to begin within about a minute.</div>`, [{ text: '▶ I am ready', value: 1, primary: true }])
    } else if (iv === 'stroop') {
      await choose('Intervention: Stroop training (5 minutes)', `<div class="modal-sub">Words appear in coloured ink. Press the key for the <b>INK colour</b>, not the word: <b>R</b> red · <b>G</b> green · <b>B</b> blue · <b>Y</b> yellow. Go as fast as you can without mistakes. You will see ✓ or ✗ after each answer.</div>`, [{ text: '▶ Start the 5-minute training', value: 1, primary: true }])
      overlay(true); st.stroop = await runStroop({ ui, seconds: secs, participant: st.participant, intervention: iv, signal: ctl.signal }); overlay(false)
    }
    stamp('interventionEnd'); persist()
  }

  async function start(setup) {
    if (st.running) return
    if (hasUnfinished() || (hasData() && !st.exported)) {
      const c = await choose('Start a new experiment?', `<div class="modal-sub">You have Week 5 data that you have <b>not downloaded</b> (${st.participant || 'no initials'}, ${INTERVENTIONS[st.intervention] || ''}). Starting a new experiment clears it.</div>`,
        [{ text: 'Download it first', value: 'dl', primary: true }, { text: 'Start new (clears it)', value: 'new' }, { text: 'Cancel', value: 'cancel' }])
      if (c === 'dl') { download(); return }
      if (c !== 'new') return
    }
    forcedSetup = false
    st = blank(); st.participant = setup.participant; st.intervention = setup.intervention; st.beep = !!setup.beep
    st.startedAt = Date.now(); st.running = true; stamp('start'); persist(); render()
    ctl = new AbortController()
    try {
      st.phase = 'baseline'; st.stepIndex = 1
      await choose('Practice first', arrowIntro + `<div class="modal-sub">${N_PRACTICE} practice trials with feedback (✓ / ✗).</div>`, [{ text: '▶ Start practice', value: 1, primary: true }])
      overlay(true); st.practice = await runFlanker({ ui, n: N_PRACTICE, phase: 'practice', practice: true, participant: st.participant, intervention: st.intervention, signal: ctl.signal }); overlay(false)
      await arrowTask('baseline')
      await intervention()
      st.phase = 'post'; st.stepIndex = 3
      await arrowTask('post')
      st.phase = 'results'; st.stepIndex = 4; st.done = true; stamp('end')
    } catch (e) {
      overlay(false)
      if (e?.name === 'AbortError') { st.aborted = true; st.phase = st.phase === 'setup' ? 'setup' : st.phase } else { console.error(e) }
    } finally { st.running = false; st.endedAt = Date.now(); persist(); render(); document.dispatchEvent(new CustomEvent('week5-change')) }
  }

  async function abort() {
    if (!st.running) return
    const c = await choose('Quit the experiment?', `<div class="modal-sub">Your data so far are kept — you can still download them. The experiment cannot be resumed.</div>`, [{ text: 'Keep going', value: 'no', primary: true }, { text: 'Quit now', value: 'yes' }])
    if (c === 'yes') ctl?.abort()
  }

  // ---------- results ----------
  const S = () => ({ b: summarize(st.baseline), p: st.post.length ? summarize(st.post) : null })
  const sgnN = (v, d = 0) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`)
  const fMs = (v) => (v == null ? '–' : `${Math.round(v)} ms`)
  const fPct = (v) => (v == null ? '–' : `${(v * 100).toFixed(0)}%`)

  /** The three headline measures. lowerIsBetter marks the direction usually read as "improvement"; we only use it for
   *  colour — the text stays neutral. noise = combined standard error of the two averages. */
  function headline() {
    const { b, p } = S()
    const rows = [
      { id: 'interference', title: 'Flanker interference', sub: 'incongruent − congruent RT', unit: 'ms', lowerIsBetter: true, bv: b.effect, pv: p?.effect, noise: p && b.effectSe != null && p.effectSe != null ? Math.hypot(b.effectSe, p.effectSe) : null, more: 'more interference', less: 'less interference' },
      { id: 'rt', title: 'Overall reaction time', sub: 'mean RT, correct trials', unit: 'ms', lowerIsBetter: true, bv: b.all.meanRt, pv: p?.all.meanRt, noise: p && b.all.seRt != null && p.all.seRt != null ? Math.hypot(b.all.seRt, p.all.seRt) : null, more: 'slower', less: 'faster' },
      { id: 'acc', title: 'Accuracy', sub: 'correct ÷ answered', unit: 'pts', lowerIsBetter: false, bv: b.all.accuracy == null ? null : b.all.accuracy * 100, pv: p?.all.accuracy == null ? null : p.all.accuracy * 100, noise: p && b.all.seAcc != null && p.all.seAcc != null ? Math.hypot(b.all.seAcc, p.all.seAcc) * 100 : null, more: 'more accurate', less: 'less accurate' },
    ]
    for (const r of rows) {
      r.delta = r.bv != null && r.pv != null ? r.pv - r.bv : null
      r.dir = r.delta == null || Math.abs(r.delta) < 1e-9 ? 'same' : r.delta > 0 ? 'up' : 'down'
      r.clear = r.delta != null && r.noise != null && r.dir !== 'same' && Math.abs(r.delta) >= 2 * r.noise
      r.ceiling = r.id === 'acc' && r.bv != null && r.pv != null && r.bv >= 99.5 && r.pv >= 99.5
    }
    return rows
  }
  const fmtVal = (r, v) => (v == null ? '–' : r.unit === 'ms' ? `${Math.round(v)} ms` : `${v.toFixed(0)}%`)
  const fmtDelta = (r) => (r.delta == null ? '–' : r.unit === 'ms' ? `${sgnN(r.delta)} ms` : `${sgnN(r.delta)} pts`)
  function cardHtml(r) {
    const word = r.dir === 'same' ? 'no change' : r.dir === 'up' ? r.more : r.less
    const good = r.dir !== 'same' && (r.lowerIsBetter ? r.dir === 'down' : r.dir === 'up')
    const cls = r.delta == null ? 'flat' : !r.clear ? 'flat' : good ? 'good' : 'bad'
    const noise = r.ceiling ? 'Both near 100% — there is little room for accuracy to change.' : r.dir === 'same' ? '' : r.noise == null ? '' : r.clear ?`Larger than trial-to-trial noise (±${r.unit === 'ms' ? Math.round(r.noise) + ' ms' : r.noise.toFixed(0) + ' pts'}).` : `Within trial-to-trial noise (±${r.unit === 'ms' ? Math.round(r.noise) + ' ms' : r.noise.toFixed(0) + ' pts'}) — treat as unclear.`
    return `<div class="card"><div class="card-label">${r.title}</div><div class="card-sub">${r.sub}</div>
      <div class="card-nums"><span>${fmtVal(r, r.bv)}</span><i>→</i><span class="after">${fmtVal(r, r.pv)}</span></div>
      <div class="card-delta ${cls}">${fmtDelta(r)}${r.delta == null ? '' : ` · ${word}`}</div><div class="card-noise">${noise}</div></div>`
  }

  function metricRows() {
    const { b, p } = S()
    const g = (name) => ({ group: name })
    const M = (name, get, kind) => ({ name, b: get(b), p: p ? get(p) : null, kind })
    return [
      g('Speed (correct trials only)'),
      M('Mean RT — congruent', (s) => s.congruent.meanRt, 'ms'), M('Mean RT — incongruent', (s) => s.incongruent.meanRt, 'ms'),
      M('Flanker interference (incongruent − congruent)', (s) => s.effect, 'ms'), M('Mean RT — all trials', (s) => s.all.meanRt, 'ms'),
      M('Median RT — all trials', (s) => s.all.medianRt, 'ms'), M('RT variability (SD of RTs)', (s) => s.all.sdRt, 'ms'),
      g('Accuracy (correct ÷ answered)'),
      M('Accuracy — congruent', (s) => s.congruent.accuracy, 'pct'), M('Accuracy — incongruent', (s) => s.incongruent.accuracy, 'pct'), M('Accuracy — all trials', (s) => s.all.accuracy, 'pct'),
      g('Trial counts'),
      M('Correct trials', (s) => s.all.correct, 'n'), M('Incorrect trials', (s) => s.all.errors, 'n'), M('No answer (over 1.5 s)', (s) => s.all.omissions, 'n'),
    ]
  }
  const cell = (kind, v) => (v == null ? '–' : kind === 'ms' ? `${Math.round(v)} ms` : kind === 'pct' ? `${(v * 100).toFixed(0)}%` : String(v))
  const dcell = (kind, r) => { if (r.b == null || r.p == null) return '–'; const d = r.p - r.b; return kind === 'ms' ? `${sgnN(d)} ms` : kind === 'pct' ? `${sgnN(d * 100)} pts` : sgnN(d) }

  function render() {
    const panel = $('beh-status'); if (!panel) return
    const has = st.baseline.length > 0, res = $('beh-results')
    res.hidden = !has
    $('beh-setup').hidden = has && !forcedSetup && !st.running      // results shown: collapse the setup form ("Run again" brings it back)
    $('beh-continue-bar').hidden = !st.done
    if (has) { const d = document.querySelector('#banner details'); if (d) d.open = false }      // results are the focus: collapse the week intro
    if (has) {
      $('beh-cards').innerHTML = headline().map(cardHtml).join('')
      $('beh-table').innerHTML = '<table><tr><th>Metric</th><th>Baseline</th><th>After the intervention</th><th>Change</th></tr>' +
        metricRows().map((r) => r.group ? `<tr class="grp"><td colspan="4">${r.group}</td></tr>` : `<tr><td>${r.name}</td><td>${cell(r.kind, r.b)}</td><td>${cell(r.kind, r.p)}</td><td class="chg">${dcell(r.kind, r)}</td></tr>`).join('') + '</table>'
      $('beh-after-missing').hidden = st.post.length > 0
      const z = st.stroop.length ? summarize(st.stroop) : null
      $('beh-stroop').hidden = !z
      if (z) $('beh-stroop').textContent = `Stroop training during the intervention: ${z.all.n} trials, ${fPct(z.all.accuracy)} correct, Stroop interference ${fMs(z.effect)}.`
      drawChart()
      if (!ro && window.ResizeObserver) { ro = new ResizeObserver(() => drawChart()); ro.observe(res) }
    }
    $('beh-status').textContent = st.running ? `Running: ${STEPS[st.stepIndex]}…` : st.done ? 'Experiment complete.' : st.aborted ? 'Experiment stopped early — partial data can be downloaded.' : hasData() ? 'Data available.' : 'Ready.'
    $('beh-download').disabled = !hasData(); $('beh-card').disabled = !has
  }
  let ro = null

  // ---------- charts (re-drawn on resize, so they never stretch) ----------
  function prep(cv) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return null
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr)
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h); return { g, w, h }
  }
  const niceMax = (v) => { const m = Math.pow(10, Math.floor(Math.log10(Math.max(v, 1)))); return Math.ceil(v / (m / 2)) * (m / 2) }
  function drawChart() {
    const { b, p } = S(); if (!st.baseline.length) return
    drawRtChart(b, p); drawInterferenceChart(b, p)
  }
  function legend(g, w, right, items) {
    g.font = '13px sans-serif'
    const widths = items.map(([, n]) => g.measureText(n).width), total = widths.reduce((a, v) => a + v + 16 + 20, -20)
    let lx = w - right - total
    items.forEach(([col, name], i) => { g.fillStyle = col; g.fillRect(lx, 8, 11, 11); g.fillStyle = '#c9d1e0'; g.textAlign = 'left'; g.fillText(name, lx + 16, 18); lx += widths[i] + 16 + 20 })
  }
  function drawRtChart(b, p) {
    const c = prep($('cv-beh')); if (!c) return
    const { g, w, h } = c, series = [[b, 'Baseline', '#8b95a8'], [p, 'After', '#4da3ff']], conds = [['congruent', 'Congruent trials'], ['incongruent', 'Incongruent trials']]
    const vals = series.flatMap(([s]) => (s ? conds.map(([k]) => s[k].meanRt) : [])).filter((v) => v != null)
    if (!vals.length) return
    const top = 40, bottom = 34, left = 52, right = 16, hi = niceMax(Math.max(...vals) * 1.1), y = (v) => top + (1 - v / hi) * (h - top - bottom)
    g.font = 'bold 14px sans-serif'; g.fillStyle = '#e6e9ef'; g.textAlign = 'left'; g.fillText('Reaction time by trial type', left, 18)
    legend(g, w, right, [['#8b95a8', 'Baseline'], ['#4da3ff', 'After']])
    g.font = '12px sans-serif'; g.strokeStyle = '#1f2633'
    for (let i = 0; i <= 4; i++) { const v = (hi * i) / 4, yy = y(v); g.beginPath(); g.moveTo(left, yy); g.lineTo(w - right, yy); g.stroke(); g.fillStyle = '#8b95a8'; g.textAlign = 'right'; g.fillText(String(Math.round(v)), left - 8, yy + 4) }
    g.save(); g.translate(14, top + (h - top - bottom) / 2); g.rotate(-Math.PI / 2); g.fillStyle = '#8b95a8'; g.textAlign = 'center'; g.fillText('mean RT (ms)', 0, 0); g.restore()
    const plotW = w - left - right, gw = plotW / conds.length, bw = Math.min(70, gw / 4)
    conds.forEach(([k, label], ci) => {
      const gx = left + ci * gw + gw / 2
      series.forEach(([s, , col], si) => { const v = s?.[k].meanRt; if (v == null) return; const x = gx + (si ? 6 : -bw - 6); g.fillStyle = col; g.fillRect(x, y(v), bw, h - bottom - y(v)); g.fillStyle = '#e6e9ef'; g.font = '13px sans-serif'; g.textAlign = 'center'; g.fillText(String(Math.round(v)), x + bw / 2, y(v) - 6) })
      g.fillStyle = '#c9d1e0'; g.font = '13px sans-serif'; g.textAlign = 'center'; g.fillText(label, gx, h - 12)
    })
  }
  function drawInterferenceChart(b, p) {
    const c = prep($('cv-beh2')); if (!c) return
    const { g, w, h } = c, bars = [[b.effect, b.effectSe, 'Baseline', '#8b95a8']]
    if (p) bars.push([p.effect, p.effectSe, 'After', '#4da3ff'])
    const vals = bars.flatMap(([v, se]) => (v == null ? [] : [v + (se || 0), v - (se || 0)])); if (!vals.length) return
    const top = 40, bottom = 34, left = 52, right = 16
    let hi = Math.max(0, ...vals), lo = Math.min(0, ...vals); const pad = (hi - lo) * 0.15 || 20; hi += pad; if (lo < 0) lo -= pad
    const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (h - top - bottom)
    g.font = 'bold 14px sans-serif'; g.fillStyle = '#e6e9ef'; g.textAlign = 'left'; g.fillText('Flanker interference (incongruent − congruent)', left, 18)
    g.font = '12px sans-serif'; g.strokeStyle = '#1f2633'
    const rawStep = (hi - lo) / 4, mag = Math.pow(10, Math.floor(Math.log10(rawStep))), step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= rawStep) || mag * 10
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) { const yy = y(v); g.beginPath(); g.moveTo(left, yy); g.lineTo(w - right, yy); g.stroke(); g.fillStyle = '#8b95a8'; g.textAlign = 'right'; g.fillText(String(Math.round(v)), left - 8, yy + 4) }
    g.strokeStyle = '#6b7690'; g.beginPath(); g.moveTo(left, y(0)); g.lineTo(w - right, y(0)); g.stroke()
    g.save(); g.translate(14, top + (h - top - bottom) / 2); g.rotate(-Math.PI / 2); g.fillStyle = '#8b95a8'; g.textAlign = 'center'; g.fillText('interference (ms)', 0, 0); g.restore()
    const plotW = w - left - right, slot = plotW / 2, bw = Math.min(90, slot / 2)
    const xs = []
    bars.forEach(([v, se, label, col], i) => {
      if (v == null) return
      const cx = left + slot * i + slot / 2, x = cx - bw / 2; xs.push([cx, y(v)])
      g.fillStyle = col; g.fillRect(x, Math.min(y(v), y(0)), bw, Math.abs(y(v) - y(0)))
      if (se) { g.strokeStyle = '#e6e9ef'; g.beginPath(); g.moveTo(cx, y(v - se)); g.lineTo(cx, y(v + se)); g.moveTo(cx - 8, y(v - se)); g.lineTo(cx + 8, y(v - se)); g.moveTo(cx - 8, y(v + se)); g.lineTo(cx + 8, y(v + se)); g.stroke() }
      g.fillStyle = '#e6e9ef'; g.font = '14px sans-serif'; g.textAlign = 'center'; g.fillText(`${Math.round(v)} ms`, cx, v >= 0 ? y(v + (se || 0)) - 8 : y(v - (se || 0)) + 18)
      g.fillStyle = '#c9d1e0'; g.font = '13px sans-serif'; g.fillText(label, cx, h - 12)
    })
    g.font = '12px sans-serif'; g.fillStyle = '#8b95a8'; g.textAlign = 'left'; g.fillText('error bars: ±1 standard error', left, 34)
    if (xs.length === 2) { const d = p.effect - b.effect; g.fillStyle = '#c9d1e0'; g.font = 'bold 14px sans-serif'; g.textAlign = 'right'; g.fillText(`change: ${sgnN(d)} ms`, w - right, 34) }
  }

  // ---------- export ----------
  function download() {
    if (!hasData()) return
    const who = (st.participant || 'anon').replace(/[^\w-]+/g, ''), tag = `week5-${who}-${st.intervention || 'na'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    const flanker = [...st.practice, ...st.baseline, ...st.post]
    const sum = [['phase', 'congruency', 'n', 'answered', 'correct', 'errors', 'no_answer', 'accuracy', 'mean_rt_ms_correct', 'median_rt_ms_correct', 'sd_rt_ms_correct', 'note']]
    for (const ph of ['baseline', 'post']) {
      const z = summarize(st[ph])
      for (const k of ['congruent', 'incongruent', 'all']) { const m = z[k]; sum.push([ph, k, m.n, m.answered, m.correct, m.errors, m.omissions, m.accuracy?.toFixed(4) ?? '', m.meanRt?.toFixed(1) ?? '', m.medianRt?.toFixed(1) ?? '', m.sdRt?.toFixed(1) ?? '', '']) }
      sum.push([ph, 'flanker_interference_ms', '', '', '', '', '', '', z.effect?.toFixed(1) ?? '', '', '', `incongruent minus congruent mean RT; standard error ${z.effectSe?.toFixed(1) ?? ''} ms`])
    }
    const files = [
      { name: `${tag}/flanker_trials.csv`, text: trialsToCsv(flanker) },
      { name: `${tag}/stroop_trials.csv`, text: trialsToCsv(st.stroop) },
      { name: `${tag}/summary.csv`, text: sum.map((r) => r.join(',')).join('\n') + '\n' },
      { name: `${tag}/meta.txt`, text: Object.entries({ participant: st.participant, intervention: INTERVENTIONS[st.intervention] || st.intervention, complete: st.done, stoppedEarly: st.aborted, ...st.times, userAgent: navigator.userAgent, screen: `${screen.width}x${screen.height}`, window: `${innerWidth}x${innerHeight}` }).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' },
      { name: `${tag}/README.txt`, text: 'Brain Dynamics Lab (PSYC 20N) — Week 5 behavioral experiment.\nflanker_trials.csv: every arrow-task trial (phase = practice / baseline / post). rt_ms is from stimulus paint to key press (± about one display frame); blank when no answer within 1.5 s (timeout = true). stroop_trials.csv: the Stroop-training trials (only if that intervention was chosen). summary.csv: accuracy and mean/median RT of CORRECT trials per phase and congruency, plus the flanker effect (incongruent − congruent). meta.txt: times and browser. Classroom data, not research-grade timing.\n' },
    ]
    st.exported = true; persist()
    const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files)); a.download = `${tag}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }
  function card() {
    if (!st.baseline.length) return
    const cv = document.createElement('canvas'); cv.width = 1400; cv.height = 860; const g = cv.getContext('2d')
    g.fillStyle = '#0f1218'; g.fillRect(0, 0, 1400, 860); g.fillStyle = '#e6e9ef'; g.font = 'bold 34px sans-serif'; g.fillText('Brain Dynamics Lab · PSYC 20N — Arrow task', 40, 56)
    g.fillStyle = '#8b95a8'; g.font = '20px sans-serif'; g.fillText(`${st.participant ? 'Participant ' + st.participant + ' · ' : ''}Intervention: ${INTERVENTIONS[st.intervention] || ''} · ${new Date().toLocaleDateString()}`, 40, 92)
    const H = headline(), bw = 420, gap = 30
    H.forEach((r, i) => {
      const x = 40 + i * (bw + gap), y0 = 120
      g.fillStyle = '#171c26'; g.fillRect(x, y0, bw, 190); g.strokeStyle = '#2a3242'; g.strokeRect(x, y0, bw, 190)
      g.fillStyle = '#e6e9ef'; g.font = 'bold 20px sans-serif'; g.textAlign = 'left'; g.fillText(r.title, x + 18, y0 + 32)
      g.fillStyle = '#8b95a8'; g.font = '14px sans-serif'; g.fillText(r.sub, x + 18, y0 + 54)
      g.fillStyle = '#e6e9ef'; g.font = 'bold 34px sans-serif'; g.fillText(`${fmtVal(r, r.bv)}  →  ${fmtVal(r, r.pv)}`, x + 18, y0 + 106)
      const good = r.dir !== 'same' && (r.lowerIsBetter ? r.dir === 'down' : r.dir === 'up')
      g.fillStyle = r.delta == null || !r.clear ? '#8b95a8' : good ? '#3ecf8e' : '#f5b942'; g.font = 'bold 22px sans-serif'
      g.fillText(`${fmtDelta(r)}${r.delta == null ? '' : ' · ' + (r.dir === 'same' ? 'no change' : r.dir === 'up' ? r.more : r.less)}`, x + 18, y0 + 142)
      const nz = r.noise == null ? '' : r.unit === 'ms' ? `${Math.round(r.noise)} ms` : `${r.noise.toFixed(0)} pts`
      g.fillStyle = '#8b95a8'; g.font = '14px sans-serif'; g.fillText(r.ceiling ? 'Both near 100% — little room to change' : r.dir === 'same' || r.noise == null ? '' : r.clear ?`Larger than trial-to-trial noise (±${nz})` : `Within trial-to-trial noise (±${nz}) — unclear`, x + 18, y0 + 170)
    })
    const keep = ['Mean RT — congruent', 'Mean RT — incongruent', 'Median RT — all trials', 'RT variability (SD of RTs)', 'Accuracy — congruent', 'Accuracy — incongruent', 'Correct trials', 'Incorrect trials', 'No answer (over 1.5 s)']
    const rows = metricRows().filter((r) => !r.group && keep.includes(r.name))
    const cols = [['Metric', 40, 'left'], ['Baseline', 720, 'right'], ['After', 940, 'right'], ['Change', 1180, 'right']]
    g.font = 'bold 17px sans-serif'; g.fillStyle = '#e6e9ef'; for (const [t, x, al] of cols) { g.textAlign = al; g.fillText(t, x, 360) }
    g.font = '19px sans-serif'; let y = 396
    for (const r of rows) {
      const cells = [r.name, cell(r.kind, r.b), cell(r.kind, r.p), dcell(r.kind, r)]
      cols.forEach(([, x, al], i) => { g.textAlign = al; g.fillStyle = i ? '#e6e9ef' : '#9ac8ff'; g.fillText(cells[i], x, y) }); y += 34
    }
    g.textAlign = 'left'; g.fillStyle = '#e6e9ef'; g.font = '18px sans-serif'; y += 18
    const note = 'One person, 60 trials per test. You did the task twice, so practice and tiredness can also change your scores. A change right after five minutes does not show lasting attention training or transfer to other tasks — compare with other interventions before concluding anything.'
    let cur = ''
    for (const wd of note.split(' ')) { if ((cur + wd).length > 128) { g.fillText(cur, 40, y); y += 26; cur = '' } cur += wd + ' ' }
    g.fillText(cur, 40, y)
    g.fillStyle = '#8b95a8'; g.font = '16px sans-serif'; g.fillText('bdl.stanford.edu/muse-web · classroom observation, not research data · RT statistics use correct trials only', 40, 840)
    cv.toBlob((bl) => { const a = document.createElement('a'); a.href = URL.createObjectURL(bl); a.download = `week5-results-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000) })
  }

  // ---------- recovery of an interrupted session ----------
  function recover() {
    try {
      const raw = localStorage.getItem(KEY); if (!raw) return null
      const d = JSON.parse(raw)
      if (!d || d.exported || d.baseline?.length + d.post?.length + d.stroop?.length === 0) return null
      return d
    } catch { return null }
  }
  function adopt(d) { st = { ...blank(), ...d, running: false }; render(); document.dispatchEvent(new CustomEvent('week5-change')) }

  return { get state() { return st }, start, abort, download, card, render, recover, adopt, hasUnfinished, hasData, drawChart,
    showSetup() { forcedSetup = true; render(); $('beh-who').focus() },
    clearStored() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } } }
}
