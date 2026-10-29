# PSYC 20N · Lab 6 — My Project

**Open this link (Chrome):** https://bdl.stanford.edu/muse-web/?week=6
Everything runs in your browser; nothing is uploaded. The Muse is **optional** — without it you get the behavioral data; with it, each phase is also recorded as an EEG block.

## The design
**Task → intervention → the same task again.** The task after the intervention is always the same as the one before, so the two can be compared.

1. Pick a **task**: arrow (Flanker), Stroop, eyes-closed rest, focused-attention or open-monitoring meditation. Set the number of trials (or seconds). There are no limits.
2. Pick an **intervention** and its length in minutes: guided imagery (picture yourself succeeding at something you are good at, like an athlete before an event), meditation, slow breathing, exercise, Stroop training or quiet rest.
3. Enter the participant's **initials** and your **group**, and — if you like — write your **prediction** first.
4. Press **Start run**. Run **several participants**: after each run press **Run another participant**; all runs collect in the table.
5. **Download all runs (.zip)**: one folder per run (`protocol.json`, `events.csv`, `task_trials.csv`, `summary.csv`) plus the EEG folder if the Muse was streaming.

## To use the Muse
Click **Explore EEG**, connect and check the contacts, then return to **My Project**. Keep the headset on for the whole session; blocks are labelled `R1 pre`, `R1 intervention`, `R1 post`, … Behavior-to-EEG alignment is good to roughly 10–30 ms.

## Think about it
Practice, tiredness and boredom can change the second test. What control would tell you? One participant is not a result — what does your group's table show?

## Option B: watch clips and rate them
Choose **Project type → Watch clips → rate each**. Add video files from this computer (download them beforehand; nothing is uploaded or streamed). Set the length of the fixation cross shown before each clip (the EEG baseline) and whether the order is random for each participant. Each participant sees: cross → clip → ratings (valence, arousal, engagement, 1–9, plus an optional note), for every clip. Results show a clip × ratings × EEG table (alpha power, and alpha/theta/beta change relative to the cross before the clip). Clips differ in more than emotion (brightness, motion, sound, length), so compare cautiously. The zip adds `stimuli.csv` and `ratings.csv` per run.
