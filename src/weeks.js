// Weekly presets (?week=N) and the Week 3 "brainwave dictionary on trial" claims.
// A preset only controls what is visible and suggested; the plain link (no ?week) is the full free-explore view.

export const WEEKS = {
  2: {
    title: 'Week 2 · Your first brain recording',
    layers: null,                       // null = unlocked (toggles shown), like the plain link
    banner: `<p><b>Goal:</b> get a clean EEG trace, see blinks and jaw tension, and watch alpha rise when your eyes close.</p>
             <p>Pick a condition → <b>Start</b> → <b>Stop</b>. Download your data before you close the tab.</p>`,
  },
  3: {
    title: 'Week 3 · The brainwave dictionary on trial',
    layers: ['bands', 'spectrogram'],
    channels: 'posterior',               // alpha is a back-of-head rhythm: TP9 + TP10 by default
    claims: true,
    banner: `<p><b>1. Find your alpha</b> (everyone): use <b>Guided run → Find your alpha</b>. Three blocks, 45 s each:
               eyes open → eyes closed → eyes open. Teammates watch the big cue at the top and tell the wearer when to switch.
               Then open <b>Spectrum lab</b> and compare TP9 and TP10. Write down your IAF.</p>
             <p><b>2. Does the reference change the answer?</b> (everyone): in <b>Spectrum lab</b>, switch the view to
               <i>Compare references</i> on your eyes-closed block.</p>
             <p><b>3. Put a claim on trial</b> (your group): choose a claim, <b>write your prediction first</b>, then run A–B–A–B.</p>`,
  },
}

export const CLAIMS = [
  { id: 'attention', name: 'Attention — “Beta = busy, active mind”',
    conditions: ['Quiet rest', 'Silent mental arithmetic'], band: 'beta', dir: 'up', channels: 'all',
    tips: 'Keep eyes open and fixed on a spot in both conditions. Do the arithmetic <b>silently</b> (e.g. count down from 500 by 7) — talking or clenching adds muscle noise that looks like beta.' },
  { id: 'memory', name: 'Working memory — “Theta = memory”',
    conditions: ['Hold 1–2 digits', 'Hold 6–7 digits'], band: 'theta', dir: 'up', channels: 'frontal',
    tips: 'Show digits on a timer (slide or PsyToolkit), then keep them in mind silently. Remember: the Muse sits on the forehead, so it cannot measure true frontal-midline theta.' },
  { id: 'meditation', name: 'Meditation — “Alpha = relaxed”',
    conditions: ['Eyes-closed rest', 'Meditation'], band: 'alpha', dir: 'up', channels: 'posterior',
    tips: 'Both conditions have eyes closed, so eye closure alone cannot explain a difference. Alternate (rest, meditation, rest, meditation) so drowsiness over time does not fool you.' },
  { id: 'wandering', name: 'Mind wandering — focused attention vs. rest',
    conditions: ['Focused attention (count breaths)', 'Mind wandering'], band: '', dir: '', channels: 'posterior',
    tips: 'You decide which feature should change — and say why — before you look. There is no behavioural measure, so note after each block whether you lost count.' },
  { id: 'gamma', name: 'Gamma / muscle — “Gamma = concentration”',
    conditions: ['Quiet rest', 'Mental arithmetic', 'Jaw clench'], band: 'hf', dir: 'up', range: 80, channels: 'all',
    tips: 'Compare rest with mental arithmetic, then with a jaw clench. Watch the <b>muscle ratio</b> under the EEG traces and the 40–80 Hz region (the 60 Hz power-line band is greyed out). What does this say about scalp gamma from a Muse?' },
  { id: 'own', name: 'Design your own', conditions: [], band: '', dir: '',
    tips: 'Add your own conditions below. Decide what you expect before you record.' },
]

/** Bin ranges (1 Hz bins, f = 1…80) for each band, used for predictions and the Compare readout. */
export const BAND_BINS = {
  delta: [[1, 3]], theta: [[4, 7]], alpha: [[8, 12]], beta: [[13, 29]], gamma: [[30, 40]],
  hf: [[40, 57], [63, 80]],           // 40–80 Hz with the 58–62 Hz mains band left out
}
export const BAND_NAMES = { delta: 'delta (1–3 Hz)', theta: 'theta (4–7 Hz)', alpha: 'alpha (8–12 Hz)', beta: 'beta (13–29 Hz)', gamma: 'gamma (30–40 Hz)', hf: 'high frequency / muscle (40–80 Hz)' }
