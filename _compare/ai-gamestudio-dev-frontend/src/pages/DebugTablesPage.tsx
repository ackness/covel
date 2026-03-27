import { useState, useEffect, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'

interface TableData {
  [key: string]: unknown
}

interface SessionTables {
  session: TableData
  tables: Record<string, TableData[]>
}

interface MetadataSections {
  blocks: unknown[]
  narrative: Record<string, unknown> | null
  plugins: Record<string, Record<string, unknown>>
}

const tableLabels: Record<string, string> = {
  characters: '角色 Characters',
  messages: '消息 Messages',
  scenes: '场景 Scenes',
  scene_npcs: '场景NPC Scene NPCs',
  events: '事件 Events',
  plugin_storage: '插件存储 Plugin Storage',
  game_logs: '游戏日志 Game Logs',
  game_kvs: '键值存储 Game KV',
  game_graphs: '关系图 Game Graph',
  audit_logs: '审计日志 Audit Logs',
}

function JsonCell({ value, maxLen = 80 }: { value: unknown; maxLen?: number }) {
  const [expanded, setExpanded] = useState(false)
  const toggle = () => setExpanded((v) => !v)

  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/40">null</span>
  }
  if (typeof value === 'boolean') {
    return <span className={value ? 'text-emerald-400' : 'text-red-400'}>{String(value)}</span>
  }
  if (typeof value === 'number') {
    return <span className="text-cyan-400">{value}</span>
  }
  if (typeof value === 'string') {
    if (value.length > maxLen) {
      return (
        <div onDoubleClick={toggle} className="cursor-pointer" title="双击展开/收起">
          <span className="break-all">{expanded ? value : value.slice(0, maxLen) + '…'}</span>
        </div>
      )
    }
    return <span className="break-all">{value}</span>
  }
  if (typeof value === 'object') {
    const compact = JSON.stringify(value)
    if (compact.length > 60) {
      return (
        <div onDoubleClick={toggle} className="cursor-pointer" title="双击展开/收起">
          {expanded ? (
            <pre className="text-[11px] whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>
          ) : (
            <span className="text-[11px] text-muted-foreground truncate block max-w-xs">{compact.slice(0, 60)}…</span>
          )}
        </div>
      )
    }
    return <pre className="text-[11px] whitespace-pre-wrap break-all">{compact}</pre>
  }
  return <span>{String(value)}</span>
}

function DataTable({ rows, onRowClick, selectedIndex }: { rows: TableData[]; onRowClick?: (i: number) => void; selectedIndex?: number }) {
  if (rows.length === 0) {
    return <p className="text-muted-foreground text-sm py-4 text-center">空表</p>
  }

  const columns = Object.keys(rows[0])

  return (
    <div className="overflow-x-auto border rounded-lg">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50 border-b">
            {columns.map((col) => (
              <th key={col} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={i}
              onClick={() => {
                const sel = window.getSelection()
                if (sel && sel.toString().length > 0) return
                onRowClick?.(i)
              }}
              className={`border-b last:border-0 hover:bg-muted/30 ${onRowClick ? 'cursor-pointer' : ''} ${selectedIndex === i ? 'bg-primary/10' : ''}`}
            >
              {columns.map((col) => (
                <td key={col} className="px-3 py-2 align-top max-w-xs">
                  <JsonCell value={row[col]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Parse metadata_json into separate sections for display. */
function parseMetadataSections(meta: unknown): MetadataSections | null {
  if (!meta || typeof meta !== 'object') return null
  const m = meta as Record<string, unknown>
  const blocks = Array.isArray(m.blocks) ? m.blocks : []
  const llm = (m.llm_calls || {}) as Record<string, unknown>
  const narrative = (llm.narrative || null) as Record<string, unknown> | null
  const plugins = (llm.plugins || {}) as Record<string, Record<string, unknown>>
  return { blocks, narrative, plugins }
}

/** Collapsible section for metadata detail panel. */
function MetadataSection({ title, badge, data, defaultOpen = false }: {
  title: string
  badge?: string
  data: unknown
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  if (data === null || data === undefined) return null
  const json = JSON.stringify(data, null, 2)
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 bg-muted/30 hover:bg-muted/50 text-xs"
      >
        <span className="font-medium">{open ? '▼' : '▶'} {title}</span>
        <span className="text-muted-foreground text-[10px]">{badge || `${json.length} chars`}</span>
      </button>
      {open && (
        <pre className="text-[11px] p-3 overflow-auto max-h-96 whitespace-pre-wrap break-all bg-background">
          {json}
        </pre>
      )}
    </div>
  )
}

/** Detail panel showing split metadata for a selected message. */
function MessageMetadataPanel({ row }: { row: TableData }) {
  const meta = row.metadata_json
  const sections = parseMetadataSections(meta)
  if (!sections) {
    return <p className="text-muted-foreground text-xs py-2">无 metadata</p>
  }
  const pluginNames = Object.keys(sections.plugins)
  return (
    <div className="space-y-2 py-3">
      <div className="text-xs text-muted-foreground mb-1">
        消息 ID: <span className="font-mono">{String(row.id || '').slice(0, 8)}</span>
        {' · '}角色: {String(row.role)}
        {' · '}类型: {String(row.message_type || 'chat')}
      </div>
      {sections.blocks.length > 0 && (
        <MetadataSection
          title="Blocks (输出块)"
          badge={`${sections.blocks.length} 个`}
          data={sections.blocks}
          defaultOpen
        />
      )}
      {sections.narrative && (
        <MetadataSection
          title="Narrative LLM (主模型)"
          badge={sections.narrative.model ? String(sections.narrative.model) : undefined}
          data={sections.narrative}
        />
      )}
      {pluginNames.length > 0 && (
        <>
          <div className="text-xs text-muted-foreground pt-1">插件 LLM 调用 (旧数据):</div>
          {pluginNames.map((name) => (
            <MetadataSection
              key={name}
              title={`Plugin: ${name}`}
              badge={`${(sections.plugins[name]?.rounds as number) || 0} rounds`}
              data={sections.plugins[name]}
            />
          ))}
        </>
      )}
    </div>
  )
}

/** Detail panel for a selected audit log entry. */
function AuditLogDetailPanel({ row }: { row: TableData }) {
  let args: unknown = row.args_json
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { /* keep raw string */ }
  }

  return (
    <div className="space-y-2 py-3">
      <div className="text-xs text-muted-foreground mb-1">
        调用 ID: <span className="font-mono">{String(row.invocation_id || '').slice(0, 12)}</span>
        {' · '}插件: {String(row.plugin_name)}
        {' · '}能力: {String(row.capability)}
        {' · '}脚本: {String(row.script_path)}
        {' · '}耗时: {String(row.duration_ms)}ms
        {' · '}退出码: <span className={row.exit_code === 0 ? 'text-emerald-400' : 'text-red-400'}>
          {String(row.exit_code)}
        </span>
      </div>
      <MetadataSection title="参数 Args" data={args} />
      {Boolean(row.stdout) && <MetadataSection title="标准输出 stdout" data={row.stdout} defaultOpen />}
      {Boolean(row.stderr) && <MetadataSection title="标准错误 stderr" data={row.stderr} />}
    </div>
  )
}

/** Tables that support namespace/collection filtering. */
const FILTERABLE_TABLES = new Set(['game_kvs', 'game_logs', 'game_graphs', 'plugin_storage', 'audit_logs'])

/** Extract unique values for a field from rows. */
function uniqueValues(rows: TableData[], field: string): string[] {
  const set = new Set<string>()
  for (const r of rows) {
    const v = r[field]
    if (typeof v === 'string' && v) set.add(v)
  }
  return Array.from(set).sort()
}

/** The field used as "namespace" for each filterable table. */
function nsField(table: string): string {
  if (table === 'plugin_storage' || table === 'audit_logs') return 'plugin_name'
  return 'namespace'
}

function FilterBar({
  tableName,
  rows,
  nsFilter,
  setNsFilter,
  colFilter,
  setColFilter,
  keyFilter,
  setKeyFilter,
}: {
  tableName: string
  rows: TableData[]
  nsFilter: string
  setNsFilter: (v: string) => void
  colFilter: string
  setColFilter: (v: string) => void
  keyFilter: string
  setKeyFilter: (v: string) => void
}) {
  const ns = nsField(tableName)
  const namespaces = useMemo(() => uniqueValues(rows, ns), [rows, ns])
  const collections = useMemo(() => {
    const filtered = nsFilter ? rows.filter((r) => r[ns] === nsFilter) : rows
    return uniqueValues(filtered, 'collection')
  }, [rows, ns, nsFilter])
  const hasKey = tableName === 'game_kvs' || tableName === 'plugin_storage'

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select
        value={nsFilter}
        onChange={(e) => { setNsFilter(e.target.value); setColFilter('') }}
        className="bg-muted border rounded px-2 py-1 text-xs"
      >
        <option value="">全部插件</option>
        {namespaces.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      {collections.length > 0 && (
        <select
          value={colFilter}
          onChange={(e) => setColFilter(e.target.value)}
          className="bg-muted border rounded px-2 py-1 text-xs"
        >
          <option value="">全部 collection</option>
          {collections.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      {hasKey && (
        <input
          type="text"
          value={keyFilter}
          onChange={(e) => setKeyFilter(e.target.value)}
          placeholder="搜索 key..."
          className="bg-muted border rounded px-2 py-1 text-xs w-36"
        />
      )}
      {(nsFilter || colFilter || keyFilter) && (
        <button
          onClick={() => { setNsFilter(''); setColFilter(''); setKeyFilter('') }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          清除
        </button>
      )}
    </div>
  )
}

export function DebugTablesPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const [data, setData] = useState<SessionTables | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTable, setActiveTable] = useState<string>('characters')
  const [nsFilter, setNsFilter] = useState('')
  const [colFilter, setColFilter] = useState('')
  const [keyFilter, setKeyFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedMsgIdx, setSelectedMsgIdx] = useState<number | null>(null)
  const [selectedAuditIdx, setSelectedAuditIdx] = useState<number | null>(null)
  const [exitCodeFilter, setExitCodeFilter] = useState('')

  useEffect(() => {
    if (!sessionId) return
    setLoading(true)
    fetch(`/api/debug/session/${sessionId}/tables`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((d) => {
        if (d.error) {
          setError(d.error)
        } else {
          setData(d)
          const firstNonEmpty = Object.entries(d.tables).find(
            ([, rows]) => (rows as TableData[]).length > 0,
          )
          if (firstNonEmpty) setActiveTable(firstNonEmpty[0])
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [sessionId])

  const currentRows = data?.tables[activeTable] || []

  const filteredRows = useMemo(() => {
    let rows = currentRows
    // Apply namespace/collection/key filters for filterable tables
    if (FILTERABLE_TABLES.has(activeTable)) {
      const ns = nsField(activeTable)
      if (nsFilter) rows = rows.filter((r) => r[ns] === nsFilter)
      if (colFilter) rows = rows.filter((r) => r.collection === colFilter)
      if (keyFilter) {
        const q = keyFilter.toLowerCase()
        rows = rows.filter((r) => {
          const k = r.key
          return typeof k === 'string' && k.toLowerCase().includes(q)
        })
      }
    }
    // Apply exit_code filter for audit_logs
    if (activeTable === 'audit_logs' && exitCodeFilter) {
      if (exitCodeFilter === '0') {
        rows = rows.filter((r) => r.exit_code === 0)
      } else if (exitCodeFilter === 'non-zero') {
        rows = rows.filter((r) => r.exit_code !== 0)
      }
    }
    // Apply global text search
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      rows = rows.filter((r) =>
        Object.values(r).some((v) => {
          if (v === null || v === undefined) return false
          const s = typeof v === 'string' ? v : JSON.stringify(v)
          return s.toLowerCase().includes(q)
        }),
      )
    }
    return rows
  }, [currentRows, activeTable, nsFilter, colFilter, keyFilter, searchQuery, exitCodeFilter])

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">加载中...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="bg-card border border-red-700/50 rounded-xl p-6 max-w-lg space-y-3">
          <p className="text-red-400">错误: {error}</p>
          <p className="text-muted-foreground text-xs">
            确保后端已启用 DEBUG_ENDPOINTS_ENABLED=true
          </p>
          <Link to="/" className="text-primary text-sm hover:underline block">返回首页</Link>
        </div>
      </div>
    )
  }

  if (!data) return null

  const tableNames = Object.keys(data.tables)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b bg-card px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/" className="text-muted-foreground hover:text-foreground text-sm">
            ← 返回
          </Link>
          <h1 className="text-sm font-medium">数据库浏览器</h1>
          <span className="text-xs text-muted-foreground font-mono">
            session: {sessionId?.slice(0, 8)}...
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          phase: {String((data.session as Record<string, unknown>).phase || '')} |
          status: {String((data.session as Record<string, unknown>).status || '')}
        </div>
      </div>

      <div className="flex h-[calc(100vh-49px)]">
        {/* Sidebar */}
        <div className="w-48 border-r bg-muted/10 p-2 space-y-0.5 overflow-y-auto shrink-0">
          {tableNames.map((name) => {
            const count = data.tables[name].length
            return (
              <button
                key={name}
                onClick={() => { setActiveTable(name); setNsFilter(''); setColFilter(''); setKeyFilter(''); setSearchQuery(''); setSelectedMsgIdx(null); setSelectedAuditIdx(null); setExitCodeFilter('') }}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors flex items-center justify-between ${
                  activeTable === name
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                }`}
              >
                <span>{tableLabels[name] || name}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                  count > 0 ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          <div className="flex items-center justify-between mb-3 gap-4">
            <h2 className="text-sm font-medium shrink-0">
              {tableLabels[activeTable] || activeTable}
              <span className="text-muted-foreground ml-2">({filteredRows.length} 行)</span>
            </h2>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索..."
                className="bg-muted border rounded px-2 py-1 text-xs w-40"
              />
              {FILTERABLE_TABLES.has(activeTable) && (
                <FilterBar
                  tableName={activeTable}
                  rows={currentRows}
                  nsFilter={nsFilter}
                  setNsFilter={setNsFilter}
                  colFilter={colFilter}
                  setColFilter={setColFilter}
                  keyFilter={keyFilter}
                  setKeyFilter={setKeyFilter}
                />
              )}
              {activeTable === 'audit_logs' && (
                <select
                  value={exitCodeFilter}
                  onChange={(e) => setExitCodeFilter(e.target.value)}
                  className="bg-muted border rounded px-2 py-1 text-xs"
                >
                  <option value="">全部状态</option>
                  <option value="0">成功 (exit_code=0)</option>
                  <option value="non-zero">失败 (exit_code≠0)</option>
                </select>
              )}
            </div>
          </div>
          <DataTable
            rows={filteredRows}
            onRowClick={
              activeTable === 'messages' ? (i) => setSelectedMsgIdx(selectedMsgIdx === i ? null : i) :
              activeTable === 'audit_logs' ? (i) => setSelectedAuditIdx(selectedAuditIdx === i ? null : i) :
              undefined
            }
            selectedIndex={
              activeTable === 'messages' ? (selectedMsgIdx ?? undefined) :
              activeTable === 'audit_logs' ? (selectedAuditIdx ?? undefined) :
              undefined
            }
          />
          {activeTable === 'messages' && selectedMsgIdx !== null && filteredRows[selectedMsgIdx] && (
            <div className="mt-3 border rounded-lg p-4 bg-card">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium">消息详情 — metadata 拆分视图</span>
                <button onClick={() => setSelectedMsgIdx(null)} className="text-xs text-muted-foreground hover:text-foreground">关闭</button>
              </div>
              <MessageMetadataPanel row={filteredRows[selectedMsgIdx]} />
            </div>
          )}
          {activeTable === 'audit_logs' && selectedAuditIdx !== null && filteredRows[selectedAuditIdx] && (
            <div className="mt-3 border rounded-lg p-4 bg-card">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium">审计日志详情</span>
                <button onClick={() => setSelectedAuditIdx(null)} className="text-xs text-muted-foreground hover:text-foreground">关闭</button>
              </div>
              <AuditLogDetailPanel row={filteredRows[selectedAuditIdx]} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
