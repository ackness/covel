import type { BlockRendererProps } from '../services/blockRenderers'
import { useBlockI18n } from './i18n'

interface StatusEffectData {
  action: 'apply' | 'remove' | 'tick'
  effect_name: string
  effect_type: 'buff' | 'debuff' | 'dot' | 'hot'
  duration?: number
  target: string
  stats?: Record<string, number>
  damage_per_turn?: number
  heal_per_turn?: number
  description: string
}

const typeConfig: Record<string, { icon: string; color: string; border: string; bg: string }> = {
  buff: { icon: '\u2B06', color: 'text-emerald-400', border: 'border-emerald-600/50', bg: 'bg-emerald-900/30' },
  debuff: { icon: '\u2B07', color: 'text-red-400', border: 'border-red-600/50', bg: 'bg-red-900/30' },
  dot: { icon: '\uD83D\uDC80', color: 'text-purple-400', border: 'border-purple-600/50', bg: 'bg-purple-900/30' },
  hot: { icon: '\uD83D\uDC9A', color: 'text-green-400', border: 'border-green-600/50', bg: 'bg-green-900/30' },
}

const actionKeys = {
  apply: 'effect.apply',
  remove: 'effect.remove',
  tick: 'effect.tick',
} as const

export function StatusEffectRenderer({ data }: BlockRendererProps) {
  const { t } = useBlockI18n()
  const d = data as StatusEffectData
  const cfg = typeConfig[d.effect_type] || typeConfig.buff

  return (
    <div className={`${cfg.bg} border ${cfg.border} rounded-xl px-4 py-3 max-w-[80%] space-y-2`}>
      <div className="flex items-center gap-2">
        <span className="text-lg">{cfg.icon}</span>
        <span className={`${cfg.color} font-medium text-sm`}>{d.effect_name}</span>
        <span className="text-muted-foreground text-xs">({t(actionKeys[d.action] || actionKeys.apply)})</span>
        {d.duration != null && d.duration > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">{d.duration} {t('effect.rounds')}</span>
        )}
      </div>
      <p className="text-foreground/80 text-xs">{d.description}</p>
      {d.stats && Object.keys(d.stats).length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {Object.entries(d.stats).map(([k, v]) => (
            <span
              key={k}
              className={`text-xs px-1.5 py-0.5 rounded ${v > 0 ? 'bg-emerald-800/50 text-emerald-300' : 'bg-red-800/50 text-red-300'}`}
            >
              {k} {v > 0 ? '+' : ''}{v}
            </span>
          ))}
        </div>
      )}
      {d.damage_per_turn != null && d.damage_per_turn > 0 && (
        <span className="text-xs text-purple-300">{t('effect.dmgPerTurn', d.damage_per_turn)}</span>
      )}
      {d.heal_per_turn != null && d.heal_per_turn > 0 && (
        <span className="text-xs text-green-300">{t('effect.healPerTurn', d.heal_per_turn)}</span>
      )}
    </div>
  )
}
