import { useState } from 'react'
import { useGameDataStore } from '../../stores/gameDataStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import type { GameEvent } from '../../types'
import { buildEventForest } from './eventTree'
import { Badge } from '@/components/ui/badge'

const typeBadgeColors: Record<string, string> = {
  quest: 'bg-amber-900/50 text-amber-400',
  combat: 'bg-red-900/50 text-red-400',
  social: 'bg-blue-900/50 text-blue-400',
  world: 'bg-emerald-900/50 text-emerald-400',
  system: 'bg-muted text-muted-foreground',
}

const statusIcons: Record<string, string> = {
  active: '\u25CF',
  resolved: '\u2713',
  ended: '\u25CB',
}

const eventText: Record<string, Record<string, string>> = {
  zh: {
    initEmpty: '冒险尚未开始，暂无事件',
    empty: '暂无事件',
    active: '活跃事件',
    ended: '已结束事件',
  },
  en: {
    initEmpty: 'No events yet. Adventure has not started.',
    empty: 'No events',
    active: 'Active Events',
    ended: 'Ended Events',
  },
}

const eventTypeText: Record<string, Record<string, string>> = {
  zh: {
    quest: '任务',
    combat: '战斗',
    social: '社交',
    world: '世界',
    system: '系统',
  },
  en: {
    quest: 'Quest',
    combat: 'Combat',
    social: 'Social',
    world: 'World',
    system: 'System',
  },
}

function getEventTypeLabel(eventType: string, language: string): string {
  const labels = eventTypeText[language] ?? eventTypeText.en
  return labels[eventType] ?? eventType
}

function EventCard({ event, depth = 0, language }: { event: GameEvent; depth?: number; language: string }) {
  const [expanded, setExpanded] = useState(event.status === 'active')
  const hasChildren = event.children && event.children.length > 0
  const badgeClass = typeBadgeColors[event.event_type] || typeBadgeColors.system

  return (
    <div style={{ marginLeft: depth * 12 }}>
      <div
        className="flex items-start gap-2 py-1.5 cursor-pointer hover:bg-muted/50 rounded px-1 -mx-1"
        onClick={() => setExpanded(!expanded)}
      >
        <span
          className={`text-xs mt-0.5 ${
            event.status === 'active'
              ? 'text-primary'
              : event.status === 'resolved'
                ? 'text-muted-foreground'
                : 'text-muted-foreground/40'
          }`}
        >
          {statusIcons[event.status] || statusIcons.ended}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{event.name}</span>
            <Badge
              variant="outline"
              className={`text-[10px] px-1.5 py-0 h-auto border-0 ${badgeClass}`}
            >
              {getEventTypeLabel(event.event_type, language)}
            </Badge>
          </div>
          {expanded && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{event.description}</p>
          )}
        </div>
      </div>

      {expanded && hasChildren && (
        <div className="border-l border-neutral-300 ml-1.5">
          {event.children!.map((child) => (
            <EventCard key={child.id} event={child} depth={depth + 1} language={language} />
          ))}
        </div>
      )}
    </div>
  )
}

export function EventPanel() {
  const currentSession = useSessionStore((s) => s.currentSession)
  const allEvents = useGameDataStore((s) => s.events)
  const language = useUiStore((s) => s.language)
  const t = eventText[language] ?? eventText.en
  const events = currentSession
    ? allEvents.filter((event) => event.session_id === currentSession.id)
    : []

  if (currentSession?.phase === 'init') {
    return <p className="text-muted-foreground text-sm text-center py-4">{t.initEmpty}</p>
  }

  const withChildren = buildEventForest(events)

  const active = withChildren.filter((e) => e.status === 'active')
  const ended = withChildren.filter((e) => e.status !== 'active')

  if (events.length === 0) {
    return <p className="text-muted-foreground text-sm text-center py-4">{t.empty}</p>
  }

  return (
    <div className="space-y-4">
      {active.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2">{t.active}</h4>
          <div className="space-y-0.5">
            {active.map((event) => (
              <EventCard key={event.id} event={event} language={language} />
            ))}
          </div>
        </div>
      )}

      {ended.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground uppercase mb-2">{t.ended}</h4>
          <div className="space-y-0.5">
            {ended.map((event) => (
              <EventCard key={event.id} event={event} language={language} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
