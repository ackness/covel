import { useState } from 'react'
import { Plus, Trash2, CheckCircle2, ChevronDown, Check } from 'lucide-react'
import type { Session } from '../../types'
import { useUiStore } from '../../stores/uiStore'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'

interface Props {
  sessions: Session[]
  currentSession: Session | null
  onSwitch: (session: Session) => void
  onNew: () => void
  onDelete: (sessionId: string) => void
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { month: '2-digit', day: '2-digit' }) +
    ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const phaseLabels: Record<string, Record<string, string>> = {
  zh: { init: '未开始', character_creation: '创建角色', playing: '进行中', ended: '已结束' },
  en: { init: 'Not Started', character_creation: 'Creating', playing: 'Playing', ended: 'Ended' },
}

const uiText: Record<string, Record<string, string>> = {
  zh: {
    sessions: '存档',
    noSessions: '暂无存档',
    newSession: '新存档',
    confirm: '确认删除?',
    deleteTitle: '删除存档',
    confirmTitle: '再次点击确认',
  },
  en: {
    sessions: 'Sessions',
    noSessions: 'No sessions yet',
    newSession: 'New Session',
    confirm: 'Confirm?',
    deleteTitle: 'Delete session',
    confirmTitle: 'Click again to confirm',
  },
}

export function SessionSelector({ sessions, currentSession, onSwitch, onNew, onDelete }: Props) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const language = useUiStore((s) => s.language)
  const t = uiText[language] ?? uiText.en
  const phases = phaseLabels[language] ?? phaseLabels.en

  const handleDelete = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation()
    e.preventDefault()
    if (confirmDelete === sessionId) {
      onDelete(sessionId)
      setConfirmDelete(null)
    } else {
      setConfirmDelete(sessionId)
      // Reset confirmation after 3 seconds
      setTimeout(() => setConfirmDelete(null), 3000)
    }
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs gap-1.5 px-1.5 @md:px-2.5">
          <span className="hidden @md:inline">{t.sessions}</span>
          <Badge variant="secondary" className="px-1 text-[10px] h-4 leading-none @md:ml-1">
            {sessions.length}
          </Badge>
          <ChevronDown className="w-3 h-3 opacity-50 ml-0.5" />
        </Button>
      </DropdownMenuTrigger>
      
      <DropdownMenuContent align="end" className="w-[300px] p-0">
        <div className="p-2 border-b bg-muted/20">
          <Button 
            onClick={() => {
              onNew()
              setOpen(false)
            }}
            size="sm" 
            className="w-full gap-2 text-xs"
          >
            <Plus className="w-3.5 h-3.5" />
            {t.newSession}
          </Button>
        </div>
        
        <ScrollArea className="max-h-[300px]">
          <div className="p-1">
            {sessions.length === 0 ? (
              <div className="px-4 py-6 text-center text-muted-foreground text-xs">
                {t.noSessions}
              </div>
            ) : (
              sessions.map((s) => {
                const isCurrent = s.id === currentSession?.id
                const isConfirming = confirmDelete === s.id
                
                return (
                  <DropdownMenuItem
                    key={s.id}
                    onSelect={(e) => {
                      if (!isCurrent && !isConfirming) {
                        onSwitch(s)
                      } else {
                        e.preventDefault()
                      }
                    }}
                    className={`flex items-start justify-between p-2 mb-1 cursor-pointer rounded-md ${
                      isCurrent ? 'bg-primary/10 data-[highlighted]:bg-primary/15' : ''
                    }`}
                  >
                    <div className="flex flex-col gap-1.5 min-w-0 flex-1 overflow-hidden pr-2">
                      <div className="flex items-center gap-2">
                        {isCurrent ? (
                          <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                        ) : (
                          <div className="w-3.5 h-3.5 shrink-0" />
                        )}
                        <span className={`truncate font-mono text-xs ${isCurrent ? 'text-primary font-medium' : ''}`}>
                          {s.id.slice(0, 8)}
                        </span>
                        <Badge 
                          variant="secondary" 
                          className={`px-1.5 py-0 text-[9px] font-normal leading-tight h-4 shrink-0 ${
                            s.phase === 'playing' ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-500/20' : 
                            s.phase === 'ended' ? 'opacity-70' : ''
                          }`}
                        >
                          {phases[s.phase] || s.phase}
                        </Badge>
                      </div>
                      <span className="text-[10px] text-muted-foreground pl-5 truncate">
                        {formatTime(s.created_at)}
                      </span>
                    </div>
                    
                    <Button
                      variant={isConfirming ? "destructive" : "ghost"}
                      size="icon"
                      className={`h-7 w-7 shrink-0 transition-all ${
                        isConfirming 
                          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' 
                          : 'opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive text-muted-foreground'
                      } ${open && !isConfirming ? 'group-data-[highlighted]:opacity-100' : ''}`}
                      onClick={(e) => handleDelete(e, s.id)}
                      title={isConfirming ? t.confirmTitle : t.deleteTitle}
                    >
                      {isConfirming ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Trash2 className="w-3.5 h-3.5" />}
                    </Button>
                  </DropdownMenuItem>
                )
              })
            )}
          </div>
        </ScrollArea>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
