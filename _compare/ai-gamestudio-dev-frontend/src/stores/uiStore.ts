import { create } from 'zustand'
import { StorageFactory } from '../services/settingsStorage'

const LANG_STORAGE_KEY = 'ui_language'

function detectDefaultLanguage(): string {
  const stored = localStorage.getItem(LANG_STORAGE_KEY)
  if (stored) return stored
  const browser = navigator.language || ''
  return browser.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

interface UiStore {
  language: string
  setLanguage: (lang: string) => void
  storagePersistent: boolean | null  // null = not yet detected
  checkStoragePersistence: () => Promise<void>
}

export const useUiStore = create<UiStore>((set) => ({
  language: detectDefaultLanguage(),
  storagePersistent: null,

  setLanguage: (lang: string) => {
    localStorage.setItem(LANG_STORAGE_KEY, lang)
    set({ language: lang })
  },

  checkStoragePersistence: async () => {
    const persistent = await StorageFactory.isStoragePersistent()
    set({ storagePersistent: persistent })
  },
}))
