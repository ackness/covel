/**
 * Generic section renderers for schema-driven block UI.
 * Each component renders a specific section type within a block layout.
 */
import Markdown from 'react-markdown'

interface KeyValueItem {
  label: string
  value: string
}

export function KeyValueSection({ items }: { items: KeyValueItem[] }) {
  if (!items?.length) return null
  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className="flex justify-between text-sm">
          <span className="text-muted-foreground">{item.label}</span>
          <span className="text-foreground">{item.value}</span>
        </div>
      ))}
    </div>
  )
}

export function TextSection({ content }: { content: string }) {
  if (!content) return null
  return (
    <div className="text-sm text-foreground/80 markdown-content">
      <Markdown>{content}</Markdown>
    </div>
  )
}

export function ListSection({ values, ordered }: { values: string[]; ordered?: boolean }) {
  if (!values?.length) return null
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag className={`text-sm text-foreground/80 ${ordered ? 'list-decimal' : 'list-disc'} list-inside space-y-0.5`}>
      {values.map((v, i) => (
        <li key={i}>{v}</li>
      ))}
    </Tag>
  )
}

export function TableSection({ columns, rows }: { columns: string[]; rows: string[][] }) {
  if (!columns?.length || !rows?.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="text-sm w-full">
        <thead>
          <tr className="border-b">
            {columns.map((col, i) => (
              <th key={i} className="text-left text-muted-foreground py-1 px-2 font-medium">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-border/50">
              {row.map((cell, ci) => (
                <td key={ci} className="text-foreground/80 py-1 px-2">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ProgressSection({
  label,
  current,
  max,
}: {
  label: string
  current: number
  max: number
}) {
  const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>
          {current}/{max}
        </span>
      </div>
      <div className="w-full bg-muted rounded-full h-2">
        <div
          className="bg-primary h-2 rounded-full transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export function TagsSection({ values }: { values: string[] }) {
  if (!values?.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((tag, i) => (
        <span
          key={i}
          className="text-xs bg-muted text-foreground/80 px-2 py-0.5 rounded-full"
        >
          {tag}
        </span>
      ))}
    </div>
  )
}
