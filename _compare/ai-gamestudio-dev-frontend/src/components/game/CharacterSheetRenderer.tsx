import { useState } from 'react'
import type { BlockRendererProps } from '../../services/blockRenderers'
import {
  EMPTY_BLOCK_INTERACTION,
  useBlockInteractionStore,
} from '../../stores/blockInteractionStore'
import { useUiStore } from '../../stores/uiStore'
import { buildCharacterSheetInteractionState } from './blockInteractionState'
import { normalizeInventoryItemLabel } from '../../utils/inventory'

interface CharacterSheetData {
  character_id: string
  name: string
  editable_fields: string[]
  attributes: Record<string, string | number>
  inventory: (string | { name: string; [key: string]: unknown })[]
  description?: string
  role?: string
  background?: string
}

const ROLE_TEXT: Record<string, Record<string, string>> = {
  zh: {
    player: '玩家',
    npc: 'NPC',
  },
  en: {
    player: 'Player',
    npc: 'NPC',
  },
}

function normalizeInventory(items: CharacterSheetData['inventory']): string[] {
  return items
    .map((item) => normalizeInventoryItemLabel(item))
    .filter((item) => item.trim().length > 0)
}

export function CharacterSheetRenderer({ data, blockId, onAction, locked }: BlockRendererProps) {
  const payload = data && typeof data === 'object' ? (data as CharacterSheetData) : null
  const language = useUiStore((s) => s.language)

  const {
    character_id,
    name,
    editable_fields = [],
    attributes = {},
    inventory: rawInventory = [],
    description,
    role,
    background,
  } = payload ?? {
    character_id: '',
    name: '',
    editable_fields: [],
    attributes: {},
    inventory: [],
    description: undefined,
    role: undefined,
    background: undefined,
  }

  const inventory = normalizeInventory(rawInventory)
  const roleLabel =
    typeof role === 'string'
      ? ROLE_TEXT[language]?.[role.toLowerCase()] || ROLE_TEXT.en[role.toLowerCase()] || role
      : ''
  const interaction = useBlockInteractionStore(
    (s) => s.interactions[blockId] ?? EMPTY_BLOCK_INTERACTION,
  )
  const setInteraction = useBlockInteractionStore((s) => s.setInteraction)
  const interactionState = buildCharacterSheetInteractionState(
    name,
    attributes,
    interaction,
    locked,
  )
  const [editedName, setEditedName] = useState(interactionState.editedName)
  const [editedAttrs, setEditedAttrs] = useState<Record<string, string | number>>(
    interactionState.editedAttrs,
  )
  const confirmed = interactionState.confirmed

  if (!payload) return null

  const isEditable = (field: string) => !locked && !confirmed && editable_fields.includes(field)

  const updateAttr = (key: string, value: string | number) => {
    setEditedAttrs((prev) => {
      const next = { ...prev, [key]: value }
      setInteraction(blockId, { editedAttrs: next })
      return next
    })
  }

  const handleConfirm = () => {
    setInteraction(blockId, { confirmed: true, editedName, editedAttrs })

    const changes: Record<string, string | number> = {}
    if (isEditable('name') && editedName !== name) {
      changes.name = editedName
    }
    for (const key of editable_fields) {
      if (key !== 'name' && editedAttrs[key] !== attributes[key]) {
        changes[key] = editedAttrs[key]
      }
    }

    if (character_id === 'new') {
      onAction(
        JSON.stringify({
          type: 'form_submit',
          form_id: 'character_creation',
          values: { name: editedName, ...editedAttrs },
        })
      )
    } else {
      onAction(
        JSON.stringify({
          type: 'character_edit',
          character_id,
          changes,
        })
      )
    }
  }

  const borderClass = confirmed ? 'border-primary' : 'border-border'

  return (
    <div className={`bg-card border ${borderClass} rounded-xl px-4 py-3 space-y-3 max-w-[80%]`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          {isEditable('name') && !confirmed ? (
            <input
              type="text"
              value={editedName}
              onChange={(e) => {
                setEditedName(e.target.value)
                setInteraction(blockId, { editedName: e.target.value })
              }}
              className="bg-background border border-primary/50 rounded px-2 py-1 text-sm font-medium focus:outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <h3 className="text-sm font-medium">{confirmed ? editedName : name}</h3>
          )}
          {role && <span className="text-xs text-muted-foreground ml-2">{roleLabel}</span>}
        </div>
        {character_id === 'new' && !confirmed && (
          <span className="text-xs text-cyan-400 bg-cyan-900/30 px-2 py-0.5 rounded">新角色</span>
        )}
      </div>

      {/* Description & Background */}
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
      {background && (
        <div>
          <p className="text-xs text-muted-foreground/70 mb-0.5">背景</p>
          <p className="text-muted-foreground text-xs">{background}</p>
        </div>
      )}

      {/* Attributes */}
      {Object.keys(editedAttrs).length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">属性</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {Object.entries(editedAttrs).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{key}</span>
                {isEditable(key) && !confirmed ? (
                  <input
                    type={typeof value === 'number' ? 'number' : 'text'}
                    value={editedAttrs[key] ?? ''}
                    onChange={(e) =>
                      updateAttr(
                        key,
                        typeof value === 'number' ? Number(e.target.value) : e.target.value
                      )
                    }
                    className="w-20 bg-background border border-primary/50 rounded px-1.5 py-0.5 text-xs text-right focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                ) : (
                  <span className="text-foreground">{String(confirmed ? editedAttrs[key] : value)}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inventory */}
      {inventory.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-1">物品</p>
          <div className="flex flex-wrap gap-1">
            {inventory.map((item, i) => (
              <span key={i} className="text-xs bg-muted text-foreground px-2 py-0.5 rounded">
                {item}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Confirm button */}
      {!confirmed && (
        <button
          onClick={handleConfirm}
          className="text-xs px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 rounded transition-colors"
        >
          确认
        </button>
      )}

      {confirmed && <p className="text-emerald-500 text-xs">已确认</p>}
    </div>
  )
}
