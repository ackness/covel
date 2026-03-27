import type { BlockRendererProps } from '../../services/blockRenderers'

interface SceneUpdateData {
  action: string
  name: string
  description?: string
  scene_id?: string
  npcs?: { character_id?: string; character_name?: string; role_in_scene?: string }[]
}

export function SceneUpdateRenderer({ data }: BlockRendererProps) {
  const { action, name, description, npcs } = data as SceneUpdateData

  return (
    <div className="bg-indigo-900/30 border border-indigo-700/50 rounded-xl px-4 py-3 max-w-[80%] space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-indigo-400 text-xs font-medium uppercase">
          {action === 'move' ? '场景切换' : '场景更新'}
        </span>
      </div>
      <p className="text-sm font-medium">{name}</p>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {npcs && npcs.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {npcs.map((npc, i) => (
            <span key={i} className="text-xs bg-muted text-foreground px-2 py-0.5 rounded">
              {npc.character_name || npc.character_id || 'NPC'}
              {npc.role_in_scene && ` (${npc.role_in_scene})`}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
