/**
 * Offline-first IndexedDB cache for API GET responses.
 *
 * Strategy: network-first, cache-fallback.
 *   1. apiFetch tries the network as usual.
 *   2. On success, the JSON response is written here with a timestamp.
 *   3. On network failure (offline, server down, etc.), apiFetch reads
 *      from here instead, so the operator's last-seen data renders
 *      with a stale banner rather than blanking the page out.
 *
 * The cache key is the request URL + a hash of the body (so different
 * POSTs to the same URL don't clobber each other — but in practice we
 * only cache GETs to keep mutation semantics clean).
 *
 * Native IndexedDB API used directly (no `idb` dep) so we don't grow
 * the bundle for one feature. ~150 lines, no runtime cost when online.
 */

const DB_NAME = 'tokenos-portal-cache'
const DB_VERSION = 1
const STORE = 'api-responses'

interface CacheEntry {
  key: string
  data: unknown
  cachedAt: number // ms epoch
}

let dbPromise: Promise<IDBDatabase> | null = null

function isAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (!isAvailable()) {
      reject(new Error('IndexedDB not available'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
  return dbPromise
}

/**
 * Write a successful API response to the cache. Best-effort: any IDB
 * error (private mode, quota exceeded, transient failure) is swallowed
 * so it never interferes with the live request.
 */
export async function putCache(key: string, data: unknown): Promise<void> {
  if (!isAvailable()) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      const entry: CacheEntry = { key, data, cachedAt: Date.now() }
      const req = store.put(entry)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // best-effort cache write
  }
}

/**
 * Read a cached entry. Returns null on miss or any error.
 */
export async function getCache<T = unknown>(key: string): Promise<{ data: T; cachedAt: number } | null> {
  if (!isAvailable()) return null
  try {
    const db = await openDb()
    return await new Promise<{ data: T; cachedAt: number } | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      const req = store.get(key)
      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined
        if (!entry) {
          resolve(null)
          return
        }
        resolve({ data: entry.data as T, cachedAt: entry.cachedAt })
      }
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

/**
 * Drop every entry. Called on explicit logout so a different user
 * doesn't see the previous account's cached data on first load.
 */
export async function clearCache(): Promise<void> {
  if (!isAvailable()) return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // best-effort
  }
}

/**
 * Newest cachedAt across all entries — used for the offline banner's
 * "last synced X ago" sub-label.
 */
export async function newestCachedAt(): Promise<number | null> {
  if (!isAvailable()) return null
  try {
    const db = await openDb()
    return await new Promise<number | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const store = tx.objectStore(STORE)
      let max = 0
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (cursor) {
          const entry = cursor.value as CacheEntry
          if (entry.cachedAt > max) max = entry.cachedAt
          cursor.continue()
        } else {
          resolve(max || null)
        }
      }
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}
