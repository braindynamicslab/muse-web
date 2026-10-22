# If the Muse disconnects

You do **not** need to refresh the page. Your recording is kept in the page and also saved automatically on this computer.

## What the page does for you
- If the headband drops or stops sending data, a banner appears: **“Headset disconnected — reconnecting…”**. The app tries to reconnect by itself for about 35 seconds. Your recording so far is safe, and any running block keeps going (the missing time is marked in your data).
- If it can't reconnect, the banner turns red: **“Could not reconnect automatically.”** Turn the Muse **off and on**, keep it close to the laptop, then press **Reconnect**. (You may need to pick the headband again.)
- Press **Download what I have so far** at any time to save a partial recording.
- If you refresh or close the tab by mistake, reopen the page: it offers to **download the unfinished recording** (autosaved about every 5 seconds).

## Things that usually cause drops
1. **Low battery** — check the 🔋 reading in the header; charge before the lab.
2. **Distance or body in the way** — keep the laptop within a couple of metres, line of sight if you can.
3. **Crowded 2.4 GHz air** — several headsets and laptops in one room; give each group some space.
4. **Another app holding the headband** — close Mind Monitor, the Muse phone app, and other browser tabs using Bluetooth.
5. **Refreshing the page** — the headband can stay “busy” for up to a minute; if it won't connect, turn it off and on.
6. **The Pulse layer** adds Bluetooth load. It is off by default; only turn it on (before connecting) if you need it.

## Is data missing?
Your downloaded zip contains `gaps.csv` (every interval with no EEG: start, end, duration), `connection_log.csv` (what happened and when) and `diagnostics.txt` (browser and headband info). Please keep these — they help us find out why drops happen. If a drop happens to you, tell your instructor the **time** and what you were doing.

## For instructors
- Test of a real reconnect needs a physical Muse; Practice mode only exercises the logic. Try: connect, record a block, walk the headband out of range for ~10 s, bring it back, and check the banner, the gap in `gaps.csv`, and that the block continues.
- Add `?debug=1` to the URL in Practice mode (`&sim=auto`) to simulate drops from the console: `__link.client.dropLink()` and `__link.client.stall(8000, true)`.
