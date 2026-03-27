import type { BlockRendererProps } from '../services/blockRenderers'
import { useBlockI18n } from './i18n'

interface RelationshipChangeData {
  npc_name: string
  change: number
  reason: string
  new_level: number
  rank: string
  relationship_type: string
}

const typeConfig: Record<string, { icon: string; labelKey: 'rel.friend' | 'rel.rival' | 'rel.romantic' | 'rel.mentor' | 'rel.enemy'; color: string }> = {
  friend:   { icon: '\u{1F91D}', labelKey: 'rel.friend',   color: 'blue' },
  rival:    { icon: '\u{2694}\uFE0F',  labelKey: 'rel.rival',    color: 'purple' },
  romantic: { icon: '\u{1F497}', labelKey: 'rel.romantic', color: 'rose' },
  mentor:   { icon: '\u{1F393}', labelKey: 'rel.mentor',   color: 'cyan' },
  enemy:    { icon: '\u{1F525}', labelKey: 'rel.enemy',    color: 'red' },
}

const colorMap: Record<string, { bg: string; border: string; accent: string }> = {
  blue:   { bg: 'bg-blue-500/10',   border: 'border-blue-500/40',   accent: 'text-blue-400' },
  purple: { bg: 'bg-purple-500/10', border: 'border-purple-500/40', accent: 'text-purple-400' },
  rose:   { bg: 'bg-rose-500/10',   border: 'border-rose-500/40',   accent: 'text-rose-400' },
  cyan:   { bg: 'bg-cyan-500/10',   border: 'border-cyan-500/40',   accent: 'text-cyan-400' },
  red:    { bg: 'bg-red-500/10',    border: 'border-red-500/40',    accent: 'text-red-400' },
}

export function RelationshipRenderer({ data }: BlockRendererProps) {
  const { t } = useBlockI18n()
  const d = data as RelationshipChangeData
  const cfg = typeConfig[d.relationship_type] || typeConfig.friend
  const colors = colorMap[cfg.color] || colorMap.blue
  const isPositive = d.change > 0

  return (
    <div className={`${colors.bg} border ${colors.border} rounded-xl px-4 py-3 max-w-[80%] space-y-2`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-lg">{cfg.icon}</span>
          <span className={`font-medium ${colors.accent}`}>{d.npc_name}</span>
          <span className="text-muted-foreground text-xs">{t(cfg.labelKey)}</span>
        </div>
        <span className={`text-sm font-mono font-bold ${isPositive ? 'text-emerald-400' : 'text-red-400'}`}>
          {isPositive ? '+' : ''}{d.change}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>{d.rank}</span>
        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${isPositive ? 'bg-emerald-500' : 'bg-red-500'}`}
            style={{ width: `${Math.max(0, Math.min(100, d.new_level))}%` }}
          />
        </div>
        <span>{d.new_level}/100</span>
      </div>
      <p className="text-foreground/80 text-sm">{d.reason}</p>
    </div>
  )
}
