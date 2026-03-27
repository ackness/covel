import { useEffect, useState, useRef, useCallback } from 'react'
import type { PanelImperativeHandle } from 'react-resizable-panels'
import { useParams, Link } from 'react-router-dom'
import { FileText, MessageSquare, Settings, BookOpen, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Terminal, Database } from 'lucide-react'
import { useProjectStore } from '../stores/projectStore'
import { useSessionStore } from '../stores/sessionStore'
import { useUiStore } from '../stores/uiStore'
import { MarkdownEditor } from '../components/editor/MarkdownEditor'
import { InitPromptEditor } from '../components/editor/InitPromptEditor'
import { ModelSettings } from '../components/editor/ModelSettings'
import { NovelPanel } from '../components/editor/NovelPanel'
import { GamePanel } from '../components/game/GamePanel'
import { SidePanel } from '../components/status/SidePanel'
import { decideSessionBootstrap } from '../utils/sessionBootstrap'
import type { LlmInfo } from '../services/api'
import * as api from '../services/api'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Loader2 } from 'lucide-react'

const editorUiText: Record<string, Record<string, string>> = {
  zh: {
    worldDoc: '世界文档',
    initPrompt: '初始提示',
    model: '模型',
    novel: '小说',
    status: '状态',
    loading: '加载项目中...',
    expandEditor: '展开编辑区',
    collapseEditor: '收起编辑区',
    expandStatus: '展开状态栏',
    collapseStatus: '收起状态栏',
  },
  en: {
    worldDoc: 'World Doc',
    initPrompt: 'Init Prompt',
    model: 'Model',
    novel: 'Novel',
    status: 'Status',
    loading: 'Loading project...',
    expandEditor: 'Expand editor',
    collapseEditor: 'Collapse editor',
    expandStatus: 'Expand status',
    collapseStatus: 'Collapse status',
  },
}

export function ProjectEditorPage() {
  const { id } = useParams<{ id: string }>()
  const { currentProject, selectProject, loading } = useProjectStore()
  const { sessions, fetchSessions, createSession, currentSession, setCurrentSession, fetchMessages } = useSessionStore()
  
  // Panel states
  const [leftCollapsed, setLeftCollapsed] = useState(false)
  const [rightCollapsed, setRightCollapsed] = useState(false)
  const leftPanelRef = useRef<PanelImperativeHandle | null>(null)
  const rightPanelRef = useRef<PanelImperativeHandle | null>(null)
  
  const [sessionsFetched, setSessionsFetched] = useState(false)
  const [llmInfo, setLlmInfo] = useState<LlmInfo | null>(null)
  
  // Use ref to track if we've checked sessions
  const sessionsCheckedRef = useRef(false)
  const [autoCreating, setAutoCreating] = useState(false)

  const { language } = useUiStore()
  const et = editorUiText[language] ?? editorUiText.en

  useEffect(() => {
    sessionsCheckedRef.current = false
    setSessionsFetched(false)
    if (id) {
      selectProject(id)
      fetchSessions(id).finally(() => setSessionsFetched(true))
    }
  }, [id, selectProject, fetchSessions])

  useEffect(() => {
    const decision = decideSessionBootstrap({
      projectId: id,
      loading,
      autoCreating,
      sessionsFetched,
      checked: sessionsCheckedRef.current,
      sessions,
      currentSession,
    })
    
    if (!decision.reuseSession && !decision.shouldCreate) return

    sessionsCheckedRef.current = true

    if (decision.reuseSession) {
      setCurrentSession(decision.reuseSession)
      return
    }

    if (decision.shouldCreate && id) {
      setAutoCreating(true)
      createSession(id).finally(() => setAutoCreating(false))
    }
  }, [id, loading, sessions, autoCreating, createSession, currentSession, setCurrentSession, sessionsFetched])

  // Auto-select active session
  useEffect(() => {
    if (!id || !sessionsFetched || sessions.length === 0 || currentSession) return
    const active = sessions.find((s) => s.status === 'active')
    if (active) {
      setCurrentSession(active)
      fetchMessages(active.id)
    }
  }, [sessions, id, currentSession, setCurrentSession, fetchMessages, sessionsFetched])


  // Fetch llmInfo directly so it's available even before ModelSettings tab is opened
  useEffect(() => {
    if (!currentProject?.id) return
    api.getLlmInfo(currentProject.id).then(setLlmInfo).catch((err) => console.warn('[editor] getLlmInfo', err))
  }, [currentProject?.id])

  const handleLlmInfoChange = useCallback((info: LlmInfo | null) => setLlmInfo(info), [])

  const handleNewSession = async () => {
    if (!id) return
    await createSession(id)
  }

  if (loading || !currentProject) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground gap-4 bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <span className="text-sm font-medium">{et.loading}</span>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-hidden bg-background flex flex-col">
      <div className="h-12 border-b flex items-center justify-between px-4 shrink-0 bg-muted/20">
        <div className="flex items-center gap-2">
          <Button 
            variant="ghost" 
            size="icon" 
            className="h-8 w-8"
            onClick={() => {
              if (leftCollapsed) {
                leftPanelRef.current?.expand()
                setLeftCollapsed(false)
              } else {
                leftPanelRef.current?.collapse()
                setLeftCollapsed(true)
              }
            }}
            title={leftCollapsed ? et.expandEditor : et.collapseEditor}
          >
            {leftCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
          <div className="h-4 w-px bg-border mx-2" />
          <h2 className="text-sm font-semibold truncate max-w-[200px] md:max-w-md">
            {currentProject.name}
          </h2>
        </div>
        
        <div className="flex items-center gap-1">
          {currentSession && (
            <Link to={`/debug/session/${currentSession.id}`} target="_blank">
              <Button variant="ghost" size="icon" className="h-8 w-8" title="数据库浏览器">
                <Database className="h-4 w-4" />
              </Button>
            </Link>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => {
              if (rightCollapsed) {
                rightPanelRef.current?.expand()
                setRightCollapsed(false)
              } else {
                rightPanelRef.current?.collapse()
                setRightCollapsed(true)
              }
            }}
            title={rightCollapsed ? et.expandStatus : et.collapseStatus}
          >
            {rightCollapsed ? <PanelRightOpen className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <ResizablePanelGroup direction="horizontal" style={{ flex: '1 1 0', minHeight: 0, height: 'auto' }}>
        {/* Left Panel - Editor */}
        <ResizablePanel
          id="editor"
          defaultSize="32%"
          minSize="22%"
          maxSize="50%"
          collapsible
          collapsedSize="0%"
          panelRef={leftPanelRef}
          onResize={(size) => setLeftCollapsed(size.asPercentage < 1)}
        >
          <div className="h-full flex flex-col overflow-hidden">
            <Tabs defaultValue="world" className="flex-1 flex flex-col min-h-0">
              <div className="@container h-12 px-4 border-b bg-muted/10 shrink-0 flex items-center">
                <TabsList className="w-full justify-start h-9 p-1">
                  <TabsTrigger value="world" className="text-xs flex-1" title={et.worldDoc}>
                    <FileText className="w-3 h-3 shrink-0 @sm:mr-1.5" />
                    <span className="hidden @sm:inline">{et.worldDoc}</span>
                  </TabsTrigger>
                  <TabsTrigger value="prompt" className="text-xs flex-1" title={et.initPrompt}>
                    <Terminal className="w-3 h-3 shrink-0 @sm:mr-1.5" />
                    <span className="hidden @sm:inline">{et.initPrompt}</span>
                  </TabsTrigger>
                  <TabsTrigger value="model" className="text-xs flex-1 relative">
                    <Settings className="w-3 h-3 shrink-0 @sm:mr-1.5" />
                    <span className="hidden @sm:inline">{et.model}</span>
                    {llmInfo && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary" title={llmInfo.model_name} />}
                  </TabsTrigger>
                  <TabsTrigger value="novel" className="text-xs flex-1" title={et.novel}>
                    <BookOpen className="w-3 h-3 shrink-0 @sm:mr-1.5" />
                    <span className="hidden @sm:inline">{et.novel}</span>
                  </TabsTrigger>
                </TabsList>
              </div>
              <div className="flex-1 overflow-hidden relative">
                <TabsContent value="world" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden"><MarkdownEditor /></TabsContent>
                <TabsContent value="prompt" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden"><InitPromptEditor /></TabsContent>
                <TabsContent value="model" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-hidden">
                  <ModelSettings onLlmInfoChange={handleLlmInfoChange} />
                </TabsContent>
                <TabsContent value="novel" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden"><NovelPanel /></TabsContent>
              </div>
            </Tabs>
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Center Panel - Game Chat */}
        <ResizablePanel
          id="game"
          defaultSize="40%"
          minSize="25%"
        >
          <div className="h-full flex flex-col overflow-hidden">
            <GamePanel
              currentSession={currentSession}
              onNewSession={handleNewSession}
              llmInfo={llmInfo}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right Panel - Status */}
        <ResizablePanel
          id="status"
          defaultSize="28%"
          minSize="22%"
          maxSize="45%"
          collapsible
          collapsedSize="0%"
          panelRef={rightPanelRef}
          onResize={(size) => setRightCollapsed(size.asPercentage < 1)}
        >
          <div className="h-full flex flex-col overflow-hidden">
            <div className="h-12 border-b flex items-center px-4 shrink-0 bg-muted/20">
              <span className="text-sm font-semibold flex items-center text-muted-foreground">
                <MessageSquare className="w-4 h-4 mr-2" />
                {et.status}
              </span>
            </div>
            <SidePanel />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
