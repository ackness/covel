import { useState } from 'react'
import type { BlockRendererProps } from '../../services/blockRenderers'
import {
  EMPTY_BLOCK_INTERACTION,
  useBlockInteractionStore,
} from '../../stores/blockInteractionStore'
import { buildChoicesInteractionState } from './blockInteractionState'

interface ChoicesData {
  prompt: string
  type: 'single' | 'multi'
  options: string[]
}

export function ChoicesRenderer({ data, blockId, onAction, locked }: BlockRendererProps) {
  const payload = data && typeof data === 'object' ? (data as ChoicesData) : null

  const { prompt, type = 'single', options = [] } = payload ?? {
    prompt: '',
    type: 'single',
    options: [],
  }
  const interaction = useBlockInteractionStore(
    (s) => s.interactions[blockId] ?? EMPTY_BLOCK_INTERACTION,
  )
  const setInteraction = useBlockInteractionStore((s) => s.setInteraction)
  const interactionState = buildChoicesInteractionState(options, interaction)
  const chosen = interactionState.chosen
  const [selected, setSelected] = useState<Set<number>>(
    () => new Set(interactionState.selectedIndexes)
  )
  const submitted = interactionState.submitted

  if (!payload) return null

  // If locked (attached to old message) or already submitted, show read-only view
  if (locked || submitted) {
    const chosenText = chosen.length > 0 ? chosen : [...selected].map((i) => options[i])
    return (
      <div className="bg-card border rounded-xl px-4 py-3 space-y-2 max-w-[80%] opacity-70">
        <p className="text-muted-foreground text-sm">{prompt}</p>
        {chosenText.length > 0 ? (
          <p className="text-primary text-sm">
            已选择：{chosenText.join('、')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.map((opt, i) => (
              <span key={i} className="text-sm px-3 py-1.5 bg-muted text-muted-foreground rounded-lg cursor-not-allowed">
                {opt}
              </span>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (type === 'multi') {
    const toggle = (i: number) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(i)) next.delete(i)
        else next.add(i)
        return next
      })
    }

    const confirm = () => {
      if (selected.size === 0) return
      const chosen = [...selected].map((i) => options[i])
      setInteraction(blockId, { submitted: true, chosen })
      onAction(`我选择：${chosen.join('、')}`)
    }

    return (
      <div className="bg-card border rounded-xl px-4 py-3 space-y-2 max-w-[80%]">
        <p className="text-sm font-medium">{prompt}</p>
        <div className="space-y-1">
          {options.map((opt, i) => (
            <label
              key={i}
              className="flex items-center gap-2 cursor-pointer text-sm hover:text-foreground"
            >
              <input
                type="checkbox"
                checked={selected.has(i)}
                onChange={() => toggle(i)}
                className="accent-primary"
              />
              {opt}
            </label>
          ))}
        </div>
        <button
          onClick={confirm}
          disabled={selected.size === 0}
          className="text-xs px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed rounded transition-colors"
        >
          确认选择
        </button>
      </div>
    )
  }

  // single select — buttons
  const handleClick = (opt: string, i: number) => {
    setSelected(new Set([i]))
    setInteraction(blockId, { submitted: true, chosen: [opt] })
    onAction(`我选择：${opt}`)
  }

  return (
    <div className="bg-card border rounded-xl px-4 py-3 space-y-2 max-w-[80%]">
      <p className="text-sm font-medium">{prompt}</p>
      <div className="flex flex-wrap gap-2">
        {options.map((opt, i) => (
          <button
            key={i}
            onClick={() => handleClick(opt, i)}
            className="text-sm px-3 py-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg transition-colors"
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  )
}
