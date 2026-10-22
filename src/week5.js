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
  let st = blank(), ctl = null
  const ui = { get stage() { return $('task-stage') }, setTitle: (t) => { $('task-title').textContent = t }, setProgress: (t) => { $('task-progress').textContent = t }, setFoot: (h) => { $('task-foot').innerHTML = h } }

  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ ...st, savedAt: Date.now() })) } catch { /* private window */ } }
  const stamp = (k) => { st.times[k] = new Date().toISOString() }
  const hasUnfinished = () => st.startedAt && !st.done && !st.aborted && !st.exported
  const hasData = () => st.baseline.length + st.post.length + st.stroop.length > 0

  function overlay(on) { $('task').hidden = !on; setBusy?.(on); if (on) document.activeElement?.blur?.() }
  const beep = () => { if (!st.beep) return; try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 660; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.35) } catch { /* no audio */ } }

  const arrowIntro = `<div class="modal-sub">You will see five arrows. Respond to the <b>MIDDLE</b> arrow only — ignore the others.</div>
    <p class="script-line" style="font-size:44px;letter-spacing:8px;text-align:center">←←←←← &nbsp; →→←→→</p>
    <div class="modal-sub">Middle arrow points <b>left</b>: press <b>←</b> (or <b>F</b>). Points <b>right</b>: press <b>→</b> (or <b>J</b>). Be as <b>fast and accurate</b> as you can. Sit comfortably with a finger on each key.</div>`

  async function arrowTask(phase) {
    const lbl = phase === 'baseline' ? 'Baseline' : 'After the intervention'
    await choose(`Arrow task — ${lbl}`, arrowIntro + `<div class="modal-sub">${N_TEST} trials, about 2 minutes. No feedback during the real trials.</div>`, [{ text: '▶ Start', value: 1, primary: true }])
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
  const S = () => ({ baseline: summarize(st.baseline), post: summarize(st.post) })
  function resultRows() {
    if (!st.baseline.length) return null
    const s = S(), b = s.baseline, p = st.post.length ? s.post : null
    const row = (name, x) => ({ name, cong: x.congruent.meanRt, incong: x.incongruent.meanRt, effect: x.effect, acc: x.all.accuracy, om: x.all.omissions, all: x.all.meanRt })
    const rows = [row('Baseline', b)]
    if (p) { rows.push(row('After the intervention', p)); rows.push({ name: 'Change (after − baseline)', delta: true, cong: p.congruent.meanRt - b.congruent.meanRt, incong: p.incongruent.meanRt - b.incongruent.meanRt, effect: p.effect - b.effect, acc: p.all.accuracy - b.all.accuracy, om: p.all.omissions - b.all.omissions, all: p.all.meanRt - b.all.meanRt }) }
    return rows
  }
  function narrative() {
    const rows = resultRows(); if (!rows || rows.length < 3) return 'Complete both arrow tasks to see the comparison.'
    const d = rows[2]
    const speed = d.all == null ? '' : d.all < 0 ? `You were ${Math.abs(Math.round(d.all))} ms faster overall` : `You were ${Math.round(d.all)} ms slower overall`
    const eff = d.effect == null ? '' : d.effect < 0 ? `the flanker effect (incongruent − congruent) shrank by ${Math.abs(Math.round(d.effect))} ms` : `the flanker effect grew by ${Math.round(d.effect)} ms`
    return `${speed}${speed && eff ? ', and ' : ''}${eff}. Accuracy changed by ${sgn(d.acc * 100, (v) => v.toFixed(0))} percentage points. One person and 60 trials is a small sample, people usually speed up with practice, and tiredness can work the other way — compare with groups that chose other interventions before concluding anything.`
  }
  function render() {
    const panel = $('beh-status'); if (!panel) return
    const rows = resultRows(), res = $('beh-results')
    res.hidden = !rows
    if (rows) {
      $('beh-table').innerHTML = '<table><tr><th></th><th>congruent RT</th><th>incongruent RT</th><th>flanker effect</th><th>overall RT</th><th>accuracy</th><th>no answer</th></tr>' +
        rows.map((r) => r.delta
          ? `<tr class="delta"><td>${r.name}</td><td>${sgn(r.cong, ms)}</td><td>${sgn(r.incong, ms)}</td><td>${sgn(r.effect, ms)}</td><td>${sgn(r.all, ms)}</td><td>${r.acc == null ? '–' : sgn(r.acc * 100, (v) => v.toFixed(0)) + ' pts'}</td><td>${sgn(r.om, String)}</td></tr>`
          : `<tr><td>${r.name}</td><td>${ms(r.cong)}</td><td>${ms(r.incong)}</td><td>${ms(r.effect)}</td><td>${ms(r.all)}</td><td>${pct(r.acc)}</td><td>${r.om}</td></tr>`).join('') + '</table>'
      $('beh-note').textContent = narrative()
      if (st.stroop.length) { const z = summarize(st.stroop); $('beh-note').textContent += `  Stroop training: ${st.stroop.length} trials, ${pct(z.all.accuracy)} correct, interference ${ms(z.effect)}.` }
      drawChart()
    }
    $('beh-status').textContent = st.running ? `Running: ${STEPS[st.stepIndex]}…` : st.done ? 'Experiment complete.' : st.aborted ? 'Experiment stopped early — partial data can be downloaded.' : hasData() ? 'Data available.' : 'Ready.'
    $('beh-download').disabled = !hasData(); $('beh-card').disabled = !rows
  }
  function drawChart() {
    const cv = $('cv-beh'); if (!cv) return
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w) return
    cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h)
    const s = S(), groups = [['baseline', 'Baseline', '#8b95a8'], ['post', 'After', '#4da3ff']]
    const vals = [s.baseline.congruent.meanRt, s.baseline.incongruent.meanRt, s.post.congruent.meanRt, s.post.incongruent.meanRt].filter((v) => v != null)
    if (!vals.length) return
    const hi = Math.max(...vals) * 1.15, lo = 0, L = 44, bw = 54, y = (v) => h - 26 - ((v - lo) / (hi - lo)) * (h - 44)
    g.font = '12px sans-serif'; g.fillStyle = '#8b95a8'; g.fillText('mean reaction time (ms), correct trials', 6, 12)
    ;[['congruent', 'congruent'], ['incongruent', 'incongruent']].forEach(([k, lab], ci) => {
      const x0 = L + ci * (bw * 2 + 70)
      groups.forEach(([gk, gl, col], gi) => { const v = s[gk][k].meanRt; if (v == null) return; g.fillStyle = col; g.fillRect(x0 + gi * (bw + 6), y(v), bw, h - 26 - y(v)); g.fillStyle = '#e6e9ef'; g.fillText(String(Math.round(v)), x0 + gi * (bw + 6) + 14, y(v) - 4) })
      g.fillStyle = '#8b95a8'; g.fillText(lab, x0 + 6, h - 8)
    })
    g.fillStyle = '#8b95a8'; g.fillRect(w - 150, 10, 10, 10); g.fillText('Baseline', w - 135, 19); g.fillStyle = '#4da3ff'; g.fillRect(w - 150, 26, 10, 10); g.fillText('After', w - 135, 35)
  }

  // ---------- export ----------
  function download() {
    if (!hasData()) return
    const who = (st.participant || 'anon').replace(/[^\w-]+/g, ''), tag = `week5-${who}-${st.intervention || 'na'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    const flanker = [...st.practice, ...st.baseline, ...st.post]
    const sum = [['phase', 'congruency', 'n', 'answered', 'omissions', 'accuracy', 'mean_rt_ms_correct', 'median_rt_ms_correct']]
    for (const ph of ['baseline', 'post']) { const z = summarize(st[ph]); for (const k of ['congruent', 'incongruent', 'all']) sum.push([ph, k, z[k].n, z[k].answered, z[k].omissions, z[k].accuracy?.toFixed(4) ?? '', z[k].meanRt?.toFixed(1) ?? '', z[k].medianRt?.toFixed(1) ?? '']); sum.push([ph, 'flanker_effect_ms', '', '', '', '', z.effect?.toFixed(1) ?? '', '']) }
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
    const rows = resultRows(); if (!rows) return
    const cv = document.createElement('canvas'); cv.width = 1400; cv.height = 720; const g = cv.getContext('2d')
    g.fillStyle = '#0f1218'; g.fillRect(0, 0, 1400, 720); g.fillStyle = '#e6e9ef'; g.font = 'bold 34px sans-serif'; g.fillText('Brain Dynamics Lab · PSYC 20N — Arrow task', 40, 56)
    g.fillStyle = '#8b95a8'; g.font = '20px sans-serif'; g.fillText(`${st.participant ? 'Participant ' + st.participant + ' · ' : ''}Intervention: ${INTERVENTIONS[st.intervention] || ''} · ${new Date().toLocaleDateString()}`, 40, 92)
    const cols = [['', 40, 'left'], ['congruent RT', 480, 'right'], ['incongruent RT', 680, 'right'], ['flanker effect', 880, 'right'], ['overall RT', 1050, 'right'], ['accuracy', 1200, 'right'], ['no answer', 1340, 'right']]
    g.font = 'bold 17px sans-serif'; g.fillStyle = '#e6e9ef'; for (const [t, x, al] of cols) { g.textAlign = al; g.fillText(t, x, 150) }
    g.font = '20px sans-serif'; let y = 196
    for (const r of rows) {
      const cells = r.delta ? [r.name, sgn(r.cong, ms), sgn(r.incong, ms), sgn(r.effect, ms), sgn(r.all, ms), r.acc == null ? '–' : sgn(r.acc * 100, (v) => v.toFixed(0)) + ' pts', sgn(r.om, String)] : [r.name, ms(r.cong), ms(r.incong), ms(r.effect), ms(r.all), pct(r.acc), String(r.om)]
      cols.forEach(([, x, al], i) => { g.textAlign = al; g.fillStyle = i ? '#e6e9ef' : '#9ac8ff'; g.fillText(cells[i], x, y) }); y += 46
    }
    g.textAlign = 'left'; g.fillStyle = '#e6e9ef'; g.font = '19px sans-serif'; y += 24
    let cur = ''; for (const wd of narrative().split(' ')) { if ((cur + wd).length > 118) { g.fillText(cur, 40, y); y += 28; cur = '' } cur += wd + ' ' } g.fillText(cur, 40, y)
    g.fillStyle = '#8b95a8'; g.font = '16px sans-serif'; g.fillText('bdl.stanford.edu/muse-web · classroom observation, not research data · one participant', 40, 700)
    cv.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `week5-results-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000) })
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
    clearStored() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } } }
}
