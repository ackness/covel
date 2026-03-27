import { useState } from 'react'
import { useGameDataStore } from '../../stores/gameDataStore'
import { useUiStore } from '../../stores/uiStore'
import type { Quest } from '../../types'
import { Badge } from '@/components/ui/badge'

const questText: Record<string, Record<string, string>> = {
  zh: {
    empty: '暂无任务',
    emptyHint: '任务会随冒险推进出现',
    active: '进行中',
    completed: '已完成',
    failed: '已失败',
    objectives: '目标',
    rewards: '奖励',
  },
  en: {
    empty: 'No quests yet',
    emptyHint: 'Quests will appear as the story progresses',
    active: 'Active',
    completed: 'Completed',
    failed: 'Failed',
    objectives: 'Objectives',
    rewards: 'Rewards',
  },
}

const statusStyles: Record<string, { badge: string; dot: string }> = {
  active: { badge: 'bg-cyan-900/50 text-cyan-400', dot: 'text-cyan-400' },
  completed: { badge: 'bg-emerald-900/50 text-emerald-400', dot: 'text-emerald-400' },
  failed: { badge: 'bg-red-900/50 text-red-400', dot: 'text-red-400' },
}

function QuestCard({ quest, language }: { quest: Quest; language: string }) {
  const [expanded, setExpanded] = useState(quest.status === 'active')
  const t = questText[language] ?? questText.en
  const style = statusStyles[quest.status] || statusStyles.active
  const completedCount = quest.objectives?.filter((o) => o.completed).length ?? 0
  const totalCount = quest.objectives?.length ?? 0

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-xs ${style.dot}`}>{quest.status === 'active' ? '●' : quest.status === 'completed' ? '✓' : '✗'}</span>
          <span className="text-sm font-medium truncate">{quest.title}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-auto border-0 ${style.badge}`}>
            {t[quest.status] || quest.status}
          </Badge>
          <span className="text-muted-foreground text-xs">{expanded ? '-' : '+'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t pt-2 text-xs space-y-2">
          {quest.description && (
            <p className="text-muted-foreground">{quest.description}</p>
          )}

          {quest.objectives && quest.objectives.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t.objectives}</span>
                <span className="text-muted-foreground">{completedCount}/{totalCount}</span>
              </div>
              {quest.objectives.map((obj) => (
                <div key={obj.id} className="flex items-start gap-2 ml-1">
                  <span className={`mt-0.5 ${obj.completed ? 'text-emerald-400' : 'text-muted-foreground/40'}`}>
                    {obj.completed ? '◉' : '○'}
                  </span>
                  <span className={obj.completed ? 'text-muted-foreground line-through' : 'text-foreground/80'}>
                    {obj.text}
                  </span>
                </div>
              ))}
            </div>
          )}

          {quest.rewards && (
            <div className="flex items-center gap-3 pt-1 border-t">
              <span className="text-muted-foreground">{t.rewards}</span>
              {quest.rewards.xp != null && <span className="text-cyan-400">{quest.rewards.xp} XP</span>}
              {quest.rewards.gold != null && <span className="text-yellow-400">{quest.rewards.gold} G</span>}
              {quest.rewards.items?.map((item, i) => (
                <span key={i} className="text-amber-300">{item}</span>
              ))}
              {quest.rewards.value && <span className="text-amber-300">{quest.rewards.value}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function QuestPanel() {
  const quests = useGameDataStore((s) => s.quests)
  const language = useUiStore((s) => s.language)
  const t = questText[language] ?? questText.en

  if (quests.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8 text-sm">
        <p>{t.empty}</p>
        <p className="text-xs mt-1">{t.emptyHint}</p>
      </div>
    )
  }

  const active = quests.filter((q) => q.status === 'active')
  const done = quests.filter((q) => q.status !== 'active')

  return (
    <div className="space-y-3">
      {active.map((q) => <QuestCard key={q.quest_id} quest={q} language={language} />)}
      {done.map((q) => <QuestCard key={q.quest_id} quest={q} language={language} />)}
    </div>
  )
}
