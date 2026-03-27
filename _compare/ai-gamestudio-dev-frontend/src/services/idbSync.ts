import { StorageFactory } from './settingsStorage'
import {
  idbPutSession,
  idbDeleteSession,
  idbPutMessage,
  idbPutScene,
  idbPutCharacter,
  idbPutEvent,
} from './localDb'

let _persistentCache: boolean | null = null

async function isPersistent(): Promise<boolean> {
  if (_persistentCache !== null) return _persistentCache
  _persistentCache = await StorageFactory.isStoragePersistent()
  return _persistentCache
}

type R = Record<string, unknown>

const dispatchers = {
  session: (r: R) => idbPutSession(r),
  deleteSession: (r: R) => idbDeleteSession(r.id as string),
  message: (r: R) => idbPutMessage(r),
  scene: (r: R) => idbPutScene(r),
  character: (r: R) => idbPutCharacter(r),
  event: (r: R) => idbPutEvent(r),
} as const

export type IdbSyncType = keyof typeof dispatchers

export async function syncToIdb<T>(type: IdbSyncType, record: T): Promise<void> {
  if (await isPersistent()) return
  await dispatchers[type](record as unknown as R)
}

export function syncToIdbFireAndForget<T>(type: IdbSyncType, record: T): void {
  syncToIdb(type, record).catch((err) => console.warn('[idbSync]', type, err))
}
