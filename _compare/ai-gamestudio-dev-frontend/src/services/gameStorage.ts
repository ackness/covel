/**
 * gameStorage.ts — Routing layer for game data reads.
 *
 * In persistent mode (non-Vercel): delegates to the backend API.
 * In non-persistent mode (Vercel + ephemeral SQLite): reads from IndexedDB,
 * which is kept up-to-date by fire-and-forget writes in the store setters.
 */

import { StorageFactory } from './settingsStorage'
import * as api from './api'
import {
  idbGetMessages,
  idbGetCharacters,
  idbGetScenes,
  idbGetEvents,
} from './localDb'
import type { Message, Character, Scene, GameEvent } from '../types'
import { validateIdbRows } from '../utils/idbValidation'

export async function fetchMessages(sessionId: string): Promise<Message[]> {
  const persistent = await StorageFactory.isStoragePersistent()
  if (!persistent) {
    const rows = await idbGetMessages(sessionId)
    return validateIdbRows<Message>(rows, ['id', 'role', 'content'])
  }
  return api.getMessages(sessionId)
}

export async function fetchCharacters(sessionId: string): Promise<Character[]> {
  const persistent = await StorageFactory.isStoragePersistent()
  if (!persistent) {
    const rows = await idbGetCharacters(sessionId)
    return validateIdbRows<Character>(rows, ['id', 'name'])
  }
  return api.getCharacters(sessionId)
}

export async function fetchScenes(sessionId: string): Promise<Scene[]> {
  const persistent = await StorageFactory.isStoragePersistent()
  if (!persistent) {
    const rows = await idbGetScenes(sessionId)
    return validateIdbRows<Scene>(rows, ['id', 'name'])
  }
  return api.getScenes(sessionId)
}

export async function fetchEvents(sessionId: string): Promise<GameEvent[]> {
  const persistent = await StorageFactory.isStoragePersistent()
  if (!persistent) {
    const rows = await idbGetEvents(sessionId)
    return validateIdbRows<GameEvent>(rows, ['id', 'type'])
  }
  return api.getEvents(sessionId)
}
