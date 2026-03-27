import { useState } from 'react'
import type { BlockRendererProps } from '../../services/blockRenderers'
import {
  EMPTY_BLOCK_INTERACTION,
  useBlockInteractionStore,
} from '../../stores/blockInteractionStore'
import { buildGuideInteractionState } from './blockInteractionState'

interface GuideCategory {
  style: 'safe' | 'aggressive' | 'creative' | 'wild'
  label?: string
  suggestions: string[]
}

const STYLE_LABELS: Record<string, string> = {
  safe: '稳妥',
  aggressive: '激进',
  creative: '另辟蹊径',
  wild: '天马行空',
}

interface GuideData {
  categories: GuideCategory[]
}

const styleIcons: Record<string, string> = {
  safe: '\u{1F6E1}\uFE0F',
  aggressive: '\u2694\uFE0F',
  creative: '\u{1F4A1}',
  wild: '\u{1F300}',
}

export function AutoGuideRenderer({ data, blockId, onAction, locked }: BlockRendererProps) {
  const { categories = [] } = (data || {}) as GuideData
  const interaction = useBlockInteractionStore(
    (s) => s.interactions[blockId] ?? EMPTY_BLOCK_INTERACTION,
  )
  const setInteraction = useBlockInteractionStore((s) => s.setInteraction)
  const interactionState = buildGuideInteractionState(interaction)
  const [collapsed, setCollapsed] = useState(interactionState.collapsed)
  const [customInput, setCustomInput] = useState(interactionState.customInput)
  const submitted = interactionState.submitted
  const chosenText = interactionState.chosenText

  const handleSelect = (text: string) => {
    setInteraction(blockId, { submitted: true, chosen: text, customInput: '' })
    onAction(text)
  }

  const handleCustomSubmit = () => {
    const trimmed = customInput.trim()
    if (!trimmed) return
    handleSelect(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleCustomSubmit()
    }
  }

  if (locked || submitted) {
    const text = chosenText
    return (
      <div className="bg-card border rounded-xl px-4 py-3 max-w-[80%] opacity-70">
        {text ? (
          <p className="auto-guide-submitted">
            已选择：{text}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">行动建议（已过期）</p>
        )}
      </div>
    )
  }

  return (
    <div className="auto-guide bg-card border rounded-xl px-4 py-3">
      <div
        className="auto-guide-header"
        onClick={() => {
          const next = !collapsed
          setCollapsed(next)
          setInteraction(blockId, { collapsed: next })
        }}
      >
        <h4>你可以...</h4>
        <button className="auto-guide-toggle">
          {collapsed ? '展开' : '收起'}
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="auto-guide-categories">
            {categories.map((cat) => (
              <div key={cat.style} className="auto-guide-category">
                <span className={`auto-guide-category-label ${cat.style}`}>
                  {styleIcons[cat.style] || ''} {cat.label ?? STYLE_LABELS[cat.style] ?? cat.style}
                </span>
                <div className="auto-guide-suggestions">
                  {cat.suggestions.map((s, i) => (
                    <button
                      key={i}
                      className={`auto-guide-btn ${cat.style}`}
                      onClick={() => handleSelect(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <hr className="auto-guide-divider" />

          <div className="auto-guide-custom">
            <input
              type="text"
              className="auto-guide-input"
              placeholder="或者输入你的想法..."
              value={customInput}
              onChange={(e) => {
                setCustomInput(e.target.value)
                setInteraction(blockId, { customInput: e.target.value })
              }}
              onKeyDown={handleKeyDown}
            />
            <button
              className="auto-guide-send"
              disabled={!customInput.trim()}
              onClick={handleCustomSubmit}
            >
              发送
            </button>
          </div>
        </>
      )}
    </div>
  )
}
