import { create } from 'zustand'
import type { Scene } from '../types'
import { syncToIdbFireAndForget } from '../services/idbSync'

interface SceneStore {
  currentScene: Scene | null
  scenes: Scene[]
  setCurrentScene: (scene: Scene | null) => void
  setScenes: (scenes: Scene[]) => void
  addScene: (scene: Scene) => void
  resetScenes: () => void
}

export const useSceneStore = create<SceneStore>((set) => ({
  currentScene: null,
  scenes: [],

  setCurrentScene: (currentScene) => set({ currentScene }),

  setScenes: (scenes) => {
    set({ scenes })
    if (scenes.length > 0) {
      scenes.forEach((s) => syncToIdbFireAndForget('scene', s))
    }
  },

  addScene: (scene) => {
    set((state) => ({ scenes: [...state.scenes, scene] }))
    syncToIdbFireAndForget('scene', scene)
  },

  resetScenes: () => set({ currentScene: null, scenes: [] }),
}))
