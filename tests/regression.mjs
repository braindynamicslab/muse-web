// Regression tests for the numerical and connection logic. Run: npm test   (needs Node ≥ 20; ~30 s)
// They check the pure modules against signals with known answers; they do not need a browser or a Muse.
import { BandPipeline, BANDS, SPEC_BINS } from '../src/dsp.js'
import { psd, derive, alphaMetrics, bandMetrics, peakAbove } from '../src/spectrum.js'
import { slidingSpectra, bandSeries, epochsAround, meanEpoch, permutationBand, STEP_S } from '../src/events.js'
import { SampleClock } from '../src/clock.js'
import { MuseLink, BACKOFF_MS } from '../src/link.js'
import SimulatedMuse from '../src/sim.js'
import { zipSamples } from 'muse-js'
import { compare, TASKS as PJ_TASKS, INTERVENTIONS as PJ_IVS } from '../src/project.js'
import { makeFlankerTrials, makeStroopTrial, summarize, trialsToCsv, shuffle } from '../src/behavior.js'

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')) }
const near = (a, b, tol) => Math.abs(a - b) <= tol
let seed = 12345
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5 }
const pink = (g) => { let a = 0; return () => (a = 0.97 * a + g * rnd()) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FS = 256

console.log('--- band pipeline (dsp.js)')
{
  const run = (mode, gen) => { const p = new BandPipeline(); p.channelMode = mode; p.useExternalQuality = true; let last, col; p.onBands = (bp, r, abs) => { last = { ...abs } }; p.onColumn = (c) => { col = c }; for (let n = 0; n < FS * 8; n++) p.push(gen(n / FS)); return { abs: last, bins: col.length } }
  const gen = (t) => [10 * Math.sin(2 * Math.PI * 10 * t), 20 * Math.sin(2 * Math.PI * 10 * t), 0.01, 5 * Math.sin(2 * Math.PI * 60 * t)]
  ok('spectrum column has 80 bins', run('tp9', gen).bins === SPEC_BINS && SPEC_BINS === 80)
  ok('single electrode alpha: 10 µV sine = 17.0 dB', near(run('tp9', gen).abs.alpha, 17.0, 0.1))
  ok('single electrode alpha: 20 µV sine = 23.0 dB', near(run('af7', gen).abs.alpha, 23.0, 0.1))
  ok('all-four mean power', near(run('all', gen).abs.alpha, 10 * Math.log10((50 + 200) / 4), 0.1))
  const p = new BandPipeline(); p.useExternalQuality = true; p.quality = ['good', 'good', 'good', 'good']; p.lockWeights(); p.quality = ['poor', 'good', 'good', 'poor']
  ok('locked weights stay fixed when contact worsens', p._weights().every((w) => w === 0.25)); p.unlockWeights()
  ok('unlocked: poor ears dropped', p._weights()[0] === 0 && p._weights()[3] === 0)
  const q = new BandPipeline(); q.reset(); ok('reset clears lock', q.lockedWeights === null)
}

console.log('--- spectra from raw (spectrum.js)')
{
  const N = FS * 40
  const mk = (alphaF, amp, low = 0.0001) => { const a = pink(4), b = pink(low); return Float64Array.from({ length: N }, (_, i) => a() + b() + amp * Math.sin(2 * Math.PI * alphaF * i / FS) + 300) }
  const pure = Float64Array.from({ length: N }, (_, i) => 10 * Math.sin(2 * Math.PI * 10 * i / FS))
  ok('alpha band power of a 10 µV sine = 17.0 dB', near(alphaMetrics(psd([pure]).pw).bandDb, 17.0, 0.1))
  for (const f0 of [9.0, 9.6, 10.4, 11.1]) { const m = alphaMetrics(psd([mk(f0, 8)]).pw); ok(`IAF estimate for a ${f0} Hz peak`, m.iaf != null && near(m.iaf, f0, 0.08), `(${m.iaf?.toFixed(2)})`) }
  const noAlpha = alphaMetrics(psd([mk(10, 0)]).pw), lowBg = alphaMetrics(psd([mk(10, 0, 30)]).pw)
  ok('no alpha: "above background" ≈ 0 dB', Math.abs(noAlpha.aboveDb) < 1.5)
  ok('raw 8–13 Hz power is fooled by low-frequency drift, "above background" is not', lowBg.bandDb - noAlpha.bandDb > 10 && Math.abs(lowBg.aboveDb) < 1.5, `(raw +${(lowBg.bandDb - noAlpha.bandDb).toFixed(0)} dB, above ${lowBg.aboveDb.toFixed(1)} dB)`)
  const X = [mk(10.3, 10), mk(10.3, 0), mk(10.3, 0), mk(10.3, 10)]
  X[3] = Float64Array.from(X[0])                                          // identical ear signals → in-phase alpha
  const dev = alphaMetrics(psd([derive(X, 0, 'device')]).pw), bip = alphaMetrics(psd([derive(X, 0, 'bipolar')]).pw)
  ok('peak survives re-referencing to the average, but cancels in TP9−TP10 when ears match', dev.strength === 'clear' && bip.strength !== 'clear')
  const th = bandMetrics(psd([mk(6, 5)], 160, 512).pw, 4, 8, [[1.5, 3], [14, 35]]), thBg = bandMetrics(psd([mk(6, 0, 30)], 160, 512).pw, 4, 8, [[1.5, 3], [14, 35]])
  ok('theta above background responds to theta, not to drift', th.aboveDb > 5 && Math.abs(thBg.aboveDb) < 1.5, `(${th.aboveDb.toFixed(1)}, ${thBg.aboveDb.toFixed(1)})`)
}

console.log('--- event-locked analysis (events.js)')
{
  const N = FS * 240, presses = [30, 62, 95, 128, 160, 192]
  const mk = (bursts, amp) => { const a = pink(4), b = pink(4); return Float64Array.from({ length: N }, (_, i) => { const t = i / FS; let v = a() + b(); for (const bt of bursts) { const d = t - bt; if (d > -3 && d < 3) v += amp * Math.sin(2 * Math.PI * 6 * t) * Math.exp(-(d * d) / 2) } return v }) }
  const analyse = (sig, ev) => { const sp = slidingSpectra([sig]), th = bandSeries(sp, 4, 8), { epochs, used } = epochsAround(th, sp.tc, ev), avg = meanEpoch(epochs), band = permutationBand(th, sp.tc, used.length, 10, 10, true, 300, () => rnd() + 0.5); let out = 0; for (let k = 0; k < avg.length; k++) if (avg[k] > band.hi[k] || avg[k] < band.lo[k]) out++; return { avg, out, sp, th } }
  const hit = analyse(mk(presses, 25), presses), none = analyse(mk([], 0), presses)
  ok('planted theta burst is found at the press (0 s)', Math.abs((hit.avg.indexOf(Math.max(...hit.avg)) - 20) * STEP_S) <= 1.0 && hit.out >= 8)
  ok('no burst → almost nothing outside the random-times band', none.out <= 6, `(${none.out}/41)`)
  const r = epochsAround(hit.th, hit.sp.tc, [3, 9, 120, 232, 238])
  ok('presses near the block edges are skipped', r.used.length === 1 && r.skipped.length === 4)
}

console.log('--- sample clock (clock.js)')
{
  const c = new SampleClock(); let now = 1_000_000; const t = []
  const feed = (idxs) => { for (const p of idxs) { for (let k = 0; k < 12; k++) t.push(c.stamp(p % 65536, now)); now += 47 } }
  feed([65530, 65531, 65532, 65533, 65534, 65535, 0, 1])
  ok('uniform 3.906 ms steps, including across the 16-bit counter wrap', near(t[12 * 6] - t[12 * 6 - 1], 1000 / 256, 0.001))
  now += 3 * 47                                                        // the wall-clock time the 3 lost packets would have taken
  feed([5]); ok('dropped packets leave a gap and are counted', c.lostPackets === 3 && c.gaps.some((g) => g.kind === 'lost_packets'))
  const last = t[t.length - 1]; now += 6000; c.newStream(); const t2 = [c.stamp(0, now)]
  ok('a 6 s outage becomes an explicit 6 s gap (not packet loss)', near(t2[0] - last, 6000, 100) && c.gaps.some((g) => g.kind === 'reconnect' && near(g.end - g.start, 6000, 100)))
  ok('timestamps never go backwards', t.every((v, i) => i === 0 || v > t[i - 1]))
}

console.log('--- behavioral tasks (behavior.js)')
{
  const t = makeFlankerTrials(60), cnt = (f) => t.filter(f).length
  ok('60 trials, half congruent, directions balanced', cnt((x) => x.congruency === 'congruent') === 30 && ['congruent', 'incongruent'].every((c) => cnt((x) => x.congruency === c && x.target === 'left') === 15))
  ok('stimuli match their definition', t.every((x) => { const s = [...x.stimulus], mid = s[2]; return (mid === '←') === (x.target === 'left') && (x.congruency === 'congruent' ? s.every((c) => c === mid) : s[0] === s[1] && s[3] === s[4] && s[0] !== mid) }))
  const st = Array.from({ length: 4000 }, () => makeStroopTrial()); ok('Stroop ≈ 75% incongruent', near(st.filter((x) => x.congruency === 'incongruent').length / st.length, 0.75, 0.03))
  const mk = (congruency, correct, rt, timeout = false) => ({ congruency, correct, rt_ms: timeout ? '' : rt, timeout })
  const z = summarize([mk('congruent', true, 400), mk('congruent', true, 440), mk('congruent', true, 420), mk('congruent', false, 300), mk('incongruent', true, 500), mk('incongruent', true, 560), mk('incongruent', true, 540), mk('incongruent', false, 800), mk('incongruent', false, '', true)])
  ok('mean RT uses correct trials only', z.congruent.meanRt === 420 && near(z.incongruent.meanRt, 533.333, 0.01))
  ok('counts: correct / errors / no answer', z.congruent.correct === 3 && z.congruent.errors === 1 && z.incongruent.omissions === 1)
  ok('median, SD, SE', z.congruent.medianRt === 420 && near(z.congruent.sdRt, 20, 1e-9) && near(z.congruent.seRt, 20 / Math.sqrt(3), 1e-9))
  ok('accuracy excludes no-answer trials', near(z.incongruent.accuracy, 3 / 4, 1e-9) && near(z.all.accuracy, 6 / 8, 1e-9))
  ok('interference = incongruent − congruent, with combined SE', near(z.effect, 533.333 - 420, 0.01) && z.effectSe > 0)
  ok('empty input does not crash', summarize([]).all.meanRt === null && summarize([]).effect === null)
  ok('CSV quotes commas', trialsToCsv([{ participant: 'A,B', rt_ms: 410.2, timeout: false }]).split('\n')[1].startsWith('"A,B"'))
  ok('shuffle keeps all items', shuffle([1, 2, 3, 4, 5]).sort().join() === '1,2,3,4,5')
}

console.log('--- connection manager (link.js) with the simulated headset')
{
  BACKOFF_MS.splice(0, BACKOFF_MS.length, 300, 300, 300)            // keep the test short
  let subs = [], samples = 0, streams = 0, states = []
  const link = new MuseLink({ wantPpg: () => false, onState: (s, i) => states.push(s), onStream: (c) => { subs.forEach((s) => s.unsubscribe()); subs = []; streams++; subs.push(zipSamples(c.eegReadings).subscribe(() => { samples++; link.touch() })) } })
  link.maxAttempts = 3
  const rate = async (ms = 1000) => { const a = samples; await sleep(ms); return Math.round(((samples - a) * 1000) / ms) }
  await link.connect(true); await sleep(1200)
  ok('connects and streams ≈ 256 Hz', link.state === 'streaming' && near(await rate(), 256, 40))
  states = []; link.client.dropLink(); await sleep(1500)
  ok('link drop → automatic reconnect', link.state === 'streaming' && states.includes('reconnecting'))
  const r1 = await rate(); ok('no duplicated subscriptions after reconnect (rate ≈ 256, not 512)', r1 < 320, `(${r1}/s, ${streams} stream attachments)`)
  states = []; link.client.stall(8000, true); await sleep(4200)
  ok('soft stall detected and revived by resume', states.includes('stalled') && link.state === 'streaming')
  states = []; link.client.stall(60000, false); await sleep(9500)
  ok('hard stall → full reconnect', states.includes('stalled') && states.includes('reconnecting') && link.state === 'streaming')
  states = []; SimulatedMuse.failNext = 99; link.client.dropLink(); await sleep(2500)
  ok('attempts exhausted → lost', link.state === 'lost')
  SimulatedMuse.failNext = 0; const res = await link.reconnect(); await sleep(600)
  ok('manual Reconnect recovers from lost', res.ok && link.state === 'streaming')
  link.userDisconnect(); await sleep(300); const before = samples; await sleep(600)
  ok('user disconnect stops the stream and never auto-reconnects', link.state === 'idle' && samples === before)
  clearInterval(link._wd)
}

console.log('--- project (project.js)')
{
  const mk = (c, rt) => ({ congruency: c, correct: true, rt_ms: rt, timeout: false })
  const pre = [...[400, 410, 420, 430].map((r) => mk('congruent', r)), ...[500, 510, 520, 530].map((r) => mk('incongruent', r))]
  const post = pre.map((t) => ({ ...t, rt_ms: t.rt_ms - 50 }))
  const c = compare(pre, post, 'Flanker interference')
  ok('compare: RT change is -50 ms', near(c.rows[1].delta, -50, 1e-9) && c.rows[1].dir === 'down')
  ok('compare: unchanged interference is "same"', c.rows[0].dir === 'same')
  ok('compare: no post data gives null deltas', compare(pre, [], 'x').rows[1].delta === null)
  ok('post task is always the pre task (one task field)', Object.keys(PJ_TASKS).includes('flanker') && 'imagery' in PJ_IVS)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
