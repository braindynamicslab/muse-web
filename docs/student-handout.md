# PSYC 20N · Lab 2 — Your first brain recording

**App:** https://bdl.stanford.edu/muse-web/ (open in **Google Chrome** — Safari and Firefox will not work)
**Groups:** 3 per Muse. **One laptop** connects to the headband; the others watch that screen. Rotate who wears it.

## Roles (rotate every block)
| Role | Job |
|---|---|
| **Wearer** | Wears the Muse, sits still, does the condition |
| **Driver** | Runs the laptop: Connect, Start, Stop |
| **Observer** | Watches the signal, calls out artifacts (blinks, jaw tension, movement), writes notes |

---

## Part 1 · Setup and fit (15 min)

**Hygiene first.** Wipe the sensors (forehead and behind-ear rubber/fabric) with the alcohol wipe, let them dry, and wipe again before the next person puts it on. Wearers: clean skin, no lotion on the forehead. Don't wear it over cuts or irritated skin, and take it off if it's uncomfortable. The Muse is a consumer device — it is **not** a medical device and tells you nothing about health or diagnosis.

**Put it on.**
1. Sit on the headband so it rests across the **bare forehead** (push hair away from the two forehead sensors) with the **ear sensors tucked behind the ears**, touching skin. Slightly damp ear sensors work better.
2. Press the Muse's power button until it lights up. Close any other Muse apps (phone, Mind Monitor) — only one program can hold the connection.
3. On the laptop, open the app in Chrome and click **Connect Muse**. Pick your headband (`Muse-XXXX`) in the popup. No headband handy? Click **Practice** for a simulated one.

**Check contact.** Four dots show the sensors: **green = good, yellow = OK, red = poor**. Hover over a dot for the numbers, and read the hint under the traces. Fix red/yellow dots by moving hair, pressing the band snug, or wetting the ear sensors. Wait for **all green** and sit still.

> Tip: the **battery** shows in the header. If it's below ~20%, ask for another headband.

---

## Part 2 · First recording (15 min)

Everyone should end up with a recognizable EEG trace. Use **Start/Stop** in the *Experiment* box (pick a condition → ▶ **Start** → ■ **Stop**). Do each for about **15–20 s**, with the wearer otherwise still:

1. **Blink** — big spikes on the two forehead channels (AF7, AF8), small on the ears.
2. **Jaw clench** — a burst of fast, fuzzy activity on every channel. This is *muscle*, not brain.
3. **Eyes open → eyes closed** — watch the **alpha** band rise when the eyes close (8–13 Hz). Turn on **Spectrogram** under *Show:* and look for a brighter stripe between the dashed lines.

Write down what each looked like. *Which channels showed it first? Which were quietest?*

**Band power** is empty for the first ~15 s after connecting — the app is learning your baseline. That's normal. Bands show each rhythm's **share** of the total (they add to 100%), so a band "rising" means it gained power relative to the others.

---

## Part 3 · Your experiment (30 min)

Each group changes **one variable** and looks at what happens to the EEG. Your instructor will assign yours, or choose from:

- Eyes open vs. eyes closed
- Resting vs. mental arithmetic (e.g. count backwards from 500 by 7)
- Silence vs. music
- Still vs. head movement / jaw clench (artifact comparison)
- **Split tab:** put a **PsyToolkit** attention task or a **YouTube** video next to the app (Chrome: right-click the tab → *Add tab to new split view*). Press **Start** when the task/video begins, **Stop** when it ends. *The app can't see your task — you mark the timing yourself.*

**Good design (do these):**
- Run a **reference condition first** (e.g. eyes open, quiet). The app compares everything to it.
- Make blocks the **same length** — at least **60 s**, the longer the better. The first 2 s of each block are ignored.
- Stay still in every block except the one where movement *is* the variable.
- **Repeat** each condition at least twice, alternating (A, B, A, B).
- Keep all four dots green; if one turns red, note the time and fix it before continuing.

**Read your result.**
- **Band power** panel: lines show each band over the last 60 s, shaded boxes are your blocks.
- **Power** menu: *Relative* shows each band's share of the total (adds to 100%). *Absolute* shows real power in dB — a better way to see "alpha went up" when other bands move too (+3 dB ≈ twice the power).
- **Channels** menu: *Best contact (auto)* leaves out sensors with poor contact. *Back of head (TP9 + TP10)* is where alpha is strongest, but only trust it when those two dots are green. A warning appears if a sensor you're using has poor contact.
- The **table** under *Experiment* shows the average share per condition and the **change vs. your first condition**.
- **Compare two conditions:** pick A (reference) and B. The top shows each average spectrum; the bars show **B − A in dB** (3 dB ≈ twice the power). Look at the shaded **alpha** zone.

**Save your data.** Click **Download data (.zip)** before closing the tab — refreshing the page erases everything. Name the folder `group#_variable`. [Instructor: say where to upload/share the file.]

---

## Part 4 · Debrief questions
1. What changed in the EEG between your two conditions? Which band, which channels?
2. Could movement, blinks, or jaw tension explain it instead of the brain? How would you tell? (Check the **Head motion** layer.)
3. If a classmate repeated your experiment, would they get the same result? What would you control better?
4. Four sensors on the forehead and behind the ears — what part of the brain can this *not* see?
5. Looking ahead: if you could feed one band back to the wearer in real time, what would you train, and how would you know it worked?

---

## Troubleshooting
| Problem | Fix |
|---|---|
| No Muse in the Bluetooth popup | Muse on and blinking? Bluetooth on? Quit other apps using it. Refresh and retry. |
| "Could not connect" | Turn the Muse off and on, refresh the page, try again. |
| Dots stay yellow/red | Move hair, snug the band, wet the ear sensors, relax jaw and face, sit still. |
| Band power empty | Wait ~15 s after connecting. |
| Traces flat or huge | Check fit; try the scale menu (±100 / ±200 µV). |
| Page stuck | Refresh — but you'll lose unsaved data, so download first. |
| Nothing works | Click **Practice** and keep going; sort the headband out between blocks. |

**Privacy:** the app runs entirely in your browser. Nothing is uploaded; your data exists only in the tab and in the .zip you download.
