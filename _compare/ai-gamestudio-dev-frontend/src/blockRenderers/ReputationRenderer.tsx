import type { BlockRendererProps } from '../services/blockRenderers'

interface ReputationData {
  faction: string
  change: number
  reason: string
  new_standing: number
  rank: string
}

export function ReputationRenderer({ data }: BlockRendererProps) {
  const d = data as ReputationData
  const isPositive = d.change > 0

  return (
    <div className="bg-amber-900/30 border border-amber-700/50 rounded-xl px-4 py-3 max-w-[80%] space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-lg">&#x1F6E1;</span>
        <span className="text-amber-200 font-medium text-sm">{d.faction}</span>
        <span
          className={`ml-auto text-sm font-bold ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}
        >
          {isPositive ? '+' : ''}{d.change}
        </span>
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{d.reason}</span>
        <span className="text-amber-300/80 font-medium">{d.rank}</span>
      </div>
    </div>
  )
}
