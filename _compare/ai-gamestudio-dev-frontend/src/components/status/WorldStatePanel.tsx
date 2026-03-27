import { useState } from 'react'
import { MapPin, Users, ChevronDown, ChevronRight } from 'lucide-react'
import { useGameDataStore } from '../../stores/gameDataStore'
import { useUiStore } from '../../stores/uiStore'
import { Badge } from '@/components/ui/badge'

const worldStateText: Record<string, Record<string, string>> = {
  zh: {
    empty: '暂无世界状态数据',
    emptyHint: '游戏进行中将显示状态更新',
    scene: '当前场景',
    npcs: 'NPC',
    noNpcs: '暂无 NPC',
    otherState: '其他状态',
  },
  en: {
    empty: 'No world state data',
    emptyHint: 'State updates will appear during gameplay',
    scene: 'Current Scene',
    npcs: 'NPCs',
    noNpcs: 'No NPCs',
    otherState: 'Other State',
  },
}

interface SceneNpc {
  name?: string
  role?: string
  description?: string
  [key: string]: unknown
}

interface SceneData {
  name?: string
  description?: string
  npcs?: SceneNpc[]
  [key: string]: unknown
}

function isSceneData(value: unknown): value is SceneData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.name === 'string' || typeof v.description === 'string' || Array.isArray(v.npcs)
}

function SceneCard({ scene, label }: { scene: SceneData; label: string }) {
  const [showNpcs, setShowNpcs] = useState(true)
  const npcs = Array.isArray(scene.npcs) ? scene.npcs : []
  const extraKeys = Object.keys(scene).filter((k) => !['name', 'description', 'npcs'].includes(k))

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="px-3 py-2.5 bg-primary/5 border-b flex items-center gap-2">
        <MapPin className="w-3.5 h-3.5 text-primary shrink-0" />
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="text-sm font-medium text-foreground truncate">{scene.name || '—'}</div>
        </div>
      </div>

      {scene.description && (
        <div className="px-3 py-2 text-xs text-foreground/80 leading-relaxed border-b">
          {scene.description}
        </div>
      )}

      {npcs.length > 0 && (
        <div className="border-b">
          <button
            onClick={() => setShowNpcs(!showNpcs)}
            className="w-full px-3 py-1.5 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors"
          >
            {showNpcs ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <Users className="w-3 h-3" />
            <span>NPC ({npcs.length})</span>
          </button>
          {showNpcs && (
            <div className="px-3 pb-2 space-y-1.5">
              {npcs.map((npc, i) => (
                <div key={npc.name || i} className="flex items-start gap-2 py-1 px-2 rounded bg-muted/30">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-foreground">{npc.name || '???'}</span>
                      {npc.role && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-auto font-normal border-cyan-500/30 text-cyan-400">
                          {npc.role}
                        </Badge>
                      )}
                    </div>
                    {npc.description && (
                      <div className="text-[11px] text-muted-foreground mt-0.5 leading-snug">{npc.description}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {extraKeys.length > 0 && (
        <div className="px-3 py-2 space-y-1">
          {extraKeys.map((k) => (
            <div key={k} className="flex gap-2 text-[11px]">
              <span className="text-muted-foreground shrink-0">{k}:</span>
              <span className="text-foreground/80 break-all">
                {typeof scene[k] === 'object' ? JSON.stringify(scene[k]) : String(scene[k])}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function GenericEntry({ label, value }: { label: string; value: unknown }) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return (
      <div className="rounded-lg border bg-card px-3 py-2 flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-primary shrink-0">{label}</span>
        <span className="text-xs text-foreground/80 break-all">{String(value)}</span>
      </div>
    )
  }
  if (Array.isArray(value)) {
    return (
      <div className="rounded-lg border bg-card p-3">
        <div className="text-[11px] font-medium text-primary mb-1">{label}</div>
        <div className="flex flex-wrap gap-1">
          {value.map((item, i) => (
            <span key={i} className="text-xs bg-muted text-foreground px-2 py-0.5 rounded">
              {typeof item === 'object' ? JSON.stringify(item) : String(item)}
            </span>
          ))}
        </div>
      </div>
    )
  }
  // Object fallback — render key-value pairs
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return (
      <div className="rounded-lg border bg-card p-3">
        <div className="text-[11px] font-medium text-primary mb-1.5">{label}</div>
        <div className="space-y-1">
          {Object.entries(obj).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-[11px]">
              <span className="text-muted-foreground shrink-0">{k}:</span>
              <span className="text-foreground/80 break-all">
                {typeof v === 'object' ? JSON.stringify(v) : String(v)}
              </span>
            </div>
          ))}
        </div>
      </div>
    )
  }
  return null
}

export function WorldStatePanel() {
  const { worldState } = useGameDataStore()
  const language = useUiStore((s) => s.language)
  const t = worldStateText[language] ?? worldStateText.en

  const entries = Object.entries(worldState)

  if (entries.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8 text-sm">
        <p>{t.empty}</p>
        <p className="text-xs mt-1">{t.emptyHint}</p>
      </div>
    )
  }

  // Separate scene entries from other state
  const sceneEntries: [string, SceneData][] = []
  const otherEntries: [string, unknown][] = []
  for (const [key, value] of entries) {
    if (isSceneData(value)) {
      sceneEntries.push([key, value])
    } else {
      otherEntries.push([key, value])
    }
  }

  return (
    <div className="space-y-3">
      {sceneEntries.map(([key, scene]) => (
        <SceneCard key={key} scene={scene} label={key === 'current_scene' ? t.scene : key} />
      ))}
      {otherEntries.map(([key, value]) => (
        <GenericEntry key={key} label={key} value={value} />
      ))}
    </div>
  )
}
