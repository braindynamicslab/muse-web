// Local recording checkpoints in the browser's IndexedDB, so an accidental refresh or crash does not lose a recording.
// Everything stays on this computer: nothing here touches the network. Browser storage is NOT permanent — it can be
// cleared by the browser, by private windows, or by the student — so this is a safety net, never a substitute for
// pressing "Download data (.zip)".
//
// Layout (database "muse-web", version 1):
//   sessions  {id, startedAt, updatedAt, simulated, rows, exportedRows}      one per recording
//   chunks    {sid, seq, kind, n, t, v, cond}                                  append-only raw data, typed arrays
//   state     {sid, json}                                                      blocks, key presses, gaps, labels…

const DB_NAME = 'muse-web', VERSION = 1
let dbp = null

function open() {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'))
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      db.createObjectStore('sessions', { keyPath: 'id' })
      db.createObjectStore('chunks', { keyPath: ['sid', 'kind', 'seq'] })
      db.createObjectStore('state', { keyPath: 'sid' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('IndexedDB blocked'))
  })
  return dbp
}
const tx = (db, stores, mode = 'readonly') => db.transaction(stores, mode)
const done = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error) })
const reqp = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })

export async function available() { try { await open(); return true } catch { return false } }

export async function startSession(meta) {
  const db = await open(); const t = tx(db, ['sessions'], 'readwrite')
  t.objectStore('sessions').put({ ...meta, updatedAt: Date.now(), rows: 0, exportedRows: 0 }); await done(t)
}

/** chunks: [{kind, seq, n, t: Float64Array, v: Float32Array, cond: Int16Array}], state: plain JSON-able object. */
export async function checkpoint(sid, chunks, state, rows) {
  const db = await open(); const t = tx(db, ['sessions', 'chunks', 'state'], 'readwrite')
  for (const c of chunks) t.objectStore('chunks').put({ sid, ...c })
  t.objectStore('state').put({ sid, json: JSON.stringify(state) })
  const s = t.objectStore('sessions'), cur = await reqp(s.get(sid))
  if (cur) s.put({ ...cur, updatedAt: Date.now(), rows })
  await done(t)
}

export async function markExported(sid, rows) {
  const db = await open(); const t = tx(db, ['sessions'], 'readwrite'); const s = t.objectStore('sessions')
  const cur = await reqp(s.get(sid)); if (cur) s.put({ ...cur, exportedRows: rows }); await done(t)
}

export async function listSessions() {
  const db = await open(); const t = tx(db, ['sessions'])
  const all = await reqp(t.objectStore('sessions').getAll())
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function loadSession(sid) {
  const db = await open(); const t = tx(db, ['sessions', 'chunks', 'state'])
  const meta = await reqp(t.objectStore('sessions').get(sid))
  const st = await reqp(t.objectStore('state').get(sid))
  const range = IDBKeyRange.bound([sid, '', 0], [sid, '￿', Infinity])
  const chunks = await reqp(t.objectStore('chunks').getAll(range))
  chunks.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.seq - b.seq))
  return { meta, state: st ? JSON.parse(st.json) : {}, chunks }
}

export async function deleteSession(sid) {
  const db = await open(); const t = tx(db, ['sessions', 'chunks', 'state'], 'readwrite')
  t.objectStore('sessions').delete(sid); t.objectStore('state').delete(sid)
  t.objectStore('chunks').delete(IDBKeyRange.bound([sid, '', 0], [sid, '￿', Infinity])); await done(t)
}

/** Housekeeping: drop sessions older than 14 days, and keep at most the 6 newest. */
export async function prune() {
  const all = await listSessions(), cutoff = Date.now() - 14 * 24 * 3600 * 1000
  for (const [i, s] of all.entries()) if (i >= 6 || s.updatedAt < cutoff) await deleteSession(s.id)
}
