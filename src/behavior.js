// Behavioral tasks for Week 5 (arrow Flanker; colour-word Stroop for the "cognitive training" intervention).
// Runs entirely in the browser, needs no Muse, and sends nothing anywhere. Timing uses performance.now() and the
// keyboard event's own timestamp; expect ±1 display frame (~16 ms) of error — fine for a classroom, not a lab.
//
// Pure functions (trial generation, scoring, summaries) are separated from the DOM runner so they can be tested.

export const FLANKER = { fixMs: 500, maxMs: 1500, itiMin: 400, itiMax: 800, feedbackMs: 700 }
export const STROOP = { fixMs: 300, maxMs: 2500, itiMs: 250, feedbackMs: 250, pIncongruent: 0.75 }
export const STROOP_COLOURS = [
  { word: 'RED', ink: '#ff5a5a', key: 'r' }, { word: 'GREEN', ink: '#3ecf8e', key: 'g' },
  { word: 'BLUE', ink: '#5aa0ff', key: 'b' }, { word: 'YELLOW', ink: '#f5d442', key: 'y' },
]

// ---------- pure: trials ----------
export function shuffle(a, rand = Math.random) { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [x[i], x[j]] = [x[j], x[i]] } return x }

/** n trials, half congruent / half incongruent, target direction balanced within each, shuffled. */
export function makeFlankerTrials(n, rand = Math.random) {
  const base = []
  for (let i = 0; i < n; i++) {
    const congruent = i % 2 === 0, target = (i >> 1) % 2 === 0 ? 'left' : 'right'
    const t = target === 'left' ? '←' : '→', f = congruent ? t : (t === '←' ? '→' : '←')
    base.push({ congruency: congruent ? 'congruent' : 'incongruent', target, stimulus: f + f + t + f + f })
  }
  return shuffle(base, rand).map((tr, i) => ({ trial: i + 1, ...tr }))
}
export function makeStroopTrial(rand = Math.random) {
  const incong = rand() < STROOP.pIncongruent, w = STROOP_COLOURS[Math.floor(rand() * 4)]
  let ink = w
  if (incong) { do { ink = STROOP_COLOURS[Math.floor(rand() * 4)] } while (ink === w) }
  return { congruency: incong ? 'incongruent' : 'congruent', word: w.word, ink: ink.ink, answer: ink.key }
}

// ---------- pure: scoring and summaries ----------
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
/** Per congruency + overall: trials, accuracy (of answered trials), omissions, mean/median RT of CORRECT trials (ms). */
export function summarize(trials) {
  const out = {}
  for (const key of ['congruent', 'incongruent', 'all']) {
    const t = trials.filter((x) => key === 'all' || x.congruency === key), answered = t.filter((x) => !x.timeout)
    const correct = answered.filter((x) => x.correct), rts = correct.map((x) => x.rt_ms)
    out[key] = { n: t.length, answered: answered.length, omissions: t.length - answered.length, accuracy: answered.length ? correct.length / answered.length : null, meanRt: mean(rts), medianRt: median(rts) }
  }
  out.effect = out.congruent.meanRt != null && out.incongruent.meanRt != null ? out.incongruent.meanRt - out.congruent.meanRt : null   // flanker / Stroop interference (ms)
  return out
}

export function trialsToCsv(trials, extraCols = []) {
  const cols = ['participant', 'intervention', 'phase', 'trial', 'congruency', 'stimulus', 'target', 'response', 'correct', 'rt_ms', 'timeout', ...extraCols]
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
  return cols.join(',') + '\n' + trials.map((t) => cols.map((c) => q(t[c])).join(',')).join('\n') + '\n'
}

// ---------- DOM runner ----------
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** Resolves with performance.now() right after the next frame is drawn. If frames are paused (hidden tab) fall back
 *  to a timer so a trial can never hang waiting for a frame. */
const nextPaint = () => new Promise((r) => { let done = false; const go = () => { if (!done) { done = true; r(performance.now()) } }; requestAnimationFrame(go); setTimeout(go, 100) })

/** Wait for one of `keys` (case-insensitive event.key); resolves {key, t} (event timestamp) or null on timeout.
 *  Rejects with AbortError if signal aborts. */
function waitKey(keys, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let timer = null
    const cleanup = () => { document.removeEventListener('keydown', onKey, true); clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const onKey = (e) => {
      if (e.repeat) return
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (!keys.includes(k)) return
      e.preventDefault(); cleanup(); resolve({ key: k, t: e.timeStamp })
    }
    const onAbort = () => { cleanup(); reject(new DOMException('aborted', 'AbortError')) }
    document.addEventListener('keydown', onKey, true)
    if (timeoutMs) timer = setTimeout(() => { cleanup(); resolve(null) }, timeoutMs)
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort) }
  })
}

/** ui: { stage: HTMLElement, setTitle(t), setProgress(t), setFoot(html) } */
export async function runFlanker({ ui, n, phase, practice = false, participant = '', intervention = '', signal }) {
  const trials = makeFlankerTrials(n), out = []
  ui.setTitle(practice ? 'Practice' : phase === 'baseline' ? 'Arrow task — baseline' : 'Arrow task — after the intervention')
  ui.setFoot('Press <b>←</b> or <b>F</b> if the MIDDLE arrow points left · <b>→</b> or <b>J</b> if it points right. Be fast and accurate.')
  for (const tr of trials) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    ui.setProgress(`${tr.trial} / ${n}`)
    ui.stage.className = 'fix'; ui.stage.textContent = '+'
    await wait(FLANKER.fixMs)
    ui.stage.className = 'arrows'; ui.stage.textContent = tr.stimulus
    const onset = await nextPaint()
    const r = await waitKey(['ArrowLeft', 'ArrowRight', 'f', 'j'], FLANKER.maxMs, signal)
    const timeout = !r, response = r ? (r.key === 'ArrowLeft' || r.key === 'f' ? 'left' : 'right') : ''
    const correct = !timeout && response === tr.target
    out.push({ participant, intervention, phase, trial: tr.trial, congruency: tr.congruency, stimulus: tr.stimulus, target: tr.target, response, correct, rt_ms: timeout ? '' : +(r.t - onset).toFixed(1), timeout })
    ui.stage.textContent = ''
    if (practice) {
      ui.stage.className = correct ? 'fb ok' : 'fb bad'; ui.stage.textContent = timeout ? 'too slow' : correct ? '✓' : '✗ wrong'
      await wait(FLANKER.feedbackMs)
    } else ui.stage.className = ''
    await wait(FLANKER.itiMin + Math.random() * (FLANKER.itiMax - FLANKER.itiMin))
  }
  ui.stage.className = ''; ui.stage.textContent = ''
  return out
}

/** Colour-word Stroop for `seconds`; keys R G B Y answer the INK colour. */
export async function runStroop({ ui, seconds, phase = 'training', participant = '', intervention = '', signal }) {
  const out = []; const t0 = performance.now()
  ui.setTitle('Stroop training — name the INK colour')
  ui.setFoot('Press the key for the INK colour, not the word: <b>R</b> red · <b>G</b> green · <b>B</b> blue · <b>Y</b> yellow')
  let tn = 0
  while (performance.now() - t0 < seconds * 1000) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const left = Math.max(0, Math.ceil(seconds - (performance.now() - t0) / 1000))
    ui.setProgress(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`)
    const tr = makeStroopTrial(); tn++
    ui.stage.className = 'fix'; ui.stage.style.color = ''; ui.stage.textContent = '+'
    await wait(STROOP.fixMs)
    ui.stage.className = 'stroop'; ui.stage.textContent = tr.word; ui.stage.style.color = tr.ink
    const onset = await nextPaint()
    const r = await waitKey(['r', 'g', 'b', 'y'], STROOP.maxMs, signal)
    const timeout = !r, correct = !timeout && r.key === tr.answer
    out.push({ participant, intervention, phase, trial: tn, congruency: tr.congruency, stimulus: tr.word, target: tr.answer, response: r ? r.key : '', correct, rt_ms: timeout ? '' : +(r.t - onset).toFixed(1), timeout })
    ui.stage.style.color = ''; ui.stage.className = correct ? 'fb ok' : 'fb bad'; ui.stage.textContent = timeout ? 'too slow' : correct ? '✓' : '✗'
    await wait(STROOP.feedbackMs)
    ui.stage.className = ''; ui.stage.textContent = ''
    await wait(STROOP.itiMs)
  }
  return out
}

/** Countdown screen for rest / exercise / meditation interventions. Resolves when time is up. */
export async function runTimer({ ui, seconds, title, lines, signal, onDone }) {
  ui.setTitle(title); ui.setFoot('')
  ui.stage.className = 'timer'
  const t0 = performance.now()
  for (;;) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const left = Math.max(0, Math.ceil(seconds - (performance.now() - t0) / 1000))
    ui.setProgress(`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`)
    ui.stage.innerHTML = `<div class="timer-big">${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</div>` + lines.map((l) => `<p>${l}</p>`).join('')
    if (left <= 0) break
    await wait(250)
  }
  onDone?.()
  ui.stage.className = ''
}
