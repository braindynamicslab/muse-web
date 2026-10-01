// Sample clock for the EEG stream.
//
// Why: muse-js's per-packet `timestamp` is built in MuseClient.getTimestamp(), which keeps ONE lastIndex /
// lastTimestamp shared by the EEG and PPG streams. Their packet counters are independent, so with PPG enabled the
// shared state jumps by up to 65536 packets (~51 min) at a time and timestamps run away (we saw 19,492 minutes).
// So we ignore muse-js timestamps and time every sample from the packet counter instead:
//   t = anchor + (samples delivered + samples lost to gaps) / fs
// Gaps are detected from the 16-bit packet `index` (one packet = 12 samples per electrode).

export class SampleClock {
  constructor(fs = 256, samplesPerPacket = 12) { this.fs = fs; this.spp = samplesPerPacket; this.reset() }
  reset() { this.anchor = null; this.n = 0; this.gap = 0; this.lastIdx = null; this.lostPackets = 0 }
  /** Time in ms (epoch-based, uniform at 1/fs) of the next EEG sample, whose packet counter is `index`. */
  stamp(index, nowMs = Date.now()) {
    if (this.anchor === null) this.anchor = nowMs - (this.spp * 1000) / this.fs   // first packet arrived after being sampled
    if (index !== this.lastIdx) {
      if (this.lastIdx !== null) {
        const d = (index - this.lastIdx + 65536) % 65536
        if (d > 1 && d < 4096) { this.gap += (d - 1) * this.spp; this.lostPackets += d - 1 }   // dropped packets leave a gap
        // d >= 4096 means out-of-order / replayed packet: keep the clock running unchanged
      }
      this.lastIdx = index
    }
    return this.anchor + ((this.n++ + this.gap) * 1000) / this.fs
  }
}
