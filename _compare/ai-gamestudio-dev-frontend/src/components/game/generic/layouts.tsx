/**
 * Layout components for schema-driven block rendering.
 */
import type { ReactNode } from 'react'

const variantStyles: Record<string, string> = {
  default: 'border bg-card',
  info: 'border-cyan-700/50 bg-cyan-900/20',
  success: 'border-emerald-700/50 bg-emerald-900/20',
  warning: 'border-amber-700/50 bg-amber-900/20',
  error: 'border-red-700/50 bg-red-900/20',
}

export function CardLayout({
  title,
  variant = 'default',
  children,
}: {
  title?: string
  variant?: string
  children: ReactNode
}) {
  const style = variantStyles[variant] || variantStyles.default
  return (
    <div className={`border rounded-xl px-4 py-3 max-w-[80%] space-y-2 ${style}`}>
      {title && <p className="text-sm font-medium">{title}</p>}
      {children}
    </div>
  )
}

export function BannerLayout({
  title,
  variant = 'info',
  children,
}: {
  title?: string
  variant?: string
  children: ReactNode
}) {
  const borderColor: Record<string, string> = {
    info: 'border-cyan-600',
    success: 'border-emerald-600',
    warning: 'border-amber-600',
    error: 'border-red-600',
    default: 'border-border',
  }
  const border = borderColor[variant] || borderColor.default
  return (
    <div className={`bg-card border-l-4 ${border} rounded-r-xl px-4 py-3 max-w-[80%] space-y-2`}>
      {title && <p className="text-sm font-medium">{title}</p>}
      {children}
    </div>
  )
}

export function ButtonsLayout({
  title,
  text,
  buttons,
  onAction,
}: {
  title?: string
  text?: string
  buttons: { label: string; actionTemplate: string }[]
  onAction: (msg: string) => void
}) {
  return (
    <div className="bg-card border rounded-xl px-4 py-3 space-y-2 max-w-[80%]">
      {title && <p className="text-sm font-medium">{title}</p>}
      {text && <p className="text-sm text-muted-foreground">{text}</p>}
      <div className="flex flex-wrap gap-2">
        {buttons.map((btn, i) => (
          <button
            key={i}
            onClick={() => onAction(btn.actionTemplate)}
            className="text-sm px-3 py-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg transition-colors"
          >
            {btn.label}
          </button>
        ))}
      </div>
    </div>
  )
}
