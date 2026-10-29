// "My Project" (Week 6): students design a pre task → intervention → post task experiment and run several
// participants in one session. The post task is always the SAME task as the pre task, so any change is comparable.
// Behavior needs no headset; if a Muse is streaming, each phase is also recorded as a labelled EEG block.
// All data stay in this browser (localStorage checkpoint + a ZIP the student downloads). Nothing is sent anywhere.

import { runFlanker, runStroop, runTimer, summarize, trialsToCsv } from './behavior.js'
import { SCRIPTS } from './weeks.js'
import { makeZip } from './zip.js'

const KEY = 'muse-web-project-v1'
const TS = (typeof location !== 'undefined' && +new URLSearchParams(location.search).get('timescale')) || 1      // rehearsal only
const secs = (s) => Math.max(3, Math.round(s / TS))
const trials = (n) => Math.max(6, Math.round(n / TS))
export const STEPS = ['Design', 'Pre task', 'Intervention', 'Post task', 'Results']

const EYES_CLOSED = ['Close your eyes gently and sit comfortably.', 'Stay still and let the time pass.']
export const IMAGERY = { title: 'Guided imagery: success', lines: [
  'Close your eyes gently and settle into a comfortable position.',
  'Choose something you are genuinely good at — a sport, an instrument, a performance, a skill you have worked hard on.',
  'Picture yourself just before it begins. Feel your breathing slow and your body ready and calm.',
  'Now watch yourself do it well — every movement smooth, every decision right. See it through your own eyes, as if you are really there.',
  'Add the senses: the sounds around you, the feel of your hands or feet, the energy as it all goes right.',
  'Notice the feeling at the end — confident, capable, satisfied. Let that feeling fill your body.',
  'If your mind drifts, come back to the scene and play it again, a little more vividly.' ] }
export const BREATHING = { title: 'Slow breathing', lines: [
  'Sit upright and comfortable. Close your eyes or soften your gaze.',
  'Breathe in gently through the nose for about 4 seconds, then out slowly for about 6 seconds.',
  'Let the out-breath be longer than the in-breath. No need to strain.',
  'When your mind wanders, return to the next breath.' ] }

/** Tasks: used as BOTH the pre and the post task. amount = trials or seconds. */
export const TASKS = {
  flanker: { name: 'Arrow (Flanker) task', unit: 'trials', def: 60, behavioral: true, effect: 'Flanker interference' },
  stroop: { name: 'Stroop colour-word task', unit: 'seconds', def: 90, behavioral: true, effect: 'Stroop interference' },
  rest: { name: 'Resting state (eyes closed)', unit: 'seconds', def: 120, behavioral: false, lines: SCRIPTS.rest.lines },
  fa: { name: 'Focused-attention meditation', unit: 'seconds', def: 180, behavioral: false, lines: SCRIPTS.fa.lines },
  om: { name: 'Open-monitoring meditation', unit: 'seconds', def: 180, behavioral: false, lines: SCRIPTS.om.lines },
}
export const INTERVENTIONS = {
  fa: { name: 'Focused-attention meditation', lines: SCRIPTS.fa.lines },
  om: { name: 'Open-monitoring meditation', lines: SCRIPTS.om.lines },
  imagery: { name: 'Guided imagery (picture success)', lines: IMAGERY.lines },
  breathing: { name: 'Slow breathing', lines: BREATHING.lines },
  exercise: { name: 'Physical exercise', lines: [] },
  stroop: { name: 'Stroop cognitive training', lines: [] },
  rest: { name: 'Quiet rest', lines: EYES_CLOSED },
}

const sgnN = (v, d = 0) => (v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`)
const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
const csv = (rows) => rows.map((r) => r.map(q).join(',')).join('\n') + '\n'
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)

/** Pure: pre vs post headline numbers for one behavioral run (same shape as the Week 5 cards). */
export function compare(preTrials, postTrials, effectName = 'Interference') {
  const b = summarize(preTrials), p = postTrials.length ? summarize(postTrials) : null
  const se = (x, y) => (x != null && y != null ? Math.hypot(x, y) : null)
  const rows = [
    { id: 'interference', title: effectName, sub: 'incongruent − congruent RT', unit: 'ms', lowerIsBetter: true, bv: b.effect, pv: p?.effect, noise: p ? se(b.effectSe, p.effectSe) : null, more: 'more interference', less: 'less interference' },
    { id: 'rt', title: 'Overall reaction time', sub: 'mean RT, correct trials', unit: 'ms', lowerIsBetter: true, bv: b.all.meanRt, pv: p?.all.meanRt, noise: p ? se(b.all.seRt, p.all.seRt) : null, more: 'slower', less: 'faster' },
    { id: 'acc', title: 'Accuracy', sub: 'correct ÷ answered', unit: 'pts', lowerIsBetter: false, bv: b.all.accuracy == null ? null : b.all.accuracy * 100, pv: p?.all.accuracy == null ? null : p.all.accuracy * 100, noise: p ? (se(b.all.seAcc, p.all.seAcc) ?? NaN) * 100 : null, more: 'more accurate', less: 'less accurate' },
  ]
  for (const r of rows) {
    if (r.noise != null && Number.isNaN(r.noise)) r.noise = null
    r.delta = r.bv != null && r.pv != null ? r.pv - r.bv : null
    r.dir = r.delta == null || Math.abs(r.delta) < 1e-9 ? 'same' : r.delta > 0 ? 'up' : 'down'
    r.clear = r.delta != null && r.noise != null && r.dir !== 'same' && Math.abs(r.delta) >= 2 * r.noise
    r.ceiling = r.id === 'acc' && r.bv != null && r.pv != null && r.bv >= 99.5 && r.pv >= 99.5
  }
  return { b, p, rows }
}

export function createProject({ $, choose, hooks }) {
  let runs = [], cur = null, ctl = null, running = false
  const ui = { get stage() { return $('task-stage') }, setTitle: (t) => { $('task-title').textContent = t }, setProgress: (t) => { $('task-progress').textContent = t }, setFoot: (h) => { $('task-foot').innerHTML = h } }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify({ runs, savedAt: Date.now() })) } catch { /* private window */ } }
  const stamp = (k) => { cur.times[k] = new Date().toISOString() }
  const hasData = () => runs.some((r) => r.pre.length + r.post.length + r.ivTrials.length + r.timedDone > 0)
  const anyUnsaved = () => runs.some((r) => !r.exported && (r.pre.length || r.post.length || r.timedDone))
  const beep = () => { if (!cur?.beep) return; try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 660; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.35) } catch { /* no audio */ } }

  const label = (phase) => `R${cur.n} ${phase}`
  function overlay(on) { $('task').hidden = !on; $('task-step').textContent = on ? `Run ${cur.n} · ${cur.participant} · ${STEPS[cur.stepIndex]}` : ''; if (on) document.activeElement?.blur?.() }
  async function recorded(phase, fn) {      // wrap a phase in an EEG block when the headset is streaming
    const eeg = hooks.phaseStart(label(phase)); cur.eeg[phase] = !!eeg
    try { return await fn() } finally { if (eeg) hooks.phaseEnd() }
  }

  const arrowIntro = `<div class="modal-sub">You will see five arrows. Respond to the <b>MIDDLE</b> arrow only. Left: <b>←</b> or <b>F</b>. Right: <b>→</b> or <b>J</b>. Be fast and accurate.</div>
    <p class="script-line" style="font-size:44px;letter-spacing:8px;text-align:center">←←←←← &nbsp; →→←→→</p>`
  const stroopIntro = `<div class="modal-sub">Words appear in coloured ink. Press the key for the <b>INK colour</b>, not the word: <b>R</b> red · <b>G</b> green · <b>B</b> blue · <b>Y</b> yellow. Fast, without mistakes.</div>`
  const taskIntro = (t) => (t === 'flanker' ? arrowIntro : t === 'stroop' ? stroopIntro
    : `<div class="modal-sub">Reader: read aloud slowly, then stay silent.</div>` + TASKS[t].lines.map((l) => `<p class="script-line">${l}</p>`).join(''))
  const amountText = (t, a) => (TASKS[t].unit === 'trials' ? `${a} trials` : fmtSecs(a))
  const fmtSecs = (s) => (s >= 90 ? `${+(s / 60).toFixed(1)} min` : `${s} s`)

  async function doTask(phase) {     // 'pre' | 'post'
    const t = cur.task, T = TASKS[t], amount = T.unit === 'trials' ? trials(cur.amount) : secs(cur.amount)
    const upNote = phase === 'post' ? `<div class="modal-sub" style="color:var(--good);font-size:16px">✔ The intervention is over — get ready for the same task again.</div>` : ''
    await choose(`${T.name} — ${phase === 'pre' ? 'before' : 'after'} the intervention`, upNote + taskIntro(t) + `<div class="modal-sub">${amountText(t, amount)}${T.behavioral ? '. No feedback during the real trials.' : '.'}</div>`, [{ text: '▶ Start', value: 1, primary: true }])
    overlay(true); stamp(phase + 'Start')
    await recorded(phase, async () => {
      if (t === 'flanker') cur[phase] = await runFlanker({ ui, n: amount, phase, participant: cur.participant, intervention: cur.intervention, signal: ctl.signal })
      else if (t === 'stroop') { const rows = await runStroop({ ui, seconds: amount, phase, participant: cur.participant, intervention: cur.intervention, signal: ctl.signal }); cur[phase] = rows; ui.setTitle(`Stroop task — ${phase === 'pre' ? 'before' : 'after'}`) }
      else { await runTimer({ ui, seconds: amount, title: T.name, lines: ['Eyes closed. Follow the instructions you were just given.', 'Teammates: stay silent. The screen says when time is up.'], signal: ctl.signal, onDone: beep }); cur.timedDone++ }
    })
    stamp(phase + 'End'); persist(); overlay(false)
  }

  async function doIntervention() {
    cur.phase = 'intervention'; cur.stepIndex = 2; persist()
    const iv = cur.intervention, I = INTERVENTIONS[iv], s = secs(cur.ivMinutes * 60), mins = fmtSecs(s)
    stamp('interventionStart')
    const say = (lines) => lines.map((l) => `<p class="script-line">${l}</p>`).join('')
    if (iv === 'exercise') {
      const c = await choose(`Intervention: physical exercise (${mins})`, `<div class="modal-sub">Do <b>light-to-moderate</b> exercise you are comfortable with — for example marching in place or climbing stairs. <b>Stop right away if you feel dizzy, short of breath, or any pain.</b> This is optional; you may pick another intervention.</div>`,
        [{ text: `▶ Start the ${mins} exercise`, value: 'go', primary: true }, { text: 'Choose a different intervention', value: 'no' }])
      if (c === 'no') { cur.aborted = true; throw new DOMException('declined', 'AbortError') }
      overlay(true); await recorded('intervention', () => runTimer({ ui, seconds: s, title: 'Physical exercise', lines: ['Keep moving at a comfortable pace.', 'Stop immediately if you feel unwell.'], signal: ctl.signal, onDone: beep })); overlay(false)
      await choose('Time is up', `<div class="modal-sub">Stop exercising and sit down. Start the task again within about a minute.</div>`, [{ text: '▶ I am ready', value: 1, primary: true }])
    } else if (iv === 'stroop') {
      await choose(`Intervention: Stroop training (${mins})`, stroopIntro + `<div class="modal-sub">You will see ✓ or ✗ after each answer.</div>`, [{ text: `▶ Start the ${mins} training`, value: 1, primary: true }])
      overlay(true); cur.ivTrials = await recorded('intervention', () => runStroop({ ui, seconds: s, phase: 'training', participant: cur.participant, intervention: iv, signal: ctl.signal })); overlay(false)
    } else {
      await choose(`Intervention: ${I.name.toLowerCase()} (${mins})`, `<div class="modal-sub">Reader: read this aloud, slowly and quietly. Then stay silent for the rest of the time.</div>` + say(I.lines), [{ text: `▶ Start (${mins})`, value: 1, primary: true }])
      const shortLines = iv === 'imagery' ? ['Eyes closed. Picture yourself doing what you are good at — and doing it well.', 'Teammates: stay silent. The screen says when time is up.'] : ['Eyes closed. Follow the instructions you were just given.', 'Teammates: stay silent. The screen says when time is up.']
      overlay(true); await recorded('intervention', () => runTimer({ ui, seconds: s, title: I.name, lines: shortLines, signal: ctl.signal, onDone: beep })); overlay(false)
    }
    stamp('interventionEnd'); persist()
  }

  async function start(cfg) {
    if (running) return false
    const T = TASKS[cfg.task], amount = Math.max(1, +cfg.amount || T.def), ivMinutes = Math.max(0.05, +cfg.ivMinutes || 5)
    cur = { n: runs.length + 1, participant: cfg.participant, group: cfg.group || '', hypothesis: cfg.hypothesis || '', task: cfg.task, amount, intervention: cfg.intervention, ivMinutes, beep: !!cfg.beep,
      phase: 'setup', stepIndex: 1, done: false, aborted: false, exported: false, startedAt: Date.now(), endedAt: null, times: {}, eeg: {}, practice: [], pre: [], post: [], ivTrials: [], timedDone: 0 }
    forced = false; runs.push(cur); running = true; stamp('start'); persist(); render()
    ctl = new AbortController()
    try {
      if (T.behavioral) {
        cur.phase = 'pre'
        await choose('Practice first', taskIntro(cfg.task) + `<div class="modal-sub">A short practice with feedback (✓ / ✗).</div>`, [{ text: '▶ Start practice', value: 1, primary: true }])
        overlay(true)
        cur.practice = cfg.task === 'flanker' ? await runFlanker({ ui, n: trials(8), phase: 'practice', practice: true, participant: cur.participant, intervention: cur.intervention, signal: ctl.signal })
          : await runStroop({ ui, seconds: secs(15), phase: 'practice', participant: cur.participant, intervention: cur.intervention, signal: ctl.signal })
        overlay(false)
      }
      cur.phase = 'pre'; cur.stepIndex = 1; await doTask('pre')
      await doIntervention()
      cur.phase = 'post'; cur.stepIndex = 3; await doTask('post')
      cur.phase = 'results'; cur.stepIndex = 4; cur.done = true; stamp('end')
    } catch (e) {
      overlay(false); try { hooks.phaseEnd() } catch { /* none running */ }
      if (e?.name === 'AbortError') cur.aborted = true; else console.error(e)
    } finally { running = false; cur.endedAt = Date.now(); persist(); render(); document.dispatchEvent(new CustomEvent('project-change')) }
    return true
  }
  async function abort() {
    if (!running) return
    const c = await choose('Quit this run?', `<div class="modal-sub">Data so far are kept and can be downloaded. The run cannot be resumed.</div>`, [{ text: 'Keep going', value: 'no', primary: true }, { text: 'Quit now', value: 'yes' }])
    if (c === 'yes') ctl?.abort()
  }

  // ---------- results ----------
  const fmtVal = (r, v) => (v == null ? '–' : r.unit === 'ms' ? `${Math.round(v)} ms` : `${v.toFixed(0)}%`)
  const fmtDelta = (r) => (r.delta == null ? '–' : r.unit === 'ms' ? `${sgnN(r.delta)} ms` : `${sgnN(r.delta)} pts`)
  function cardHtml(r) {
    const word = r.dir === 'same' ? 'no change' : r.dir === 'up' ? r.more : r.less
    const good = r.dir !== 'same' && (r.lowerIsBetter ? r.dir === 'down' : r.dir === 'up')
    const cls = r.delta == null || !r.clear ? 'flat' : good ? 'good' : 'bad'
    const nz = r.noise == null ? '' : r.unit === 'ms' ? `${Math.round(r.noise)} ms` : `${r.noise.toFixed(0)} pts`
    const noise = r.ceiling ? 'Both near 100% — little room for accuracy to change.' : r.dir === 'same' || r.noise == null ? '' : r.clear ? `Larger than trial-to-trial noise (±${nz}).` : `Within trial-to-trial noise (±${nz}) — treat as unclear.`
    return `<div class="card"><div class="card-label">${r.title}</div><div class="card-sub">${r.sub}</div>
      <div class="card-nums"><span>${fmtVal(r, r.bv)}</span><i>→</i><span class="after">${fmtVal(r, r.pv)}</span></div>
      <div class="card-delta ${cls}">${fmtDelta(r)}${r.delta == null ? '' : ` · ${word}`}</div><div class="card-noise">${noise}</div></div>`
  }
  const eegStats = (run) => ['pre', 'intervention', 'post'].map((ph) => ({ ph, s: run.eeg[ph] ? hooks.eegStats(`R${run.n} ${ph}`) : null }))
  const protoLine = (r) => `${TASKS[r.task].name} (${amountText(r.task, r.amount)}) → ${INTERVENTIONS[r.intervention].name.toLowerCase()} (${fmtSecs(Math.round(r.ivMinutes * 60))}) → same task again`

  function render() {
    const view = cur || runs[runs.length - 1]
    $('proj-setup').hidden = !!(view && !running && view.pre.length + view.timedDone > 0 && !forced)
    $('proj-results').hidden = !view || (!view.pre.length && !view.timedDone)
    $('proj-continue-bar').hidden = !(view && view.done)
    $('proj-status').textContent = running ? `Running: ${STEPS[cur.stepIndex]}…` : cur?.done ? `Run ${cur.n} complete.` : cur?.aborted ? 'Run stopped early — partial data can be downloaded.' : hasData() ? 'Data available.' : 'Ready.'
    $('proj-download').disabled = !hasData()
    const eegNow = hooks.eegLive()
    $('proj-headset').textContent = eegNow ? '🟢 Muse streaming — each phase is also recorded as an EEG block.' : '⚪ No headset connected — behavior only. (Connect the Muse in “Explore EEG”, then come back, to record EEG too.)'
    if (!view || $('proj-results').hidden) return
    const T = TASKS[view.task]
    $('proj-protocol').textContent = `Run ${view.n} · ${view.participant}${view.group ? ' · ' + view.group : ''} — ${protoLine(view)}`
    $('proj-hyp').hidden = !view.hypothesis; $('proj-hyp').innerHTML = view.hypothesis ? `<b>Your prediction:</b> ${escapeHtml(view.hypothesis)}` : ''
    if (T.behavioral) {
      const c = compare(view.pre, view.post, T.effect)
      $('proj-cards').innerHTML = c.rows.map(cardHtml).join('')
      $('proj-missing').hidden = view.post.length > 0
    } else {
      $('proj-cards').innerHTML = `<div class="card"><div class="card-label">${T.name}</div><div class="card-sub">no behavioral score</div><div class="card-noise">This task has no reaction-time measure. Look at the EEG below (if recorded) and your own notes.</div></div>`
      $('proj-missing').hidden = true
    }
    const es = eegStats(view), have = es.some((e) => e.s)
    $('proj-eeg').hidden = !have
    if (have) $('proj-eeg-table').innerHTML = '<table><tr><th>Phase</th><th>Seconds</th><th>Theta (dB)</th><th>Alpha (dB)</th><th>Beta (dB)</th></tr>' +
      es.map(({ ph, s }) => `<tr><td>${ph}</td>${s ? `<td>${s.seconds.toFixed(0)}</td><td>${s.theta.toFixed(1)}</td><td>${s.alpha.toFixed(1)}</td><td>${s.beta.toFixed(1)}</td>` : '<td colspan="4">not recorded</td>'}</tr>`).join('') + '</table>'
    $('proj-runs').innerHTML = '<table><tr><th>#</th><th>Participant</th><th>Group</th><th>Task</th><th>Intervention</th><th>Min</th><th>Δ RT</th><th>Δ interference</th><th>Δ accuracy</th><th>EEG</th></tr>' + runs.map((r) => {
      const beh = TASKS[r.task].behavioral && r.post.length ? compare(r.pre, r.post).rows : null
      const d = (i, dec, suf) => (beh && beh[i].delta != null ? `${sgnN(beh[i].delta, dec)}${suf}` : '–')
      return `<tr><td>${r.n}</td><td>${escapeHtml(r.participant)}</td><td>${escapeHtml(r.group)}</td><td>${TASKS[r.task].name}</td><td>${INTERVENTIONS[r.intervention].name}</td><td>${+r.ivMinutes.toFixed(2)}</td><td>${d(1, 0, ' ms')}</td><td>${d(0, 0, ' ms')}</td><td>${d(2, 0, ' pts')}</td><td>${Object.values(r.eeg).some(Boolean) ? 'yes' : 'no'}</td></tr>`
    }).join('') + '</table>'
  }
  let forced = false
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  // ---------- export (one ZIP, one folder per run) ----------
  function runFiles(r, dir) {
    const T = TASKS[r.task], all = [...r.practice, ...r.pre, ...r.post]
    const ev = [['event', 'time_iso']]
    for (const [k, v] of Object.entries(r.times)) ev.push([k, v])
    const sum = [['phase', 'congruency', 'n', 'answered', 'correct', 'errors', 'no_answer', 'accuracy', 'mean_rt_ms_correct', 'median_rt_ms_correct', 'sd_rt_ms_correct']]
    if (T.behavioral) for (const ph of ['pre', 'post']) {
      if (!r[ph].length) continue
      const z = summarize(r[ph])
      for (const k of ['congruent', 'incongruent', 'all']) { const m = z[k]; sum.push([ph, k, m.n, m.answered, m.correct, m.errors, m.omissions, m.accuracy?.toFixed(4) ?? '', m.meanRt?.toFixed(1) ?? '', m.medianRt?.toFixed(1) ?? '', m.sdRt?.toFixed(1) ?? '']) }
      sum.push([ph, 'interference_ms', '', '', '', '', '', '', z.effect?.toFixed(1) ?? '', '', ''])
    }
    const eeg = [['phase', 'block_label', 'seconds', 'theta_db', 'alpha_db', 'beta_db']]
    for (const { ph, s } of eegStats(r)) if (s) eeg.push([ph, `R${r.n} ${ph}`, s.seconds.toFixed(1), s.theta.toFixed(2), s.alpha.toFixed(2), s.beta.toFixed(2)])
    const proto = { run: r.n, participant: r.participant, group: r.group, hypothesis: r.hypothesis, preTask: r.task, postTask: r.task, taskAmount: r.amount, taskUnit: T.unit,
      intervention: r.intervention, interventionMinutes: r.ivMinutes, eegBlocks: r.eeg, complete: r.done, stoppedEarly: r.aborted, timescale: TS }
    const f = [{ name: `${dir}/protocol.json`, text: JSON.stringify(proto, null, 2) + '\n' }, { name: `${dir}/events.csv`, text: csv(ev) }]
    if (T.behavioral) f.push({ name: `${dir}/task_trials.csv`, text: trialsToCsv(all) }, { name: `${dir}/summary.csv`, text: csv(sum) })
    if (r.ivTrials.length) f.push({ name: `${dir}/intervention_stroop_trials.csv`, text: trialsToCsv(r.ivTrials) })
    if (eeg.length > 1) f.push({ name: `${dir}/eeg_phase_summary.csv`, text: csv(eeg) })
    return f
  }
  function download() {
    if (!hasData()) return
    const tag = `project-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    const files = []
    runs.forEach((r) => { if (r.pre.length || r.post.length || r.timedDone || r.ivTrials.length) files.push(...runFiles(r, `${tag}/run-${String(r.n).padStart(2, '0')}-${r.participant.replace(/[^\w-]+/g, '') || 'anon'}`)) })
    files.push({ name: `${tag}/session_runs.csv`, text: csv([['run', 'participant', 'group', 'task', 'task_amount', 'intervention', 'intervention_min', 'complete', 'eeg_recorded', 'hypothesis'],
      ...runs.map((r) => [r.n, r.participant, r.group, r.task, r.amount, r.intervention, r.ivMinutes, r.done, Object.values(r.eeg).some(Boolean), r.hypothesis])]) })
    const eegFiles = hooks.eegFiles(`${tag}/eeg`)
    files.push(...eegFiles)
    files.push({ name: `${tag}/README.txt`, text: 'Brain Dynamics Lab (PSYC 20N) — My Project.\nOne folder per run. protocol.json: the design (pre and post task are the same task). events.csv: ISO wall-clock times of every phase start/end (phase timing is accurate to well under a second). task_trials.csv: every trial (phase = practice / pre / post); rt_ms is stimulus paint to key press, +/- about one display frame. summary.csv: accuracy and mean/median RT of CORRECT trials per phase and congruency. intervention_stroop_trials.csv: only if Stroop training was the intervention. eeg_phase_summary.csv: mean absolute band power (dB re 1 uV^2) per phase when the Muse was streaming.\nsession_runs.csv lists all runs. ' + (eegFiles.length ? 'The eeg/ folder is the full Muse recording of the session; blocks.csv lists blocks labelled "R<run> pre / intervention / post". Align behavior to EEG with events.csv wall-clock times plus blocks.csv; expect roughly 10-30 ms of offset.\n' : 'No EEG was recorded in this session.\n') + 'Classroom data, not research-grade timing.\n' })
    runs.forEach((r) => { r.exported = true }); persist()
    const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files)); a.download = `${tag}.zip`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000)
  }

  // ---------- recovery ----------
  function recover() {
    try { const d = JSON.parse(localStorage.getItem(KEY) || 'null'); return d?.runs?.some((r) => !r.exported && (r.pre?.length || r.post?.length || r.timedDone)) ? d : null } catch { return null }
  }
  function adopt(d) { runs = d.runs; cur = runs[runs.length - 1]; running = false; render(); document.dispatchEvent(new CustomEvent('project-change')) }

  return { get state() { return { runs, cur, running } }, start, abort, download, render, recover, adopt, hasData, anyUnsaved,
    showSetup() { forced = true; render(); $('proj-who').focus() }, hideSetup() { forced = false },
    clearStored() { try { localStorage.removeItem(KEY) } catch { /* ignore */ } } }
}
