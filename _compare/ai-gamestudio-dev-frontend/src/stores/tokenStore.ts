import { create } from 'zustand'

export interface TokenUsageData {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  turnCost: number
  totalCost: number
  totalPromptTokens: number
  totalCompletionTokens: number
  contextUsage: number // 0.0 - 1.0
  maxInputTokens: number
  model: string
}

export interface ModelInfo {
  model: string
  maxInputTokens: number
  maxOutputTokens: number
  maxInputTokensDisplay: string
  inputCostPerToken: number
  outputCostPerToken: number
  known: boolean
}

interface TokenStore {
  usage: TokenUsageData | null
  modelInfo: ModelInfo | null
  customPricing: Record<string, { inputCost: number; outputCost: number }>

  updateUsage: (data: TokenUsageData) => void
  setModelInfo: (info: ModelInfo) => void
  setCustomPricing: (model: string, inputCost: number, outputCost: number) => void
  reset: () => void
}

export const useTokenStore = create<TokenStore>((set) => ({
  usage: null,
  modelInfo: null,
  customPricing: JSON.parse(localStorage.getItem('customPricing') || '{}'),

  updateUsage: (data) => set({ usage: data }),
  setModelInfo: (info) => set({ modelInfo: info }),
  setCustomPricing: (model, inputCost, outputCost) =>
    set((state) => {
      const next = { ...state.customPricing, [model]: { inputCost, outputCost } }
      localStorage.setItem('customPricing', JSON.stringify(next))
      return { customPricing: next }
    }),
  reset: () => set({ usage: null }),
}))
