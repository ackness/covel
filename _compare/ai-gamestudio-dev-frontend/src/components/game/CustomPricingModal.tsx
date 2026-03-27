import { useState } from 'react'
import { useTokenStore } from '../../stores/tokenStore'
import { useUiStore } from '../../stores/uiStore'
import { Button } from '@/components/ui/button'

const text: Record<string, Record<string, string>> = {
  zh: {
    title: '自定义模型价格',
    inputCost: '输入价格 (USD/1K tokens)',
    outputCost: '输出价格 (USD/1K tokens)',
    save: '保存',
    cancel: '取消',
    hint: '当前模型不在价格数据库中，可手动设定价格以估算费用。',
  },
  en: {
    title: 'Custom Model Pricing',
    inputCost: 'Input Cost (USD/1K tokens)',
    outputCost: 'Output Cost (USD/1K tokens)',
    save: 'Save',
    cancel: 'Cancel',
    hint: 'This model is not in the pricing database. Set custom pricing to estimate costs.',
  },
}

interface Props {
  model: string
  onClose: () => void
}

export function CustomPricingModal({ model, onClose }: Props) {
  const language = useUiStore((s) => s.language)
  const t = text[language] ?? text.en
  const { customPricing, setCustomPricing } = useTokenStore()
  const existing = customPricing[model]
  const [inputCost, setInputCost] = useState(String(existing?.inputCost ?? '0'))
  const [outputCost, setOutputCost] = useState(String(existing?.outputCost ?? '0'))

  const handleSave = () => {
    setCustomPricing(model, parseFloat(inputCost) || 0, parseFloat(outputCost) || 0)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-background border rounded-lg p-6 w-80 space-y-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold">{t.title}</h3>
        <p className="text-xs text-muted-foreground">{t.hint}</p>
        <p className="text-xs font-mono text-muted-foreground">{model}</p>
        <div className="space-y-2">
          <label className="text-xs">{t.inputCost}</label>
          <input
            type="number"
            step="0.0001"
            value={inputCost}
            onChange={(e) => setInputCost(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm bg-background"
          />
        </div>
        <div className="space-y-2">
          <label className="text-xs">{t.outputCost}</label>
          <input
            type="number"
            step="0.0001"
            value={outputCost}
            onChange={(e) => setOutputCost(e.target.value)}
            className="w-full border rounded px-2 py-1 text-sm bg-background"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>{t.cancel}</Button>
          <Button size="sm" onClick={handleSave}>{t.save}</Button>
        </div>
      </div>
    </div>
  )
}
