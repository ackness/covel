import { useState } from 'react'
import { useGameDataStore } from '../../stores/gameDataStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import * as api from '../../services/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { normalizeInventoryItemLabel } from '../../utils/inventory'

const characterText: Record<string, Record<string, string>> = {
  zh: {
    empty: '暂无角色',
    emptyHint: '角色会随游戏推进出现',
    syncing: '同步中...',
    sync: '同步角色',
    player: '玩家',
    npc: 'NPC',
    personality: '性格：',
    attributes: '属性：',
    inventory: '物品：',
  },
  en: {
    empty: 'No characters yet',
    emptyHint: 'Characters will appear as the story progresses',
    syncing: 'Syncing...',
    sync: 'Sync Characters',
    player: 'Player',
    npc: 'NPC',
    personality: 'Personality:',
    attributes: 'Attributes:',
    inventory: 'Inventory:',
  },
}

export function CharacterPanel() {
  const { characters } = useGameDataStore()
  const currentSession = useSessionStore((s) => s.currentSession)
  const language = useUiStore((s) => s.language)
  const t = characterText[language] ?? characterText.en
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [syncing, setSyncing] = useState(false)

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const handleSync = async () => {
    if (!currentSession || syncing) return
    setSyncing(true)
    try {
      const chars = await api.getCharacters(currentSession.id)
      useGameDataStore.getState().setCharacters(chars)
    } finally {
      setSyncing(false)
    }
  }

  if (characters.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8 text-sm">
        <p>{t.empty}</p>
        <p className="text-xs mt-1">{t.emptyHint}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-end px-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSync}
          disabled={syncing}
          className="text-xs h-auto py-0.5 px-2"
        >
          {syncing ? t.syncing : t.sync}
        </Button>
      </div>
      {characters.map((char) => {
        const role = char.role || 'npc'
        const attrs = char.attributes || {}
        const inv = char.inventory || []

        return (
        <div
          key={char.id}
          className="rounded-lg border bg-card overflow-hidden"
        >
          <button
            onClick={() => toggleExpand(char.id)}
            className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{char.name}</span>
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 h-auto font-medium border-0 ${
                  role === 'player'
                    ? 'bg-emerald-900/50 text-emerald-400'
                    : 'bg-cyan-900/50 text-cyan-400'
                }`}
              >
                {role === 'player' ? t.player : t.npc}
              </Badge>
            </div>
            <span className="text-muted-foreground text-xs">{expandedIds.has(char.id) ? '-' : '+'}</span>
          </button>

          {expandedIds.has(char.id) && (
            <div className="px-3 pb-3 border-t pt-2 text-xs space-y-2">
              {char.description && (
                <p className="text-muted-foreground">{char.description}</p>
              )}
              {char.personality && (
                <div>
                  <span className="text-muted-foreground">{t.personality}</span>
                  <span className="text-foreground">{char.personality}</span>
                </div>
              )}
              {Object.keys(attrs).length > 0 && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">{t.attributes}</span>
                  {Object.entries(attrs).map(([key, val]) => (
                    <div key={key} className="flex justify-between ml-2">
                      <span className="text-muted-foreground">{key}</span>
                      <span className="text-foreground">{String(val)}</span>
                    </div>
                  ))}
                </div>
              )}
              {inv.length > 0 && (
                <div className="space-y-1">
                  <span className="text-muted-foreground">{t.inventory}</span>
                  <div className="flex flex-wrap gap-1 ml-2">
                    {inv.map((item, i) => (
                      <span key={i} className="text-xs bg-muted text-foreground px-2 py-0.5 rounded">
                        {normalizeInventoryItemLabel(item)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        )
      })}
    </div>
  )
}
