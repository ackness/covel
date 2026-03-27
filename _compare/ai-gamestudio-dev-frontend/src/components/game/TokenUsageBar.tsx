import { useState } from 'react'
import { Settings2 } from 'lucide-react'
import { useTokenStore } from '../../stores/tokenStore'
import { useUiStore } from '../../stores/uiStore'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { CustomPricingModal } from './CustomPricingModal'

const text: Record<string, Record<string, string>> = {
  zh: {
    tokens: '令牌',
    cost: '费用',
    context: '上下文',
    input: '输入',
    output: '输出',
    total: '合计',
    unknown: '未知模型定价',
  },
  en: {
    tokens: 'Tokens',
    cost: 'Cost',
    context: 'Context',
    input: 'Input',
    output: 'Output',
    total: 'Total',
    unknown: 'Unknown model pricing',
  },
}

function formatTokens(n: number): string {
  if (n === 0) return '0'
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function formatCost(cost: number): string {
  if (cost === 0) return '$0'
  if (cost < 0.001) return `$${cost.toFixed(6)}`
  if (cost < 0.01) return `$${cost.toFixed(4)}`
  if (cost < 1) return `$${cost.toFixed(3)}`
  return `$${cost.toFixed(2)}`
}

export function TokenUsageBar() {
  const usage = useTokenStore((s) => s.usage)
  const modelInfo = useTokenStore((s) => s.modelInfo)
  const language = useUiStore((s) => s.language)
  const t = text[language] ?? text.en
  const [showPricing, setShowPricing] = useState(false)

  if (!usage && !modelInfo) return null

  const totalTokens = usage?.totalPromptTokens ?? 0
  const totalCompletionTokens = usage?.totalCompletionTokens ?? 0
  const totalCost = usage?.totalCost ?? 0
  const contextUsage = usage?.contextUsage ?? 0
  const maxInput = usage?.maxInputTokens || modelInfo?.maxInputTokens || 0
  const maxInputDisplay = modelInfo?.maxInputTokensDisplay || formatTokens(maxInput)

  const pct = Math.min(contextUsage * 100, 100)
  const barColor =
    pct >= 80 ? 'bg-red-500' :
    pct >= 50 ? 'bg-yellow-500' :
    'bg-green-500'

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground cursor-default select-none">
            <span>{formatTokens(totalTokens + totalCompletionTokens)}</span>
            {maxInput > 0 && (
              <>
                <span className="text-muted-foreground/50">/</span>
                <span>{maxInputDisplay}</span>
                <div className="w-16 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${barColor}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </>
            )}
            {totalCost > 0 && (
              <span className="text-muted-foreground/70">{formatCost(totalCost)}</span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          <div className="space-y-1">
            <div>{t.input}: {formatTokens(totalTokens)}</div>
            <div>{t.output}: {formatTokens(totalCompletionTokens)}</div>
            <div>{t.total}: {formatTokens(totalTokens + totalCompletionTokens)}</div>
            {totalCost > 0 && <div>{t.cost}: {formatCost(totalCost)}</div>}
            {maxInput > 0 && <div>{t.context}: {pct.toFixed(1)}% ({formatTokens(totalTokens)}/{maxInputDisplay})</div>}
            {modelInfo && !modelInfo.known && <div className="text-yellow-500">{t.unknown}</div>}
          </div>
        </TooltipContent>
      </Tooltip>
      {modelInfo && !modelInfo.known && (
        <button
          onClick={() => setShowPricing(true)}
          className="text-yellow-500 hover:text-yellow-400"
        >
          <Settings2 className="w-3 h-3" />
        </button>
      )}
      {showPricing && (usage?.model || modelInfo?.model) && (
        <CustomPricingModal
          model={(usage?.model || modelInfo?.model)!}
          onClose={() => setShowPricing(false)}
        />
      )}
    </>
  )
}
