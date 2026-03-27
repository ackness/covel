import { useState } from 'react'
import { History, GitFork, RotateCcw, Clock, AlertTriangle } from 'lucide-react'
import type { ArchiveVersion } from '../../types'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface Props {
  versions: ArchiveVersion[]
  onSelect: (version: number, mode: 'hard' | 'fork') => void
  onClose: () => void
}

export function ArchiveRestoreModal({ versions, onSelect, onClose }: Props) {
  const [mode, setMode] = useState<'hard' | 'fork'>('fork')

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px] max-h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-5 h-5 text-primary" />
            <DialogTitle>恢复存档</DialogTitle>
          </div>
          <DialogDescription>
            选择一个历史版本以恢复游戏进度
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4 border-b bg-muted/10 shrink-0 space-y-3">
          <div className="text-sm font-medium text-foreground">恢复模式</div>
          <div className="grid grid-cols-2 gap-3">
            <Button
              variant={mode === 'fork' ? 'default' : 'outline'}
              className="h-auto py-3 px-4 flex flex-col items-start gap-1 justify-start font-normal text-left"
              onClick={() => setMode('fork')}
            >
              <div className="flex items-center gap-2 font-medium w-full">
                <GitFork className="w-4 h-4" />
                分支恢复 (Fork)
                {mode === 'fork' && <Badge variant="secondary" className="ml-auto bg-primary-foreground/20 hover:bg-primary-foreground/20 text-primary-foreground">推荐</Badge>}
              </div>
              <span className={`text-xs ${mode === 'fork' ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                创建一个新会话分支，保留当前会话
              </span>
            </Button>
            
            <Button
              variant={mode === 'hard' ? 'destructive' : 'outline'}
              className={`h-auto py-3 px-4 flex flex-col items-start gap-1 justify-start font-normal text-left ${
                mode === 'hard' ? '' : 'hover:bg-destructive/5 hover:text-destructive hover:border-destructive/30'
              }`}
              onClick={() => setMode('hard')}
            >
              <div className="flex items-center gap-2 font-medium w-full">
                <RotateCcw className="w-4 h-4" />
                强制恢复 (Hard)
              </div>
              <span className={`text-xs ${mode === 'hard' ? 'text-destructive-foreground/80' : 'text-muted-foreground'}`}>
                覆盖并清空当前会话内容
              </span>
            </Button>
          </div>
          
          {mode === 'hard' && (
            <Alert variant="destructive" className="py-2 px-3 mt-2">
              <AlertTriangle className="w-4 h-4" />
              <AlertDescription className="text-xs ml-2">
                警告：强制恢复将永久覆盖当前会话中的所有进度，此操作不可逆。
              </AlertDescription>
            </Alert>
          )}
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-2">
            {versions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                暂无历史存档
              </div>
            ) : (
              versions.map((v) => (
                <Button
                  key={v.version}
                  variant="outline"
                  className="w-full h-auto flex flex-col items-start p-3 gap-2 justify-start font-normal hover:border-primary/50 transition-colors relative group"
                  onClick={() => onSelect(v.version, mode)}
                >
                  <div className="flex items-center gap-2 w-full">
                    <span className="font-mono font-bold text-primary">v{v.version}</span>
                    <Badge variant="secondary" className="text-[10px] font-normal h-4 px-1.5">
                      Turn {v.turn}
                    </Badge>
                    <Badge variant="outline" className="text-[10px] font-normal h-4 px-1.5">
                      {v.trigger === 'auto' ? '自动' : '手动'}
                    </Badge>
                    {v.active && (
                      <Badge className="text-[10px] font-normal h-4 px-1.5 bg-emerald-500 hover:bg-emerald-600">
                        当前位置
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground ml-auto flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(v.created_at).toLocaleDateString()} {new Date(v.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </span>
                  </div>
                  
                  <div className="w-full text-left">
                    <div className="text-sm font-medium truncate">{v.title}</div>
                    {v.summary_excerpt && v.summary_excerpt !== v.title && (
                      <div className="text-xs text-muted-foreground truncate mt-1">
                        {v.summary_excerpt}
                      </div>
                    )}
                  </div>
                  
                  <div className="absolute inset-0 border-2 border-primary/0 group-hover:border-primary/20 rounded-md transition-colors pointer-events-none" />
                </Button>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
