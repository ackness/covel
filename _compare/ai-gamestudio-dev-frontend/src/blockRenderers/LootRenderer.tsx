import type { BlockRendererProps } from '../services/blockRenderers'
import { useBlockI18n } from './i18n'

interface LootItem {
  name: string
  type: string
  quantity: number
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary'
  description?: string
}

interface LootData {
  source: string
  items: LootItem[]
  gold?: number
}

const rarityColors: Record<string, { text: string; bg: string; border: string }> = {
  common: { text: 'text-muted-foreground', bg: 'bg-muted/40', border: 'border-border/50' },
  uncommon: { text: 'text-green-400', bg: 'bg-green-900/20', border: 'border-green-700/50' },
  rare: { text: 'text-blue-400', bg: 'bg-blue-900/20', border: 'border-blue-700/50' },
  epic: { text: 'text-purple-400', bg: 'bg-purple-900/20', border: 'border-purple-700/50' },
  legendary: { text: 'text-orange-400', bg: 'bg-orange-900/20', border: 'border-orange-700/50' },
}

const rarityKeys = {
  common: 'rarity.common',
  uncommon: 'rarity.uncommon',
  rare: 'rarity.rare',
  epic: 'rarity.epic',
  legendary: 'rarity.legendary',
} as const

const typeIcons: Record<string, string> = {
  weapon: '\u2694\uFE0F',
  armor: '\uD83D\uDEE1\uFE0F',
  consumable: '\uD83E\uDDEA',
  quest: '\u2B50',
  misc: '\uD83D\uDCE6',
}

export function LootRenderer({ data }: BlockRendererProps) {
  const { t } = useBlockI18n()
  const d = data as LootData
  if (!d || !d.items) return null

  return (
    <div className="bg-amber-900/20 border border-amber-700/50 rounded-xl px-4 py-3 max-w-[80%] space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-sm">{'\uD83C\uDF81'}</span>
        <span className="text-amber-300 text-sm font-medium">{d.source}</span>
      </div>

      <div className="space-y-1.5">
        {d.items.map((item, i) => {
          const rarity = rarityColors[item.rarity] || rarityColors.common
          const rKey = rarityKeys[item.rarity as keyof typeof rarityKeys]
          return (
            <div
              key={i}
              className={`${rarity.bg} border ${rarity.border} rounded-lg px-3 py-2 flex items-center justify-between`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs shrink-0">{typeIcons[item.type] || '\uD83D\uDCE6'}</span>
                <span className={`text-sm font-medium ${rarity.text} truncate`}>{item.name}</span>
                {item.quantity > 1 && (
                  <span className="text-muted-foreground text-xs">x{item.quantity}</span>
                )}
              </div>
              <span className={`text-xs ${rarity.text} shrink-0 ml-2`}>
                {rKey ? t(rKey) : item.rarity}
              </span>
            </div>
          )
        })}
      </div>

      {d.gold != null && d.gold > 0 && (
        <div className="text-yellow-400 text-sm flex items-center gap-1.5">
          <span>{'\uD83E\uDE99'}</span>
          <span>{d.gold} {t('loot.gold')}</span>
        </div>
      )}
    </div>
  )
}
