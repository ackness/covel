import type { BlockRendererProps } from '../../services/blockRenderers'

interface NotificationData {
  level: 'info' | 'warning' | 'success' | 'error'
  title: string
  content: string
}

const levelStyles: Record<string, { border: string; icon: string; titleColor: string }> = {
  info: {
    border: 'border-cyan-600',
    icon: '\u2139\uFE0F',
    titleColor: 'text-cyan-400',
  },
  warning: {
    border: 'border-amber-600',
    icon: '\u26A0\uFE0F',
    titleColor: 'text-amber-400',
  },
  success: {
    border: 'border-emerald-600',
    icon: '\u2705',
    titleColor: 'text-emerald-400',
  },
  error: {
    border: 'border-red-600',
    icon: '\u274C',
    titleColor: 'text-red-400',
  },
}

export function NotificationRenderer({ data }: BlockRendererProps) {
  const { level = 'info', title, content } = data as NotificationData
  const style = levelStyles[level] || levelStyles.info

  return (
    <div
      className={`bg-card border-l-4 ${style.border} rounded-r-xl px-4 py-3 max-w-[80%]`}
    >
      <div className="flex items-start gap-2">
        <span className="text-sm leading-5">{style.icon}</span>
        <div>
          <p className={`text-sm font-medium ${style.titleColor}`}>{title}</p>
          <p className="text-foreground/80 text-sm mt-1">{content}</p>
        </div>
      </div>
    </div>
  )
}
