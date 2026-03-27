import { useEffect, useState } from 'react'
import { Save, Bug, Plus, RefreshCcw, XCircle, MonitorPlay, History } from 'lucide-react'
import type { Session } from '../../types'
import { useSessionStore } from '../../stores/sessionStore'
import { useGameDataStore } from '../../stores/gameDataStore'
import { useProjectStore } from '../../stores/projectStore'
import { useBlockSchemaStore } from '../../stores/blockSchemaStore'
import { useNotificationStore } from '../../stores/notificationStore'
import { ChatMessages } from './ChatMessages'
import { ChatInput } from './ChatInput'
import { SceneBar } from './SceneBar'
import { QuickActions } from './QuickActions'
import { ArchiveRestoreModal } from './ArchiveRestoreModal'
import { WelcomeScreen } from './WelcomeScreen'
import { DebugLogPanel } from './DebugLogPanel'
import { SessionSelector } from './SessionSelector'
import type { LlmInfo } from '../../services/api'
import * as api from '../../services/api'
import { useTokenStore } from '../../stores/tokenStore'
import { useUiStore } from '../../stores/uiStore'
import { TokenUsageBar } from './TokenUsageBar'
import { useGameWebSocket } from '../../hooks/useGameWebSocket'
import { useGameActions } from '../../hooks/useGameActions'
import { useArchive } from '../../hooks/useArchive'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Alert, AlertDescription } from '@/components/ui/alert'

const gamePanelText: Record<string, Record<string, string>> = {
  zh: {
    noSession: '无活跃存档',
    selectSession: '选择或创建存档以开始',
    gameSession: '游戏存档',
    save: '存档',
    restore: '恢复',
    debug: '调试',
    saveTip: '手动生成一个存档版本',
    restoreTip: '恢复到任意历史版本',
    debugTip: '切换调试日志',
  },
  en: {
    noSession: 'No Active Session',
    selectSession: 'Select or create a session to begin',
    gameSession: 'Game Session',
    save: 'Save',
    restore: 'Restore',
    debug: 'Debug',
    saveTip: 'Manually create an archive version',
    restoreTip: 'Restore to any previous version',
    debugTip: 'Toggle debug log',
  },
}

interface Props {
  currentSession: Session | null
  onNewSession: () => void
  llmInfo?: LlmInfo | null
}

export function GamePanel({ currentSession, onNewSession, llmInfo }: Props) {
  const [showDebugLog, setShowDebugLog] = useState(false)
  const { currentProject } = useProjectStore()
  const language = useUiStore((s) => s.language)
  const gpt = gamePanelText[language] ?? gamePanelText.en
  const {
    sessions,
    messages,
    isStreaming,
    phase,
    pluginProcessing,
    switchSession,
    deleteSession,
  } = useSessionStore()
  const { currentScene, scenes, setScenes, setCurrentScene } = useGameDataStore()
  const { setCharacters, setWorldState, setEvents } = useGameDataStore()

  // Fetch block schemas when project changes
  const { fetchSchemas, clear: clearSchemas } = useBlockSchemaStore()
  useEffect(() => {
    if (currentProject?.id) {
      fetchSchemas(currentProject.id)
    } else {
      clearSchemas()
    }
  }, [currentProject?.id, fetchSchemas, clearSchemas])


  // Hydrate notifications from messages
  useEffect(() => {
    if (!currentSession) {
      useNotificationStore.getState().clear()
      return
    }
    useNotificationStore.getState().hydrateFromMessages(currentSession.id, messages)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.id, messages])

  // Defensive clear for init sessions
  useEffect(() => {
    if (!currentSession) return
    if (currentSession.phase !== 'init') return
    setScenes([])
    setCurrentScene(null)
    setEvents([])
    setCharacters([])
    setWorldState({})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.id, currentSession?.phase, setScenes, setCurrentScene, setEvents, setCharacters, setWorldState])

  const { wsRef, wsStatus, initError, clearInitError } = useGameWebSocket(currentSession)
  const {
    handleSend,
    handleInitGame,
    handleRetry,
    handleForceTrigger,
    handleGenerateImage,
    handleSceneSwitch,
    handleRetriggerPlugins,
  } = useGameActions(currentSession, wsRef, clearInitError)
  const {
    archiveVersions,
    archiveBusy,
    showRestoreModal,
    setShowRestoreModal,
    handleArchiveNow,
    handleRestoreArchive,
    handleRestoreVersion,
  } = useArchive(currentSession)

  const effectiveModel = llmInfo?.model || ''
  const effectiveProvider = llmInfo?.provider || 'openai'
  const effectiveModelName = llmInfo?.model_name || ''

  const setModelInfo = useTokenStore((s) => s.setModelInfo)

  useEffect(() => {
    if (!effectiveModel) return
    api.getModelInfo(effectiveModel).then((info) => {
      setModelInfo({
        model: info.model,
        maxInputTokens: info.max_input_tokens,
        maxOutputTokens: info.max_output_tokens,
        maxInputTokensDisplay: info.max_input_tokens_display,
        inputCostPerToken: info.input_cost_per_token,
        outputCostPerToken: info.output_cost_per_token,
        known: info.known,
      })
    }).catch((err) => {
      console.warn('[GamePanel] failed to fetch model info:', err)
    })
  }, [effectiveModel, setModelInfo])

  const modelBadge = effectiveModel ? (
    <Badge variant="outline" className="text-[10px] font-mono font-normal tracking-tight h-5 truncate max-w-[200px]" title={effectiveModel}>
      {effectiveProvider}/{effectiveModelName}
    </Badge>
  ) : null

  if (!currentSession) {
    return (
      <div className="h-full flex flex-col overflow-hidden bg-background relative">
        <div className="@container h-12 flex items-center justify-between px-4 bg-muted/20 border-b shrink-0 z-10">
          <div className="flex items-center gap-2 min-w-0">
            <MonitorPlay className="w-4 h-4 text-muted-foreground shrink-0" />
            <span className="hidden @md:inline text-sm font-semibold truncate">{gpt.noSession}</span>
            <span className="hidden @md:inline">{modelBadge}</span>
            <span className="hidden @md:inline-flex"><TokenUsageBar /></span>
          </div>
          <SessionSelector
            sessions={sessions}
            currentSession={null}
            onSwitch={(s) => switchSession(s)}
            onNew={onNewSession}
            onDelete={(id) => deleteSession(id)}
          />
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
          <MonitorPlay className="w-12 h-12 mb-4 opacity-20" />
          <p className="text-sm font-medium">{gpt.selectSession}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background relative">
      <div className="@container h-12 flex items-center justify-between px-4 bg-muted/20 border-b shrink-0 z-10">
        <div className="flex items-center gap-2 min-w-0">
          <MonitorPlay className="w-4 h-4 text-primary shrink-0" />
          <span className="hidden @md:inline text-sm font-semibold truncate">{gpt.gameSession}</span>
          <span className="hidden @md:inline">{modelBadge}</span>
          <span className="hidden @md:inline-flex"><TokenUsageBar /></span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5 px-2.5"
                onClick={handleArchiveNow}
                disabled={archiveBusy || !currentSession}
              >
                {archiveBusy ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                <span className="hidden @md:inline">{gpt.save}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{gpt.saveTip}</p></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5 px-2.5"
                onClick={handleRestoreArchive}
                disabled={archiveBusy || !currentSession}
              >
                <History className="w-3.5 h-3.5" />
                <span className="hidden @md:inline">{gpt.restore}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{gpt.restoreTip}</p></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showDebugLog ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs gap-1.5 px-2.5"
                onClick={() => setShowDebugLog((v) => !v)}
              >
                <Bug className="w-3.5 h-3.5" />
                <span className="hidden @md:inline">{gpt.debug}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent><p>{gpt.debugTip}</p></TooltipContent>
          </Tooltip>

          <div className="h-4 w-px bg-border mx-1" />
          
          <SessionSelector
            sessions={sessions}
            currentSession={currentSession}
            onSwitch={(s) => switchSession(s)}
            onNew={onNewSession}
            onDelete={(id) => deleteSession(id)}
          />
        </div>
      </div>

      {wsStatus !== 'connected' && (
        <Alert
          variant={wsStatus === 'reconnecting' ? "default" : "destructive"}
          className={`rounded-none border-x-0 border-t-0 shrink-0 py-2.5 px-4 shadow-sm ${wsStatus === 'disconnected' ? 'border-destructive/50 bg-destructive/10 text-destructive' : 'bg-muted/40'}`}
        >
          <div className="col-start-2 flex items-center gap-2.5 text-xs font-medium">
            {wsStatus === 'reconnecting' ? (
              <RefreshCcw className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <XCircle className="w-4 h-4" />
            )}
            <AlertDescription className={`mt-0 text-[13px] leading-normal ${wsStatus === 'disconnected' ? 'font-semibold text-current' : 'text-xs'}`}>
              {wsStatus === 'reconnecting' ? '正在重连后端...' : '连接已断开，请检查后端服务是否运行'}
            </AlertDescription>
          </div>
        </Alert>
      )}

      <div className="flex-1 relative flex flex-col min-h-0 overflow-hidden">
        {phase === 'init' && <WelcomeScreen onStart={handleInitGame} loading={isStreaming} error={initError} />}

        {phase === 'ended' && (
          <div className="flex flex-col h-full">
            <ChatMessages onAction={handleSend} onRetry={handleRetry} onGenerateImage={handleGenerateImage} onRetriggerPlugins={handleRetriggerPlugins} />
            <div className="px-4 py-4 bg-muted/30 border-t text-center shrink-0">
              <p className="text-muted-foreground text-sm mb-3">游戏结束</p>
              <Button onClick={onNewSession} className="gap-2">
                <Plus className="w-4 h-4" /> 开始新游戏
              </Button>
            </div>
          </div>
        )}

        {(phase === 'character_creation' || phase === 'playing') && (
          <div className="flex flex-col h-full">
            {currentScene && (
              <SceneBar currentScene={currentScene} scenes={scenes} onSceneSwitch={handleSceneSwitch} />
            )}
            <ChatMessages onAction={handleSend} onRetry={handleRetry} onGenerateImage={handleGenerateImage} onRetriggerPlugins={handleRetriggerPlugins} />
            <QuickActions onTrigger={handleForceTrigger} disabled={isStreaming || pluginProcessing} />
            <ChatInput onSend={handleSend} disabled={isStreaming || pluginProcessing} />
          </div>
        )}

        {showDebugLog && currentSession && (
          <DebugLogPanel sessionId={currentSession.id} onClose={() => setShowDebugLog(false)} />
        )}
      </div>

      {showRestoreModal && (
        <ArchiveRestoreModal
          versions={archiveVersions}
          onSelect={handleRestoreVersion}
          onClose={() => setShowRestoreModal(false)}
        />
      )}
    </div>
  )
}
