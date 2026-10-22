// Muse connection manager.
//
// Why this exists: with plain muse-js, any Bluetooth drop meant clicking Connect again (a new device picker) and our
// old Connect path wiped the recording. This module keeps the *link* (Bluetooth connection + data streams) separate
// from the *recording* (owned by main.js): it detects drops and silent stalls, reconnects without the picker where
// the browser allows, never touches recorded data, and keeps a small diagnostic log.
//
// States: idle → connecting → streaming ⇄ stalled → reconnecting → streaming | lost
//   idle          nothing connected (initial, or the user pressed Disconnect)
//   connecting    first connection (device picker / GATT / start commands)
//   streaming     EEG samples are arriving
//   stalled       link looks up but no EEG sample for STALL_MS; we try a soft "resume", then a full reconnect
//   reconnecting  link dropped; automatic attempts with backoff (no picker needed: we hold the BluetoothDevice)
//   lost          automatic attempts exhausted; waiting for the student to press Reconnect (user gesture)
//
// What needs a real headset to prove: that device.gatt.connect() succeeds after a real drop, that a stalled real
// stream is revived by resume(), and how the Muse behaves after a page refresh. Practice mode (SimulatedMuse
// dropLink()/stall()) exercises the logic around those calls.

import { MuseClient } from 'muse-js'
import SimulatedMuse from './sim.js'

export const STALL_MS = 2500          // no EEG sample for this long → stalled
export const STALL_GIVEUP_MS = 5000   // still stalled after a soft resume for this long → full reconnect
export const BACKOFF_MS = [500, 1000, 2000, 3000, 5000, 8000, 8000, 8000]   // ≈ 35 s of automatic attempts
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class MuseLink {
  /** hooks: wantPpg(), onState(state, info), onStream(client, {first, reconnect}), onLog(entry) */
  constructor(hooks) {
    this.h = hooks
    this.state = 'idle'
    this.client = null
    this.device = null            // BluetoothDevice (real headset), kept so we can reconnect without the picker
    this.simulate = false
    this.log = []                 // ring buffer of {t, msg, ...}
    this.attempt = 0
    this.maxAttempts = BACKOFF_MS.length
    this.since = Date.now()
    this.deviceInfo = null
    this.preset = ''
    this._epoch = 0               // bumped to cancel an in-flight recovery loop
    this._statusSub = null
    this._lastSample = 0
    this._stalledAt = 0
    this._busy = false
    this._wd = setInterval(() => this._watchdog(), 500)
  }

  get busy() { return this._busy }
  get streaming() { return this.state === 'streaming' || this.state === 'stalled' }

  _log(msg, extra = {}) {
    const e = { t: Date.now(), state: this.state, msg, ...extra }
    this.log.push(e); if (this.log.length > 800) this.log.shift()
    this.h.onLog?.(e)
  }
  _set(state, info = {}) {
    if (this.state === state) return
    const prev = this.state
    this.state = state; this.since = Date.now()
    this._log(`${prev} → ${state}`, info)
    this.h.onState?.(state, info)
  }

  /** Called by main.js for every EEG sample — this is the heartbeat the stall watchdog looks at. */
  touch() {
    this._lastSample = performance.now()
    if (this.state === 'stalled') this._set('streaming', { recoveredFrom: 'stall' })
  }

  _makeClient() {
    const c = this.simulate ? new SimulatedMuse() : new MuseClient()
    c.enablePpg = !!this.h.wantPpg?.()          // PPG adds Bluetooth load; only request it when the Pulse layer is on
    return c
  }

  /** First connection. For a real headset this opens the device picker, so call it from a click. */
  async connect(simulate) {
    if (this._busy) return
    this._busy = true; this.simulate = !!simulate; this._epoch++
    this._set('connecting')
    try {
      const c = this._makeClient()
      await c.connect()                                 // real: requestDevice() → picker; throws if cancelled
      if (!this.simulate) this.device = c.gatt?.device || this.device
      await this._start(c)
      this._attach(c, { first: true })
      this._set('streaming')
    } catch (err) {
      this._log('connect failed', { error: String(err?.message || err) })
      this._set('idle', { error: String(err?.message || err) })
      throw err
    } finally { this._busy = false }
  }

  async _start(c) {
    this.preset = c.enablePpg ? 'EEG+motion+PPG (p50)' : 'EEG+motion (p21)'
    await c.start()
    try { this.deviceInfo = await c.deviceInfo?.() } catch { /* best effort */ }
    this._log('started', { name: c.deviceName, preset: this.preset, fw: this.deviceInfo?.fw, hw: this.deviceInfo?.hw })
  }

  /** Make `c` the active client: swap the status listener and let main.js (re)subscribe to its streams. */
  _attach(c, info) {
    this._statusSub?.unsubscribe()
    const old = this.client; this.client = c
    if (old && old !== c) { try { old.disconnect() } catch { /* already gone */ } }
    this._statusSub = c.connectionStatus.subscribe((up) => { if (!up && this.client === c) this._onDropped('link') })
    this._lastSample = performance.now(); this._stalledAt = 0; this.attempt = 0
    this.h.onStream?.(c, info)
  }

  _onDropped(reason) {
    if (this.state !== 'streaming' && this.state !== 'stalled') return
    this._log('link dropped', { reason })
    this._set('reconnecting', { reason })
    this._recover(++this._epoch)
  }

  async _recover(epoch) {
    for (let i = 0; i < BACKOFF_MS.length; i++) {
      await sleep(BACKOFF_MS[i])
      if (epoch !== this._epoch || this.state !== 'reconnecting') return
      this.attempt = i + 1
      this._log(`reconnect attempt ${this.attempt}/${this.maxAttempts}`)
      this.h.onState?.('reconnecting', { attempt: this.attempt })
      try { await this._reopen(); return } catch (err) { this._log('attempt failed', { error: String(err?.message || err) }) }
    }
    if (epoch === this._epoch && this.state === 'reconnecting') this._set('lost', { reason: 'attempts exhausted' })
  }

  /** Reconnect to the same headset without the picker (needs the BluetoothDevice we kept). */
  async _reopen() {
    let c
    if (this.simulate) { c = this._makeClient(); await c.connect() }
    else {
      if (!this.device) throw new Error('no device handle (page was reloaded) — use Reconnect to pick the headset again')
      const gatt = await this.device.gatt.connect()
      c = this._makeClient(); await c.connect(gatt)
    }
    await this._start(c)
    this._attach(c, { reconnect: true })
    this._set('streaming', { recovered: true })
  }

  _watchdog() {
    if (this.state !== 'streaming' && this.state !== 'stalled') return
    const quiet = performance.now() - this._lastSample
    if (this.state === 'streaming' && quiet > STALL_MS) {
      this._stalledAt = performance.now()
      this._set('stalled', { quietMs: Math.round(quiet) })
      Promise.resolve(this.client?.resume?.()).then(() => this._log('sent resume command')).catch((e) => this._log('resume failed', { error: String(e?.message || e) }))
    } else if (this.state === 'stalled' && performance.now() - this._stalledAt > STALL_GIVEUP_MS) {
      this._log('stall did not clear → full reconnect')
      try { if (!this.simulate) this.device?.gatt?.disconnect(); else this.client?.disconnect() } catch { /* ignore */ }
      this._onDropped('stall')
    }
  }

  /** Reconnect button (user gesture). Tries the saved device first; if that is impossible, opens the picker. */
  async reconnect() {
    if (this._busy) return { ok: false, error: 'busy' }
    this._busy = true; this._epoch++                      // cancels any automatic loop
    const was = this.state
    this._log('manual reconnect', { from: was })
    if (this.state !== 'reconnecting') this.state = 'reconnecting', this.h.onState?.('reconnecting', { manual: true })
    try {
      try { await this._reopen() }
      catch (err) {
        this._log('saved-device reconnect failed', { error: String(err?.message || err) })
        if (this.simulate) throw err
        const c = this._makeClient(); await c.connect()   // picker
        this.device = c.gatt?.device || this.device
        await this._start(c); this._attach(c, { reconnect: true }); this._set('streaming', { recovered: true, viaPicker: true })
      }
      return { ok: true }
    } catch (err) {
      this._set('lost', { error: String(err?.message || err) })
      return { ok: false, error: String(err?.message || err) }
    } finally { this._busy = false }
  }

  /** Disconnect button: the user is done with the headset. Data stays in the app. */
  userDisconnect() {
    this._epoch++
    this._log('user disconnect')
    try { this.client?.disconnect() } catch { /* ignore */ }
    this._statusSub?.unsubscribe(); this._statusSub = null
    this._set('idle', { user: true })
  }

  /** Page is closing: free the headset so a refreshed page can connect immediately. */
  shutdown() {
    try { this.client?.disconnect() } catch { /* ignore */ }
    try { this.device?.gatt?.disconnect() } catch { /* ignore */ }
  }

  /** Summary for the diagnostics file. */
  diagnostics() {
    return {
      userAgent: navigator.userAgent, platform: navigator.platform, webBluetooth: !!navigator.bluetooth,
      simulated: this.simulate, state: this.state, preset: this.preset, deviceName: this.client?.deviceName || '',
      firmware: this.deviceInfo?.fw || '', hardware: this.deviceInfo?.hw || '',
    }
  }
}
