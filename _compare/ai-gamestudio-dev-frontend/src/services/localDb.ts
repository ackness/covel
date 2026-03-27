/**
 * localDb.ts — IndexedDB wrapper for offline / ephemeral-backend mode.
 *
 * Used when StorageFactory detects that the backend storage is not persistent
 * (e.g. Vercel + SQLite in /tmp). All game data is stored locally in the
 * browser so the user does not lose their work within a single browser session.
 *
 * Schema v2
 * ─────────
 *   projects          keyPath: id
 *   sessions          keyPath: id,  index: project_id
 *   messages          keyPath: id,  index: session_id
 *   characters        keyPath: id,  index: session_id          (legacy, kept for compat)
 *   scenes            keyPath: id,  index: session_id          (legacy, kept for compat)
 *   events            keyPath: id,  index: session_id          (legacy, kept for compat)
 *   plugin_state      keyPath: [project_id, plugin_name]       (enabled flags)
 *   runtime_settings  keyPath: [project_id, scope_key]
 *   storage_kv        keyPath: [scope, ns, collection, key]    (v2)
 *   storage_log       autoIncrement, index: [scope, ns, collection]  (v2)
 *   storage_graph     keyPath: [scope, ns, from_id, to_id, relation] (v2)
 */

const DB_NAME = 'ai-gamestudio'
const DB_VERSION = 2

let _db: IDBDatabase | null = null

/** Shared DB opener — also used by IdbStorageAdapter. */
export function openDb(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)

    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result

      // ── v1 stores ──
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const s = db.createObjectStore('sessions', { keyPath: 'id' })
        s.createIndex('project_id', 'project_id', { unique: false })
      }
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' })
        s.createIndex('session_id', 'session_id', { unique: false })
      }
      if (!db.objectStoreNames.contains('characters')) {
        const s = db.createObjectStore('characters', { keyPath: 'id' })
        s.createIndex('session_id', 'session_id', { unique: false })
      }
      if (!db.objectStoreNames.contains('scenes')) {
        const s = db.createObjectStore('scenes', { keyPath: 'id' })
        s.createIndex('session_id', 'session_id', { unique: false })
      }
      if (!db.objectStoreNames.contains('events')) {
        const s = db.createObjectStore('events', { keyPath: 'id' })
        s.createIndex('session_id', 'session_id', { unique: false })
      }
      if (!db.objectStoreNames.contains('plugin_state')) {
        db.createObjectStore('plugin_state', { keyPath: ['project_id', 'plugin_name'] })
      }
      if (!db.objectStoreNames.contains('runtime_settings')) {
        db.createObjectStore('runtime_settings', { keyPath: ['project_id', 'scope_key'] })
      }

      // ── v2: unified storage stores ──
      if (!db.objectStoreNames.contains('storage_kv')) {
        const kv = db.createObjectStore('storage_kv', {
          keyPath: ['scope', 'ns', 'collection', 'key'],
        })
        kv.createIndex('by_collection', ['scope', 'ns', 'collection'], { unique: false })
      }
      if (!db.objectStoreNames.contains('storage_log')) {
        const log = db.createObjectStore('storage_log', { autoIncrement: true })
        log.createIndex('by_collection', ['scope', 'ns', 'collection'], { unique: false })
      }
      if (!db.objectStoreNames.contains('storage_graph')) {
        db.createObjectStore('storage_graph', {
          keyPath: ['scope', 'ns', 'from_id', 'to_id', 'relation'],
        })
      }
    }

    req.onsuccess = (e) => {
      _db = (e.target as IDBOpenDBRequest).result
      resolve(_db)
    }
    req.onerror = () => reject(req.error)
  })
}

// ─── Generic helpers ──────────────────────────────────────────────────────────

function tx(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode = 'readonly',
): IDBTransaction {
  return db.transaction(stores, mode)
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function getAll<T>(store: IDBObjectStore, indexName?: string, query?: IDBValidKey): Promise<T[]> {
  const source = indexName ? store.index(indexName) : store
  return promisify<T[]>(source.getAll(query))
}

// ─── Projects ─────────────────────────────────────────────────────────────────

export async function idbGetProjects() {
  const db = await openDb()
  const store = tx(db, 'projects').objectStore('projects')
  const all = await getAll<Record<string, unknown>>(store)
  return all.sort((a, b) =>
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
  )
}

export async function idbGetProject(id: string) {
  const db = await openDb()
  return promisify<Record<string, unknown> | undefined>(
    tx(db, 'projects').objectStore('projects').get(id),
  )
}

export async function idbPutProject(project: Record<string, unknown>) {
  const db = await openDb()
  return promisify(tx(db, 'projects', 'readwrite').objectStore('projects').put(project))
}

export async function idbDeleteProject(id: string) {
  const db = await openDb()
  return promisify(tx(db, 'projects', 'readwrite').objectStore('projects').delete(id))
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function idbGetSessions(projectId: string) {
  const db = await openDb()
  const store = tx(db, 'sessions').objectStore('sessions')
  const all = await getAll<Record<string, unknown>>(store, 'project_id', projectId)
  return all.sort((a, b) =>
    String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
  )
}

export async function idbGetSession(id: string) {
  const db = await openDb()
  return promisify<Record<string, unknown> | undefined>(
    tx(db, 'sessions').objectStore('sessions').get(id),
  )
}

export async function idbPutSession(session: Record<string, unknown>) {
  const db = await openDb()
  return promisify(tx(db, 'sessions', 'readwrite').objectStore('sessions').put(session))
}

export async function idbDeleteSession(id: string) {
  const db = await openDb()
  // cascade delete messages, characters, scenes, events
  const t = db.transaction(['sessions', 'messages', 'characters', 'scenes', 'events'], 'readwrite')
  const cascade = async (storeName: string) => {
    const store = t.objectStore(storeName)
    const ids = await promisify<IDBValidKey[]>(store.index('session_id').getAllKeys(id))
    for (const key of ids) store.delete(key)
  }
  await Promise.all(['messages', 'characters', 'scenes', 'events'].map(cascade))
  t.objectStore('sessions').delete(id)
  return new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}

// ─── Messages ─────────────────────────────────────────────────────────────────

export async function idbGetMessages(sessionId: string) {
  const db = await openDb()
  const store = tx(db, 'messages').objectStore('messages')
  const all = await getAll<Record<string, unknown>>(store, 'session_id', sessionId)
  return all.sort((a, b) =>
    String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')),
  )
}

export async function idbPutMessage(message: Record<string, unknown>) {
  const db = await openDb()
  return promisify(tx(db, 'messages', 'readwrite').objectStore('messages').put(message))
}

// ─── Characters ───────────────────────────────────────────────────────────────

export async function idbGetCharacters(sessionId: string) {
  const db = await openDb()
  const store = tx(db, 'characters').objectStore('characters')
  return getAll<Record<string, unknown>>(store, 'session_id', sessionId)
}

export async function idbPutCharacter(character: Record<string, unknown>) {
  const db = await openDb()
  return promisify(tx(db, 'characters', 'readwrite').objectStore('characters').put(character))
}

// ─── Scenes ───────────────────────────────────────────────────────────────────

export async function idbGetScenes(sessionId: string) {
  const db = await openDb()
  const store = tx(db, 'scenes').objectStore('scenes')
  return getAll<Record<string, unknown>>(store, 'session_id', sessionId)
}

export async function idbPutScene(scene: Record<string, unknown>) {
  const db = await openDb()
  return promisify(tx(db, 'scenes', 'readwrite').objectStore('scenes').put(scene))
}

// ─── Events ───────────────────────────────────────────────────────────────────

export async function idbGetEvents(sessionId: string) {
  const db = await openDb()
  const store = tx(db, 'events').objectStore('events')
  return getAll<Record<string, unknown>>(store, 'session_id', sessionId)
}

export async function idbPutEvent(event: Record<string, unknown>) {
  const db = await openDb()
  return promisify(tx(db, 'events', 'readwrite').objectStore('events').put(event))
}

// ─── Plugin state ─────────────────────────────────────────────────────────────

export async function idbGetPluginStates(projectId: string): Promise<
  { plugin_name: string; enabled: boolean }[]
> {
  const db = await openDb()
  const store = tx(db, 'plugin_state').objectStore('plugin_state')
  const all = await getAll<{ project_id: string; plugin_name: string; enabled: boolean }>(store)
  return all.filter((r) => r.project_id === projectId)
}

export async function idbSetPluginState(
  projectId: string,
  pluginName: string,
  enabled: boolean,
) {
  const db = await openDb()
  return promisify(
    tx(db, 'plugin_state', 'readwrite')
      .objectStore('plugin_state')
      .put({ project_id: projectId, plugin_name: pluginName, enabled }),
  )
}

// ─── Runtime settings ─────────────────────────────────────────────────────────

export async function idbGetRuntimeSettings(
  projectId: string,
  scopeKey: string,
): Promise<Record<string, unknown>> {
  const db = await openDb()
  const row = await promisify<
    { project_id: string; scope_key: string; values: Record<string, unknown> } | undefined
  >(tx(db, 'runtime_settings').objectStore('runtime_settings').get([projectId, scopeKey]))
  return row?.values ?? {}
}

export async function idbSetRuntimeSettings(
  projectId: string,
  scopeKey: string,
  values: Record<string, unknown>,
) {
  const db = await openDb()
  return promisify(
    tx(db, 'runtime_settings', 'readwrite')
      .objectStore('runtime_settings')
      .put({ project_id: projectId, scope_key: scopeKey, values }),
  )
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/** Close the DB connection — useful in tests. */
export function idbClose() {
  _db?.close()
  _db = null
}

/** Delete the entire database — nuclear option. */
export function idbDrop(): Promise<void> {
  idbClose()
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}
