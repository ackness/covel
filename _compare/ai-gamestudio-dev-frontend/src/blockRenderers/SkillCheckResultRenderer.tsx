import type { BlockRendererProps } from '../services/blockRenderers'
import { useBlockI18n } from './i18n'

interface SkillCheckResultData {
  dice?: string
  roll?: number
  modifier?: number
  attribute_bonus?: number
  total?: number
  difficulty?: number
  success_level?: 'critical_success' | 'success' | 'failure' | 'critical_failure'
  skill?: string
  description?: string
}

const levelStyles = {
  critical_success: { bg: 'bg-yellow-900/40', border: 'border-yellow-500/60', text: 'text-yellow-300', badge: 'bg-yellow-500/30' },
  success: { bg: 'bg-emerald-900/30', border: 'border-emerald-500/50', text: 'text-emerald-300', badge: 'bg-emerald-500/30' },
  failure: { bg: 'bg-card', border: 'border-border/50', text: 'text-muted-foreground', badge: 'bg-muted/50' },
  critical_failure: { bg: 'bg-red-900/30', border: 'border-red-500/50', text: 'text-red-300', badge: 'bg-red-500/30' },
} as const

const levelKeys = {
  critical_success: 'skill.criticalSuccess',
  success: 'skill.success',
  failure: 'skill.failure',
  critical_failure: 'skill.criticalFailure',
} as const

export function SkillCheckResultRenderer({ data }: BlockRendererProps) {
  const { t } = useBlockI18n()
  if (!data || typeof data !== 'object') return null
  const d = data as SkillCheckResultData

  const level = d.success_level && levelStyles[d.success_level]
    ? d.success_level
    : 'failure'
  const config = levelStyles[level]

  return (
    <div className={`${config.bg} border ${config.border} rounded-xl px-4 py-3 max-w-[80%] space-y-2`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {d.skill ? `${d.skill} ${t('skill.check')}` : t('skill.skillCheck')}
        </p>
        <span className={`text-[10px] px-2 py-0.5 rounded ${config.badge} ${config.text}`}>
          {t(levelKeys[level])}
        </span>
      </div>

      <div className="flex items-baseline gap-3 text-xs text-foreground/80">
        <span>
          {d.dice || '1d20'}: <span className="text-foreground font-mono font-semibold">{d.roll ?? '?'}</span>
        </span>
        {(d.modifier !== undefined && d.modifier !== 0) && (
          <span>{t('skill.modifier')}: <span className="font-mono">{d.modifier > 0 ? `+${d.modifier}` : d.modifier}</span></span>
        )}
        {(d.attribute_bonus !== undefined && d.attribute_bonus !== 0) && (
          <span>{t('skill.attribute')}: <span className="font-mono">{d.attribute_bonus > 0 ? `+${d.attribute_bonus}` : d.attribute_bonus}</span></span>
        )}
        <span className="text-muted-foreground">|</span>
        <span>
          {t('skill.total')}: <span className={`font-mono font-semibold ${config.text}`}>{d.total ?? '?'}</span>
          {' '}vs DC <span className="font-mono">{d.difficulty ?? '?'}</span>
        </span>
      </div>

      {d.description && (
        <p className="text-xs text-muted-foreground">{d.description}</p>
      )}
    </div>
  )
}
