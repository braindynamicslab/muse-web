// "My Project" (Week 6): students design a pre task → intervention → post task experiment and run several
// participants in one session. The post task is always the SAME task as the pre task, so any change is comparable.
// Behavior needs no headset; if a Muse is streaming, each phase is also recorded as a labelled EEG block.
// All data stay in this browser (localStorage checkpoint + a ZIP the student downloads). Nothing is sent anywhere.

import { runFlanker, runStroop, runTimer, summarize, trialsToCsv, shuffle } from './behavior.js'
import { SCRIPTS } from './weeks.js'
import { makeZip } from './zip.js'

const KEY = 'muse-web-project-v1'
const TS = (typeof location !== 'undefined' && +new URLSearchParams(location.search).get('timescale')) || 1      // rehearsal only
const secs = (s) => Math.max(3, Math.round(s / TS))
const trials = (n) => Math.max(6, Math.round(n / TS))
export const STEPS = ['Design', 'Pre task', 'Intervention', 'Post task', 'Results']
export const STEPS_STIM = ['Design', 'Watch & rate', 'Results']
export const SCALES = [
  { id: 'valence', name: 'Valence', q: 'How did it feel?', lo: 'very unpleasant', hi: 'very pleasant' },
  { id: 'arousal', name: 'Arousal', q: 'How activated or excited did you feel?', lo: 'very calm', hi: 'very excited' },
  { id: 'engagement', name: 'Engagement', q: 'How absorbed were you?', lo: 'bored, distracted', hi: 'fully absorbed' },
]

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
  function overlay(on) { $('task').hidden = !on; $('task-step').textContent = on ? `Run ${cur.n} · ${cur.participant} · ${stepName(cur)}` : ''; if (on) document.activeElement?.blur?.() }
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


  // ---------- stimulus project: baseline cross -> clip -> ratings, per clip ----------
  const stepName = (r) => (r.kind === 'stimulus' ? STEPS_STIM : STEPS)[r.stepIndex]
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  async function fixation(seconds) {
    ui.setTitle('Look at the cross'); ui.setFoot('Keep your eyes on the + and relax.'); ui.stage.className = 'fix'; ui.stage.textContent = '+'
    const t0 = performance.now()
    while (performance.now() - t0 < seconds * 1000) {
      if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError')
      ui.setProgress(`${Math.max(0, Math.ceil(seconds - (performance.now() - t0) / 1000))} s`); await wait(200)
    }
    ui.stage.className = ''; ui.stage.textContent = ''
  }
  async function playClip(clip, title) {
    ui.setTitle(title); ui.setFoot(''); ui.setProgress(''); ui.stage.className = ''; ui.stage.textContent = ''
    const v = document.createElement('video'); v.src = clip.url; v.playsInline = true; v.style.cssText = 'max-width:96vw;max-height:78vh;background:#000'
    ui.stage.appendChild(v)
    const t0 = performance.now(); let dur = null
    try {
      await new Promise((resolve, reject) => {
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
        ctl.signal.addEventListener('abort', onAbort, { once: true })
        v.addEventListener('ended', resolve); v.addEventListener('error', () => reject(new Error('video error')))
        v.addEventListener('timeupdate', () => { const left = Math.max(0, Math.ceil((v.duration || 0) - v.currentTime)); ui.setProgress(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`) })
        v.play().catch(() => { v.controls = true; ui.setFoot('Press play on the video to start.') })
      })
      dur = v.duration
    } finally { v.pause(); v.removeAttribute('src'); v.load(); v.remove() }
    return { seconds: dur ?? (performance.now() - t0) / 1000 }
  }
  async function rateDialog(clip) {
    const body = SCALES.map((sc) => `<div class="rate-row"><div class="rate-q"><b>${sc.name}</b> ${sc.q}</div><div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span class="sub">${sc.lo}</span>${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `<label style="display:flex;flex-direction:column;align-items:center;font-size:12px"><input type="radio" name="sc-${sc.id}" value="${i}">${i}</label>`).join('')}<span class="sub">${sc.hi}</span></div></div>`).join('')
      + `<label class="proj-hyp" style="margin-top:8px">Note (optional) <textarea id="sc-note" rows="2" placeholder="what did you notice or feel?"></textarea></label>`
    for (;;) {
      await choose(`How was “${clip.label}”?`, body, [{ text: 'Save ratings', value: 1, primary: true }])
      const root = $('modal-body'), val = (id) => { const e = root.querySelector(`input[name="sc-${id}"]:checked`); return e ? +e.value : null }
      const out = { valence: val('valence'), arousal: val('arousal'), engagement: val('engagement'), note: root.querySelector('#sc-note')?.value.trim() || '' }
      if (out.valence != null && out.arousal != null && out.engagement != null) return out
    }
  }
  async function startStim(cfg) {
    const clips = (cfg.clips || []).map((c) => ({ label: c.label, name: c.name, url: c.url }))
    const order = cfg.randomize ? shuffle(clips) : clips
    cur = { n: runs.length + 1, kind: 'stimulus', participant: cfg.participant, group: cfg.group || '', hypothesis: cfg.hypothesis || '', task: 'stimulus', amount: 0, intervention: '', ivMinutes: 0, beep: false,
      baselineSec: Math.max(0, +cfg.baselineSec || 0), randomize: !!cfg.randomize, order: order.map((c, i) => ({ i: i + 1, label: c.label, name: c.name, seconds: null, baseLabel: `R${runs.length + 1} base ${i + 1}`, clipLabel: `R${runs.length + 1} clip ${i + 1} ${c.label}`, baseEeg: false, clipEeg: false })),
      ratings: [], phase: 'watch', stepIndex: 1, done: false, aborted: false, exported: false, startedAt: Date.now(), endedAt: null, times: {}, eeg: {}, practice: [], pre: [], post: [], ivTrials: [], timedDone: 0 }
    forced = false; runs.push(cur); running = true; stamp('start'); persist(); render()
    ctl = new AbortController()
    try {
      await choose('Watch and rate', `<div class="modal-sub">${order.length} clip${order.length > 1 ? 's' : ''}. Before each one, look at the + for ${cur.baselineSec} s. Watch the clip, then rate how it felt. Sit still and keep your eyes on the screen.</div>`, [{ text: '▶ Start', value: 1, primary: true }])
      for (let i = 0; i < order.length; i++) {
        const o = cur.order[i], clip = order[i]
        overlay(true)
        if (cur.baselineSec > 0) {
          stamp(`base${o.i}Start`); const e = hooks.phaseStart(o.baseLabel); o.baseEeg = !!e
          try { await fixation(cur.baselineSec) } finally { if (e) hooks.phaseEnd() }
          stamp(`base${o.i}End`)
        }
        stamp(`clip${o.i}Start`); const e2 = hooks.phaseStart(o.clipLabel); o.clipEeg = !!e2
        try { o.seconds = (await playClip(clip, `Clip ${o.i} of ${order.length}`)).seconds } finally { if (e2) hooks.phaseEnd() }
        stamp(`clip${o.i}End`); cur.eeg[`clip${o.i}`] = o.clipEeg; cur.timedDone++
        overlay(false); persist()
        cur.ratings.push({ i: o.i, label: o.label, ...(await rateDialog(o)) }); stamp(`rated${o.i}`); persist()
      }
      cur.phase = 'results'; cur.stepIndex = 2; cur.done = true; stamp('end')
    } catch (e) {
      overlay(false); try { hooks.phaseEnd() } catch { /* none running */ }
      if (e?.name === 'AbortError') cur.aborted = true; else { console.error(e); cur.aborted = true }
    } finally { running = false; cur.endedAt = Date.now(); persist(); render(); document.dispatchEvent(new CustomEvent('project-change')) }
    return true
  }
  function stimRows(r) {
    const dB = (s, k) => (s ? s[k] : null)
    return r.order.map((o) => {
      const c = o.clipEeg ? hooks.eegStats(o.clipLabel) : null, b = o.baseEeg ? hooks.eegStats(o.baseLabel) : null, rt = r.ratings.find((x) => x.i === o.i)
      return { o, rt, c, b, d: (k) => (c && b ? c[k] - b[k] : null) }
    })
  }
  function stimTable(r) {
    const f = (v, d = 1) => (v == null ? '–' : sgnN(v, d)), g = (v) => (v == null ? '–' : v.toFixed(1))
    return '<table><tr><th>#</th><th>Clip</th><th>Valence</th><th>Arousal</th><th>Engagement</th><th>α (dB)</th><th>Δα vs +</th><th>Δθ vs +</th><th>Δβ vs +</th></tr>' +
      stimRows(r).map(({ o, rt, c, d }) => `<tr><td>${o.i}</td><td>${escapeHtml(o.label)}</td><td>${rt?.valence ?? '–'}</td><td>${rt?.arousal ?? '–'}</td><td>${rt?.engagement ?? '–'}</td><td>${c ? g(c.alpha) : 'not recorded'}</td><td>${f(d('alpha'))}</td><td>${f(d('theta'))}</td><td>${f(d('beta'))}</td></tr>`).join('') + '</table>'
  }

  async function start(cfg) {
    if (running) return false
    if (cfg.kind === 'stimulus') return startStim(cfg)
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
  const protoLine = (r) => r.kind === 'stimulus' ? `Watch ${r.order.length} clip${r.order.length > 1 ? 's' : ''} (${r.randomize ? 'random order' : 'fixed order'}, ${r.baselineSec} s cross before each) → rate each` : `${TASKS[r.task].name} (${amountText(r.task, r.amount)}) → ${INTERVENTIONS[r.intervention].name.toLowerCase()} (${fmtSecs(Math.round(r.ivMinutes * 60))}) → same task again`

  function render() {
    const view = cur || runs[runs.length - 1]
    $('proj-setup').hidden = !!(view && !running && view.pre.length + view.timedDone > 0 && !forced)
    $('proj-results').hidden = !view || (!view.pre.length && !view.timedDone)
    $('proj-continue-bar').hidden = !(view && view.done)
    $('proj-status').textContent = running ? `Running: ${stepName(cur)}…` : cur?.done ? `Run ${cur.n} complete.` : cur?.aborted ? 'Run stopped early — partial data can be downloaded.' : hasData() ? 'Data available.' : 'Ready.'
    $('proj-download').disabled = !hasData()
    const eegNow = hooks.eegLive()
    $('proj-headset').textContent = eegNow ? '🟢 Muse streaming — each phase is also recorded as an EEG block.' : '⚪ No headset connected — behavior only. (Connect the Muse in “Explore EEG”, then come back, to record EEG too.)'
    if (!view || $('proj-results').hidden) return
    const T = TASKS[view.task] || {}
    $('proj-protocol').textContent = `Run ${view.n} · ${view.participant}${view.group ? ' · ' + view.group : ''} — ${protoLine(view)}`
    $('proj-hyp').hidden = !view.hypothesis; $('proj-hyp').innerHTML = view.hypothesis ? `<b>Your prediction:</b> ${escapeHtml(view.hypothesis)}` : ''
    if (view.kind === 'stimulus') {
      $('proj-cards').innerHTML = `<div class="proj-table" style="grid-column:1/-1">${stimTable(view)}</div><div class="sub" style="grid-column:1/-1">Ratings 1–9. Δ = clip minus the cross just before it (absolute power, dB). One participant per row set; clips differ in more than emotion (brightness, motion, sound, length), so compare cautiously.</div>`
      $('proj-missing').hidden = true; $('proj-eeg').hidden = true
      renderRuns(); return
    }
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
    renderRuns()
  }
  function renderRuns() {
    $('proj-runs').innerHTML = '<table><tr><th>#</th><th>Participant</th><th>Group</th><th>Task</th><th>Intervention</th><th>Min</th><th>Δ RT</th><th>Δ interference</th><th>Δ accuracy</th><th>EEG</th></tr>' + runs.map((r) => {
      const beh = r.kind !== 'stimulus' && TASKS[r.task].behavioral && r.post.length ? compare(r.pre, r.post).rows : null
      const d = (i, dec, suf) => (beh && beh[i].delta != null ? `${sgnN(beh[i].delta, dec)}${suf}` : '–')
      return `<tr><td>${r.n}</td><td>${escapeHtml(r.participant)}</td><td>${escapeHtml(r.group)}</td><td>${r.kind === 'stimulus' ? 'Watch ' + r.order.length + ' clips' : TASKS[r.task].name}</td><td>${r.kind === 'stimulus' ? '–' : INTERVENTIONS[r.intervention].name}</td><td>${r.kind === 'stimulus' ? '–' : +r.ivMinutes.toFixed(2)}</td><td>${d(1, 0, ' ms')}</td><td>${d(0, 0, ' ms')}</td><td>${d(2, 0, ' pts')}</td><td>${Object.values(r.eeg).some(Boolean) ? 'yes' : 'no'}</td></tr>`
    }).join('') + '</table>'
  }
  let forced = false
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  // ---------- export (one ZIP, one folder per run) ----------
  function runFiles(r, dir) {
    if (r.kind === 'stimulus') {
      const ev = [['event', 'time_iso'], ...Object.entries(r.times)]
      const proto = { run: r.n, kind: 'stimulus', participant: r.participant, group: r.group, hypothesis: r.hypothesis, baselineSeconds: r.baselineSec, randomOrder: r.randomize, clipsInPresentedOrder: r.order.map((o) => ({ order: o.i, label: o.label, file: o.name, seconds: o.seconds, baselineBlock: o.baseLabel, clipBlock: o.clipLabel, eegBaseline: o.baseEeg, eegClip: o.clipEeg })), complete: r.done, stoppedEarly: r.aborted, timescale: TS }
      const eeg = [['order', 'clip', 'phase', 'block_label', 'seconds', 'theta_db', 'alpha_db', 'beta_db']]
      for (const o of r.order) for (const [ph, lab, on] of [['baseline', o.baseLabel, o.baseEeg], ['clip', o.clipLabel, o.clipEeg]]) { const t = on ? hooks.eegStats(lab) : null; if (t) eeg.push([o.i, o.label, ph, lab, t.seconds.toFixed(1), t.theta.toFixed(2), t.alpha.toFixed(2), t.beta.toFixed(2)]) }
      const f = [{ name: `${dir}/protocol.json`, text: JSON.stringify(proto, null, 2) + '\n' }, { name: `${dir}/events.csv`, text: csv(ev) },
        { name: `${dir}/stimuli.csv`, text: csv([['order', 'clip', 'file', 'seconds', 'baseline_s'], ...r.order.map((o) => [o.i, o.label, o.name, o.seconds?.toFixed(2) ?? '', r.baselineSec])]) },
        { name: `${dir}/ratings.csv`, text: csv([['order', 'clip', 'valence_1_9', 'arousal_1_9', 'engagement_1_9', 'note'], ...r.ratings.map((x) => [x.i, x.label, x.valence, x.arousal, x.engagement, x.note])]) }]
      if (eeg.length > 1) f.push({ name: `${dir}/eeg_phase_summary.csv`, text: csv(eeg) })
      return f
    }
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
    files.push({ name: `${tag}/README.txt`, text: 'Brain Dynamics Lab (PSYC 20N) — My Project.\nOne folder per run. protocol.json: the design (pre and post task are the same task). events.csv: ISO wall-clock times of every phase start/end (phase timing is accurate to well under a second). task_trials.csv: every trial (phase = practice / pre / post); rt_ms is stimulus paint to key press, +/- about one display frame. summary.csv: accuracy and mean/median RT of CORRECT trials per phase and congruency. intervention_stroop_trials.csv: only if Stroop training was the intervention. eeg_phase_summary.csv: mean absolute band power (dB re 1 uV^2) per phase when the Muse was streaming.\nstimulus runs: stimuli.csv (clips in the order shown), ratings.csv (valence, arousal, engagement 1-9 after each clip). session_runs.csv lists all runs. ' + (eegFiles.length ? 'The eeg/ folder is the full Muse recording of the session; blocks.csv lists blocks labelled "R<run> pre / intervention / post". Align behavior to EEG with events.csv wall-clock times plus blocks.csv; expect roughly 10-30 ms of offset.\n' : 'No EEG was recorded in this session.\n') + 'Classroom data, not research-grade timing.\n' })
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

/** Design UI for the "watch clips" project: local video files only (nothing is uploaded or streamed). Returns getters. */
export function stimulusDesigner($) {
  const clips = []      // { label, name, url, seconds }
  const list = $('stim-list')
  const redraw = () => {
    list.innerHTML = clips.length ? clips.map((c, i) => `<div class="stim-row"><b>${i + 1}</b><input data-i="${i}" value="${c.label.replace(/"/g, '&quot;')}" maxlength="40"><span class="sub">${c.name}${c.seconds ? ` · ${Math.floor(c.seconds / 60)}:${String(Math.round(c.seconds % 60)).padStart(2, '0')}` : ''}</span><button data-x="${i}">✕</button></div>`).join('') : '<div class="sub">No clips yet. Add video files from this computer.</div>'
  }
  list.addEventListener('input', (e) => { const i = e.target.dataset.i; if (i != null) clips[i].label = e.target.value })
  list.addEventListener('click', (e) => { const i = e.target.dataset.x; if (i != null) { URL.revokeObjectURL(clips[i].url); clips.splice(i, 1); redraw() } })
  $('stim-files').addEventListener('change', (e) => {
    for (const f of e.target.files) {
      const url = URL.createObjectURL(f), c = { label: f.name.replace(/\.[^.]+$/, '').slice(0, 40), name: f.name, url, seconds: null }
      clips.push(c); const v = document.createElement('video'); v.preload = 'metadata'; v.onloadedmetadata = () => { c.seconds = v.duration; redraw() }; v.src = url
    }
    e.target.value = ''; redraw()
  })
  redraw()
  return { clips: () => clips.map((c) => ({ label: c.label || c.name, name: c.name, url: c.url })), count: () => clips.length,
    baselineSec: () => $('stim-base').value, randomize: () => $('stim-random').checked }
}
