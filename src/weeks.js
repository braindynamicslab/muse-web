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

WEEKS[4] = {
  title: 'Week 4 · Meditation and the mind',
  layers: ['bands', 'spectrogram', 'motion'],
  channels: 'all',
  banner: `<p><b>1. Two practices</b> (<i>Guided run → Meditation practices</i>): 1 min rest, then focused attention and open monitoring, 3 min each, in the order you choose.
             Teammates read each script aloud, then stay silent. After each practice the participant rates it.</p>
           <p><b>2. Mind wandering</b> (<i>Guided run → Focused attention + key presses</i>): one 4-minute block; the participant presses the spacebar whenever they <b>notice</b> their mind has wandered.</p>
           <p><b>3. Compare</b>: the <b>Practice results</b> table (alpha at the ears, theta at the forehead, your ratings) and the <b>Mind-wandering windows</b> view (−10 s → press → +10 s, with a random-times control).</p>`,
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

// ---------- Week 4: meditation and the mind ----------
export const SCRIPTS = {
  rest: { title: 'Eyes-closed rest', lines: [
    'Close your eyes gently and sit comfortably.',
    'For the next minute, simply rest.',
    'Let your mind do whatever it does — you don’t need to meditate or control anything.',
    'Stay still.' ] },
  fa: { title: 'Focused attention', lines: [
    'Close your eyes gently and relax, as you would when preparing to sleep.',
    'Keep your attention alert. Don’t strain your eyes, cross them, or look upward.',
    'Rest your inner gaze about eight to ten inches ahead, into the field of darkness in front of you.',
    'Silently repeat any calming word.',
    'Stay still, and watch your inner experience calmly, as though images were arising on a screen.',
    'If you get distracted, gently return to the word and the dark space in front of you.' ] },
  om: { title: 'Open monitoring', lines: [
    'Close your eyes gently and settle into a comfortable, still posture.',
    'Rest your attention in an open, relaxed way, without choosing any one thing to focus on.',
    'Notice whatever arises as it comes: sounds, body sensations, thoughts, feelings, images.',
    'Let each experience appear and pass, without following it, judging it, or trying to change it.',
    'If you notice you have been carried off by a thought, just notice that, and return to open, wide awareness.',
    'Stay alert and curious, like watching clouds cross a wide sky.' ] },
  press: { title: 'Focused attention + key presses', lines: [
    'Close your eyes gently and relax, as you would when preparing to sleep.',
    'Rest your inner gaze about eight to ten inches ahead, into the field of darkness in front of you.',
    'Silently repeat any calming word, and keep your attention on it.',
    'When you NOTICE that your mind has wandered, press the SPACEBAR once — then gently return to the word and the dark space.',
    'Keep one finger resting on the spacebar. Don’t worry about pressing “correctly”; just press when you notice.' ] },
}

export const RATINGS = [
  { id: 'stability', name: 'Stability', q: 'How consistently did you maintain your intended attention?', lo: 'not at all', hi: 'very consistently' },
  { id: 'effort', name: 'Effort', q: 'How much effort was required?', lo: 'effortless', hi: 'a great deal' },
  { id: 'meta', name: 'Meta-awareness', q: 'How aware were you of what your mind was doing?', lo: 'not at all', hi: 'very aware' },
  { id: 'sleepy', name: 'Sleepiness', q: 'How sleepy did you feel?', lo: 'wide awake', hi: 'about to fall asleep' },
]
