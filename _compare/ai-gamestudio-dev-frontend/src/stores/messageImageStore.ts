import { create } from 'zustand'
import type { StoryImageData } from '../types'
import * as api from '../services/api'

interface MessageImageStore {
  messageImages: Record<string, StoryImageData[]>
  imageLoadingMessages: Set<string>
  setMessageImage: (messageId: string, image: StoryImageData) => void
  setImageLoading: (messageId: string, loading: boolean) => void
  clearMessageImages: () => void
  hydrateMessageImages: (sessionId: string) => Promise<void>
  resetMessageImages: () => void
}

export const useMessageImageStore = create<MessageImageStore>((set) => ({
  messageImages: {},
  imageLoadingMessages: new Set<string>(),

  setMessageImage: (messageId, image) =>
    set((state) => {
      const existing = state.messageImages[messageId] || []
      return {
        messageImages: {
          ...state.messageImages,
          [messageId]: [...existing, image],
        },
      }
    }),

  setImageLoading: (messageId, loading) =>
    set((state) => {
      const next = new Set(state.imageLoadingMessages)
      if (loading) {
        next.add(messageId)
      } else {
        next.delete(messageId)
      }
      return { imageLoadingMessages: next }
    }),

  clearMessageImages: () => set({ messageImages: {}, imageLoadingMessages: new Set<string>() }),

  hydrateMessageImages: async (sessionId) => {
    try {
      const images = await api.getSessionStoryImages(sessionId)
      const map: Record<string, StoryImageData[]> = {}
      for (const img of images) {
        if (img.message_id) {
          if (!map[img.message_id]) {
            map[img.message_id] = []
          }
          map[img.message_id].push(img)
        }
      }
      set({ messageImages: map })
    } catch {
      // ignore
    }
  },

  resetMessageImages: () => set({ messageImages: {}, imageLoadingMessages: new Set<string>() }),
}))
