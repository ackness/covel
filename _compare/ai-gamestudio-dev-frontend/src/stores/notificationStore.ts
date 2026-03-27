import { create } from 'zustand'
import type { Message } from '../types'
import {
  normalizeOutputEnvelope,
  resolveBlockData,
  resolveBlockId,
  resolveBlockType,
} from '../services/outputContract.js'

export type NotificationLevel = 'info' | 'warning' | 'success' | 'error'

export interface NotificationItem {
  id: string
  sessionId: string
  level: NotificationLevel
  title: string
  content: string
  createdAt: string
  unread: boolean
  turnId?: string
}

interface NotificationPayload {
  level?: string
  title?: string
  content?: string
}

interface NotificationStore {
  activeSessionId: string | null
  notifications: NotificationItem[]
  resetForSession: (sessionId: string) => void
  hydrateFromMessages: (sessionId: string, messages: Message[]) => void
  addLiveNotification: (
    sessionId: string,
    payload: NotificationPayload,
    meta?: { id?: string; turnId?: string; createdAt?: string },
  ) => void
  markAllRead: (sessionId?: string) => void
  clear: () => void
}

function normalizeLevel(raw: string | undefined): NotificationLevel {
  if (raw === 'warning' || raw === 'success' || raw === 'error') return raw
  return 'info'
}

function normalizePayload(payload: NotificationPayload): {
  level: NotificationLevel
  title: string
  content: string
} | null {
  const title = typeof payload.title === 'string' ? payload.title.trim() : ''
  const content = typeof payload.content === 'string' ? payload.content.trim() : ''
  if (!title || !content) return null
  return {
    level: normalizeLevel(payload.level),
    title,
    content,
  }
}

function notificationFromMessageBlock(
  sessionId: string,
  message: Message,
  block: { type?: unknown; data?: unknown; block_id?: unknown; output?: unknown },
  index: number,
): NotificationItem | null {
  const output = normalizeOutputEnvelope(block.output)
  const type = resolveBlockType(block.type, output)
  if (type !== 'notification') return null

  const payload = resolveBlockData(block.data, output)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }
  const normalized = normalizePayload(payload as NotificationPayload)
  if (!normalized) return null
  return {
    id: resolveBlockId(block.block_id, output, `${message.id}:notification:${index}`),
    sessionId,
    level: normalized.level,
    title: normalized.title,
    content: normalized.content,
    createdAt: message.created_at,
    unread: false,
    turnId: message.turn_id,
  }
}

export const useNotificationStore = create<NotificationStore>((set) => ({
  activeSessionId: null,
  notifications: [],

  resetForSession: (sessionId) =>
    set((state) => {
      if (state.activeSessionId === sessionId && state.notifications.length === 0) {
        return state
      }
      return {
        activeSessionId: sessionId,
        notifications: [],
      }
    }),

  hydrateFromMessages: (sessionId, messages) =>
    set((state) => {
      if (state.activeSessionId !== sessionId) return state
      if (messages.length === 0) return state

      const existingIds = new Set(state.notifications.map((n) => n.id))
      const additions: NotificationItem[] = []

      for (const message of messages) {
        if (!message.blocks || message.blocks.length === 0) continue
        for (let i = 0; i < message.blocks.length; i += 1) {
          const parsed = notificationFromMessageBlock(
            sessionId,
            message,
            message.blocks[i],
            i,
          )
          if (!parsed || existingIds.has(parsed.id)) continue
          additions.push(parsed)
          existingIds.add(parsed.id)
        }
      }

      if (additions.length === 0) return state

      const notifications = [...state.notifications, ...additions].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      )
      return { notifications }
    }),

  addLiveNotification: (sessionId, payload, meta) =>
    set((state) => {
      if (state.activeSessionId !== sessionId) return state
      const normalized = normalizePayload(payload)
      if (!normalized) return state

      const id = meta?.id || `${sessionId}:notification:${Date.now()}`
      const existingIdx = state.notifications.findIndex((item) => item.id === id)
      if (existingIdx >= 0) {
        const existing = state.notifications[existingIdx]
        const updated: NotificationItem = {
          ...existing,
          ...normalized,
          unread: true,
          createdAt: meta?.createdAt || existing.createdAt,
          turnId: meta?.turnId || existing.turnId,
        }
        const next = [...state.notifications]
        next[existingIdx] = updated
        next.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        return { notifications: next }
      }

      const next: NotificationItem[] = [
        {
          id,
          sessionId,
          level: normalized.level,
          title: normalized.title,
          content: normalized.content,
          createdAt: meta?.createdAt || new Date().toISOString(),
          unread: true,
          turnId: meta?.turnId,
        },
        ...state.notifications,
      ]
      next.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      return { notifications: next }
    }),

  markAllRead: (sessionId) =>
    set((state) => {
      const hasUnread = state.notifications.some(
        (n) => n.unread && (!sessionId || n.sessionId === sessionId),
      )
      if (!hasUnread) return state
      return {
        notifications: state.notifications.map((n) =>
          n.unread && (!sessionId || n.sessionId === sessionId)
            ? { ...n, unread: false }
            : n,
        ),
      }
    }),

  clear: () => set({ activeSessionId: null, notifications: [] }),
}))
