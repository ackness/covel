import type { BlockRendererProps } from '../services/blockRenderers'
import { useBlockI18n } from './i18n'

interface ItemUpdateData {
  action: 'gain' | 'lose' | 'use' | 'equip' | 'unequip'
  item_name: string
  quantity: number
  item_type?: string
  description?: string
  stats?: Record<string, unknown>
}

const actionStyles: Record<string, { icon: string; labelKey: 'action.gain' | 'action.lose' | 'action.use' | 'action.equip' | 'action.unequip'; color: string }> = {
  gain: { icon: '📦', labelKey: 'action.gain', color: 'text-emerald-400' },
  lose: { icon: '💨', labelKey: 'action.lose', color: 'text-red-400' },
  use: { icon: '✨', labelKey: 'action.use', color: 'text-cyan-400' },
  equip: { icon: '🛡️', labelKey: 'action.equip', color: 'text-amber-400' },
  unequip: { icon: '📤', labelKey: 'action.unequip', color: 'text-muted-foreground' },
}

const typeKeys: Record<string, string> = {
  weapon: 'itemType.weapon',
  armor: 'itemType.armor',
  consumable: 'itemType.consumable',
  quest: 'itemType.quest',
  misc: 'itemType.misc',
  currency: 'itemType.currency',
  material: 'itemType.material',
  key: 'itemType.key',
}

function ItemRow({ d, t }: { d: ItemUpdateData; t: (k: string) => string }) {
  if (!d || !d.item_name) return null
  const style = actionStyles[d.action] || actionStyles.gain
  const typeLabel = d.item_type ? (typeKeys[d.item_type] ? t(typeKeys[d.item_type]) : d.item_type) : undefined

  return (
    <div className="flex items-center gap-2 py-0.5">
      <span className="text-sm">{style.icon}</span>
      <span className={`text-sm font-medium ${style.color}`}>{t(style.labelKey)}</span>
      <span className="text-sm font-medium">{d.item_name}</span>
      {d.quantity > 1 && <span className="text-muted-foreground text-xs">x{d.quantity}</span>}
      {typeLabel && (
        <span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">{typeLabel}</span>
      )}
    </div>
  )
}

export function ItemUpdateRenderer({ data }: BlockRendererProps) {
  const { t } = useBlockI18n()

  // Support grouped data (array) or single item
  const items: ItemUpdateData[] = Array.isArray(data)
    ? (data as ItemUpdateData[])
    : [data as ItemUpdateData]

  const valid = items.filter((d) => d && d.item_name)
  if (valid.length === 0) return null

  return (
    <div className="bg-card border border-border/50 rounded-xl px-4 py-2.5 max-w-[80%] space-y-0.5">
      {valid.map((d, i) => (
        <ItemRow key={`${d.item_name}-${i}`} d={d} t={t as (k: string) => string} />
      ))}
    </div>
  )
}
