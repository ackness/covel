import { useNotificationStore } from '../../stores/notificationStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { Badge } from '@/components/ui/badge'

const levelStyles: Record<string, { border: string; title: string; chip: string }> = {
  info: {
    border: 'border-cyan-700/60',
    title: 'text-cyan-300',
    chip: 'bg-cyan-900/40 text-cyan-300',
  },
  warning: {
    border: 'border-amber-700/60',
    title: 'text-amber-300',
    chip: 'bg-amber-900/40 text-amber-300',
  },
  success: {
    border: 'border-emerald-700/60',
    title: 'text-emerald-300',
    chip: 'bg-emerald-900/40 text-emerald-300',
  },
  error: {
    border: 'border-red-700/60',
    title: 'text-red-300',
    chip: 'bg-red-900/40 text-red-300',
  },
}

const notificationText: Record<string, Record<string, string>> = {
  zh: {
    init: '冒险尚未开始',
    initHint: '开始后产生的告警会显示在这里',
    empty: '暂无告警',
    emptyHint: '运行中的通知会显示在这里',
    turn: '回合',
  },
  en: {
    init: 'Adventure has not started',
    initHint: 'Alerts generated after start will appear here',
    empty: 'No alerts',
    emptyHint: 'Active notifications will appear here',
    turn: 'Turn',
  },
}

const levelText: Record<string, Record<string, string>> = {
  zh: {
    info: '提示',
    warning: '警告',
    success: '成功',
    error: '错误',
  },
  en: {
    info: 'Info',
    warning: 'Warning',
    success: 'Success',
    error: 'Error',
  },
}

export function NotificationPanel() {
  const currentSession = useSessionStore((s) => s.currentSession)
  const allNotifications = useNotificationStore((s) => s.notifications)
  const language = useUiStore((s) => s.language)
  const t = notificationText[language] ?? notificationText.en
  const levelLabels = levelText[language] ?? levelText.en
  const locale = language === 'zh' ? 'zh-CN' : 'en-US'
  const notifications = currentSession
    ? allNotifications.filter((item) => item.sessionId === currentSession.id)
    : []

  if (currentSession?.phase === 'init') {
    return (
      <div className="text-center text-muted-foreground py-8 text-sm">
        <p>{t.init}</p>
        <p className="text-xs mt-1">{t.initHint}</p>
      </div>
    )
  }

  if (notifications.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8 text-sm">
        <p>{t.empty}</p>
        <p className="text-xs mt-1">{t.emptyHint}</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {notifications.map((item) => {
        const style = levelStyles[item.level] || levelStyles.info
        return (
          <div
            key={item.id}
            className={`border ${style.border} bg-card rounded-lg px-3 py-2.5 space-y-1.5`}
          >
            <div className="flex items-center justify-between gap-2">
              <p className={`text-sm font-medium ${style.title}`}>{item.title}</p>
              <Badge
                variant="outline"
                className={`text-[10px] px-1.5 py-0 h-auto border-0 ${style.chip}`}
              >
                {levelLabels[item.level] ?? item.level}
              </Badge>
            </div>
            <p className="text-xs leading-relaxed text-foreground/80">{item.content}</p>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>{new Date(item.createdAt).toLocaleTimeString(locale)}</span>
              {item.turnId && <span className="truncate max-w-[130px]">{t.turn} {item.turnId.slice(0, 8)}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
