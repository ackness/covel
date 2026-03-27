import { useState } from 'react'
import { Users, AlertCircle, Globe, Puzzle, Settings, Clock, BookOpen, Scroll } from 'lucide-react'
import { CharacterPanel } from './CharacterPanel'
import { QuestPanel } from './QuestPanel'
import { PluginPanel } from '../plugins/PluginPanel'
import { EventPanel } from './EventPanel'
import { WorldStatePanel } from './WorldStatePanel'
import { NotificationPanel } from './NotificationPanel'
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel'
import { CodexPanel } from './CodexPanel'
import { useNotificationStore } from '../../stores/notificationStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

type Tab = 'characters' | 'quests' | 'events' | 'alerts' | 'world' | 'codex' | 'plugins' | 'settings'

interface TabDef { label: string; hint: string; icon: React.ElementType }

const tabDefs: Record<string, TabDef[]> = {
  zh: [
    { label: '角色', hint: '角色状态', icon: Users },
    { label: '任务', hint: '任务追踪', icon: Scroll },
    { label: '事件', hint: '事件时间线', icon: Clock },
    { label: '通知', hint: '通知与告警', icon: AlertCircle },
    { label: '世界', hint: '世界状态', icon: Globe },
    { label: '图鉴', hint: '百科全书', icon: BookOpen },
    { label: '插件', hint: '插件能力', icon: Puzzle },
    { label: '设置', hint: '运行时配置', icon: Settings },
  ],
  en: [
    { label: 'Characters', hint: 'Character status', icon: Users },
    { label: 'Quests', hint: 'Quest tracker', icon: Scroll },
    { label: 'Events', hint: 'Event timeline', icon: Clock },
    { label: 'Alerts', hint: 'Notifications', icon: AlertCircle },
    { label: 'World', hint: 'World state', icon: Globe },
    { label: 'Codex', hint: 'Encyclopedia', icon: BookOpen },
    { label: 'Plugins', hint: 'Plugin capabilities', icon: Puzzle },
    { label: 'Settings', hint: 'Runtime config', icon: Settings },
  ],
}

const tabKeys: Tab[] = ['characters', 'quests', 'events', 'alerts', 'world', 'codex', 'plugins', 'settings']

export function SidePanel() {
  const [activeTab, setActiveTab] = useState<Tab>('characters')
  const currentSessionId = useSessionStore((s) => s.currentSession?.id)
  const unreadAlerts = useNotificationStore(
    (s) => s.notifications.reduce((count, item) => count + (item.unread ? 1 : 0), 0),
  )
  const markAllRead = useNotificationStore((s) => s.markAllRead)
  const language = useUiStore((s) => s.language)
  const defs = tabDefs[language] ?? tabDefs.en

  const tabs = tabKeys.map((key, i) => ({ key, ...defs[i] }))

  const handleTabChange = (value: string) => {
    const tab = value as Tab
    setActiveTab(tab)
    if (tab === 'alerts' && currentSessionId) {
      markAllRead(currentSessionId)
    }
  }

  const gameTabs = tabs.slice(0, 6)
  const configTabs = tabs.slice(6)

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange} className="h-full flex overflow-hidden bg-background" orientation="vertical">
      {/* Icon nav column */}
      <div className="w-16 border-r shrink-0 bg-muted/20 overflow-y-auto flex flex-col">
        <TabsList className="flex flex-col h-auto w-full p-1.5 gap-1 bg-transparent justify-start">
          {gameTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <TabsTrigger
                key={tab.key}
                value={tab.key}
                title={tab.hint}
                className="w-full h-auto flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg data-[state=active]:bg-primary/10 data-[state=active]:text-primary relative group"
              >
                <Icon className="w-4 h-4 transition-all group-hover:scale-110 shrink-0" />
                <span className="text-[9px] leading-tight font-medium truncate w-full text-center">{tab.label}</span>
                {tab.key === 'alerts' && unreadAlerts > 0 && (
                  <span className="absolute top-1 right-1 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-destructive px-0.5 text-[8px] font-bold text-destructive-foreground">
                    {unreadAlerts > 9 ? '9+' : unreadAlerts}
                  </span>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>

        {/* Divider between game and config tabs */}
        <div className="mx-2 my-1 border-t border-border/50" />

        <TabsList className="flex flex-col h-auto w-full p-1.5 gap-1 bg-transparent justify-start">
          {configTabs.map((tab) => {
            const Icon = tab.icon
            return (
              <TabsTrigger
                key={tab.key}
                value={tab.key}
                title={tab.hint}
                className="w-full h-auto flex flex-col items-center gap-0.5 py-2 px-1 rounded-lg data-[state=active]:bg-muted data-[state=active]:text-foreground relative group text-muted-foreground/60"
              >
                <Icon className="w-4 h-4 transition-all group-hover:scale-110 shrink-0" />
                <span className="text-[9px] leading-tight font-medium truncate w-full text-center">{tab.label}</span>
              </TabsTrigger>
            )
          })}
        </TabsList>
      </div>

      {/* Content area */}
      <div className="flex-1 min-w-0 relative overflow-hidden">
        <TabsContent value="characters" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-y-auto p-3"><CharacterPanel /></TabsContent>
        <TabsContent value="quests" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-y-auto p-3"><QuestPanel /></TabsContent>
        <TabsContent value="events" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-y-auto p-3"><EventPanel /></TabsContent>
        <TabsContent value="alerts" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-y-auto p-3"><NotificationPanel /></TabsContent>
        <TabsContent value="world" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-y-auto p-3"><WorldStatePanel /></TabsContent>
        <TabsContent value="codex" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-y-auto p-3"><CodexPanel /></TabsContent>
        <TabsContent value="plugins" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-y-auto p-3"><PluginPanel /></TabsContent>
        <TabsContent value="settings" className="absolute inset-0 m-0 border-0 data-[state=inactive]:hidden overflow-y-auto p-3"><RuntimeSettingsPanel /></TabsContent>
      </div>
    </Tabs>
  )
}
