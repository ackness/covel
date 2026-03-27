import { useState, useEffect, useRef, useCallback } from 'react'
import { getDebugPrompt, type DebugPromptResponse } from '../../services/api'

type TabView = 'log' | 'prompt'

interface LogEntry {
  ts: string
  dir: 'send' | 'recv' | 'debug'
  payload: Record<string, unknown>
}

interface Props {
  sessionId: string
  onClose: () => void
}

export function DebugLogPanel({ sessionId, onClose }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [showChunks, setShowChunks] = useState(false)
  const [activeTab, setActiveTab] = useState<TabView>('log')
  const [promptData, setPromptData] = useState<DebugPromptResponse | null>(null)
  const [promptLoading, setPromptLoading] = useState(false)

  // Dragging state
  const [pos, setPos] = useState({ x: window.innerWidth - 520, y: window.innerHeight - 420 })
  const [size, setSize] = useState({ w: 480, h: 380 })
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      setPos({
        x: dragRef.current.origX + (ev.clientX - dragRef.current.startX),
        y: dragRef.current.origY + (ev.clientY - dragRef.current.startY),
      })
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [pos])

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h }
    const onMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      setSize({
        w: Math.max(320, resizeRef.current.origW + (ev.clientX - resizeRef.current.startX)),
        h: Math.max(200, resizeRef.current.origH + (ev.clientY - resizeRef.current.startY)),
      })
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [size])

  const loadPrompt = useCallback(async () => {
    setPromptLoading(true)
    try {
      const data = await getDebugPrompt(sessionId)
      setPromptData(data)
    } catch {
      setPromptData({ error: 'Failed to load prompt', model: '', api_base: null, source: '', enabled_plugins: [], messages: [], total_chars: 0, message_count: 0 })
    } finally {
      setPromptLoading(false)
    }
  }, [sessionId])

  // Auto-load prompt when switching to prompt tab
  useEffect(() => {
    if (activeTab === 'prompt' && !promptData && !promptLoading) {
      loadPrompt()
    }
  }, [activeTab, promptData, promptLoading, loadPrompt])

  // Fetch existing logs + connect to live stream
  useEffect(() => {
    const accessKey = String(import.meta.env.VITE_ACCESS_KEY || '').trim()
    const authHeaders = accessKey ? { 'X-Access-Key': accessKey } : undefined

    fetch(`/api/sessions/${sessionId}/debug-log`, {
      headers: authHeaders,
    })
      .then((r) => {
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`)
        }
        return r
      })
      .then((r) => r.json())
      .then((data: LogEntry[]) => setLogs(data))
      .catch((err) => console.warn('[debugLog] fetch', err))

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const query = accessKey ? `?access_key=${encodeURIComponent(accessKey)}` : ''
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws/debug-log/${sessionId}${query}`)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onmessage = (event) => {
      try {
        const entry: LogEntry = JSON.parse(event.data)
        setLogs((prev) => [...prev.slice(-199), entry])
      } catch {
        // ignore
      }
    }

    return () => {
      ws.close()
      wsRef.current = null
    }
  }, [sessionId])

  // Auto scroll
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logs, autoScroll])

  const formatPayload = (payload: Record<string, unknown>) => {
    try {
      return JSON.stringify(payload, null, 2)
    } catch {
      return String(payload)
    }
  }

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts)
      return d.toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 })
    } catch {
      return ts
    }
  }

  return (
    <div
      ref={panelRef}
      className="fixed z-[9999] flex flex-col bg-popover border rounded-lg shadow-2xl text-foreground text-xs font-mono"
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
    >
      {/* Draggable header */}
      <div
        onMouseDown={handleDragStart}
        className="flex items-center justify-between px-3 py-1.5 bg-muted/50 border-b rounded-t-lg cursor-move select-none shrink-0"
      >
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('log')}
            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
              activeTab === 'log' ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Log
          </button>
          <button
            onClick={() => setActiveTab('prompt')}
            className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
              activeTab === 'prompt' ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            Prompt
          </button>
          {activeTab === 'log' && (
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'log' && (
            <>
              <label className="flex items-center gap-1 text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={showChunks}
                  onChange={(e) => setShowChunks(e.target.checked)}
                  className="accent-emerald-500"
                />
                Chunks
              </label>
              <label className="flex items-center gap-1 text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                  className="accent-emerald-500"
                />
                Auto
              </label>
              <button
                onClick={() => setLogs([])}
                className="px-2 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded"
              >
                Clear
              </button>
            </>
          )}
          {activeTab === 'prompt' && (
            <button
              onClick={() => { setPromptData(null); loadPrompt() }}
              disabled={promptLoading}
              className="px-2 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted rounded disabled:opacity-50"
            >
              {promptLoading ? 'Loading...' : 'Refresh'}
            </button>
          )}
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">&times;</button>
        </div>
      </div>

      {/* Log entries */}
      {activeTab === 'log' && (
        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-0.5">
          {logs.length === 0 && (
            <div className="text-muted-foreground/50 text-center py-4">No log entries yet. Send a message to see events.</div>
          )}
          {logs.filter((entry) => showChunks || (entry.payload?.type as string) !== 'chunk').map((entry, i) => {
            const isSend = entry.dir === 'send'
            const type = (entry.payload?.type as string) || '?'
            const preview = entry.payload?.preview
            const content = entry.payload?.content
            return (
              <details key={i} className="group">
                <summary className="flex items-center gap-2 py-0.5 px-1 rounded cursor-pointer hover:bg-muted/50">
                  <span className="text-muted-foreground/50 w-20 shrink-0">{formatTime(entry.ts)}</span>
                  <span className={`w-4 text-center ${entry.dir === 'debug' ? 'text-purple-400' : isSend ? 'text-blue-400' : 'text-amber-400'}`}>
                    {entry.dir === 'debug' ? '\u2699' : isSend ? '\u2191' : '\u2193'}
                  </span>
                  <span className={`px-1.5 py-0 rounded text-[10px] font-medium ${
                    type === 'error' ? 'bg-red-900/50 text-red-400' :
                    type === 'done' ? 'bg-emerald-900/50 text-emerald-400' :
                    type === 'chunk' ? 'bg-muted text-muted-foreground' :
                    type === 'phase_change' ? 'bg-purple-900/50 text-purple-400' :
                    type === 'narrative_prompt' ? 'bg-indigo-900/50 text-indigo-400' :
                    type === 'plugin_agent_result' ? 'bg-cyan-900/50 text-cyan-400' :
                    type === 'plugin_agent_trace' ? 'bg-teal-900/50 text-teal-400' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    {type}
                  </span>
                  {type === 'done' && preview != null && (
                    <span className="text-muted-foreground/50 truncate">{String(preview).slice(0, 80)}</span>
                  )}
                  {type === 'message' && content != null && (
                    <span className="text-muted-foreground/50 truncate">{String(content).slice(0, 80)}</span>
                  )}
                </summary>
                <pre className="ml-8 mr-2 mb-1 p-2 bg-muted/50 rounded text-[11px] text-foreground/70 overflow-x-auto whitespace-pre-wrap break-all">
                  {formatPayload(entry.payload)}
                </pre>
              </details>
            )
          })}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Prompt preview */}
      {activeTab === 'prompt' && (
        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-2">
          {promptLoading && !promptData && (
            <div className="text-muted-foreground/50 text-center py-4">Loading prompt...</div>
          )}
          {promptData?.error && (
            <div className="text-red-400 text-center py-4">{promptData.error}</div>
          )}
          {promptData && !promptData.error && (
            <>
              {/* Summary badges */}
              <div className="flex flex-wrap gap-1.5 py-1">
                <span className="bg-blue-900/40 text-blue-300 px-2 py-0.5 rounded text-[10px]">
                  {promptData.model || 'no model'}
                </span>
                <span className="bg-violet-900/40 text-violet-300 px-2 py-0.5 rounded text-[10px]">
                  {promptData.source}
                </span>
                <span className="bg-emerald-900/40 text-emerald-300 px-2 py-0.5 rounded text-[10px]">
                  {promptData.message_count} msgs
                </span>
                <span className="bg-amber-900/40 text-amber-300 px-2 py-0.5 rounded text-[10px]">
                  {promptData.total_chars.toLocaleString()} chars
                </span>
              </div>

              {/* Enabled plugins */}
              {promptData.enabled_plugins.length > 0 && (
                <div className="flex flex-wrap gap-1 py-0.5">
                  <span className="text-muted-foreground text-[10px]">Plugins:</span>
                  {promptData.enabled_plugins.map((p) => (
                    <span key={p} className="bg-muted text-muted-foreground px-1.5 py-0 rounded text-[10px]">{p}</span>
                  ))}
                </div>
              )}

              {/* Narrative Prompt Messages */}
              <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider pt-1">Narrative Prompt</div>
              {promptData.messages.map((msg, i) => (
                <details key={i} open={i === 0}>
                  <summary className="flex items-center gap-2 py-0.5 px-1 rounded cursor-pointer hover:bg-muted/50">
                    <span className={`px-1.5 py-0 rounded text-[10px] font-medium ${
                      msg.role === 'system' ? 'bg-purple-900/50 text-purple-400' :
                      msg.role === 'user' ? 'bg-blue-900/50 text-blue-400' :
                      'bg-emerald-900/50 text-emerald-400'
                    }`}>
                      {msg.role}
                    </span>
                    <span className="text-muted-foreground/50 text-[10px]">{msg.length.toLocaleString()} chars</span>
                    <span className="text-muted-foreground/50 truncate text-[10px]">
                      {msg.content.slice(0, 100)}
                    </span>
                  </summary>
                  <pre className="ml-4 mr-2 mb-1 p-2 bg-muted/50 rounded text-[11px] text-foreground/70 overflow-x-auto whitespace-pre-wrap break-all">
                    {msg.content}
                  </pre>
                </details>
              ))}

              {/* Plugin Agent Section */}
              {promptData.plugin_agent && (
                <>
                  <div className="text-muted-foreground text-[10px] font-semibold uppercase tracking-wider pt-2 border-t border-border/50 mt-2">Plugin Agent</div>

                  {/* Agent Tools */}
                  <details>
                    <summary className="flex items-center gap-2 py-0.5 px-1 rounded cursor-pointer hover:bg-muted/50">
                      <span className="bg-cyan-900/50 text-cyan-400 px-1.5 py-0 rounded text-[10px] font-medium">tools</span>
                      <span className="text-muted-foreground/50 text-[10px]">{promptData.plugin_agent.tools.length} available</span>
                    </summary>
                    <div className="ml-4 mr-2 mb-1 space-y-0.5">
                      {promptData.plugin_agent.tools.map((t) => (
                        <div key={t.name} className="flex items-start gap-2 py-0.5">
                          <code className="bg-muted px-1 py-0 rounded text-[10px] text-cyan-300 shrink-0">{t.name}</code>
                          <span className="text-muted-foreground/60 text-[10px] truncate">{t.description}</span>
                        </div>
                      ))}
                    </div>
                  </details>

                  {/* Block Declarations */}
                  {Object.keys(promptData.plugin_agent.block_declarations).length > 0 && (
                    <details>
                      <summary className="flex items-center gap-2 py-0.5 px-1 rounded cursor-pointer hover:bg-muted/50">
                        <span className="bg-amber-900/50 text-amber-400 px-1.5 py-0 rounded text-[10px] font-medium">blocks</span>
                        <span className="text-muted-foreground/50 text-[10px]">{Object.keys(promptData.plugin_agent.block_declarations).length} declared</span>
                      </summary>
                      <div className="ml-4 mr-2 mb-1 space-y-0.5">
                        {Object.entries(promptData.plugin_agent.block_declarations).map(([name, decl]) => (
                          <div key={name} className="flex items-center gap-2 py-0.5">
                            <code className="bg-muted px-1 py-0 rounded text-[10px] text-amber-300">{name}</code>
                            <span className="text-muted-foreground/60 text-[10px]">({decl.plugin})</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {/* Agent System Prompt */}
                  <details>
                    <summary className="flex items-center gap-2 py-0.5 px-1 rounded cursor-pointer hover:bg-muted/50">
                      <span className="bg-purple-900/50 text-purple-400 px-1.5 py-0 rounded text-[10px] font-medium">system</span>
                      <span className="text-muted-foreground/50 text-[10px]">{promptData.plugin_agent.system_prompt.length.toLocaleString()} chars</span>
                      <span className="text-muted-foreground/50 truncate text-[10px]">Plugin Agent system prompt</span>
                    </summary>
                    <pre className="ml-4 mr-2 mb-1 p-2 bg-muted/50 rounded text-[11px] text-foreground/70 overflow-x-auto whitespace-pre-wrap break-all">
                      {promptData.plugin_agent.system_prompt}
                    </pre>
                  </details>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize"
        style={{ background: 'linear-gradient(135deg, transparent 50%, hsl(var(--border)) 50%)' }}
      />
    </div>
  )
}
