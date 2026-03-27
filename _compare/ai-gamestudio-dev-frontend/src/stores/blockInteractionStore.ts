import { create } from 'zustand'

export interface BlockInteractionState {
  submitted?: boolean
  chosen?: string | string[]
  confirmed?: boolean
  formValues?: Record<string, string | number | boolean>
  editedName?: string
  editedAttrs?: Record<string, string | number>
  collapsed?: boolean
  customInput?: string
}

interface BlockInteractionStore {
  interactions: Record<string, BlockInteractionState>
  setInteraction: (blockId: string, patch: Partial<BlockInteractionState>) => void
  clear: () => void
}

export const EMPTY_BLOCK_INTERACTION: Readonly<BlockInteractionState> = Object.freeze({})

export const useBlockInteractionStore = create<BlockInteractionStore>((set) => ({
  interactions: {},

  setInteraction: (blockId, patch) =>
    set((state) => ({
      interactions: {
        ...state.interactions,
        [blockId]: {
          ...(state.interactions[blockId] || {}),
          ...patch,
        },
      },
    })),

  clear: () => set({ interactions: {} }),
}))
