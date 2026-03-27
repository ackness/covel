import { useEffect, useRef, useState, useCallback } from 'react'
import Markdown from 'react-markdown'
import { Copy, Image as ImageIcon, RotateCcw, Pencil, Trash2, AlertCircle, CheckCircle2, Plug } from 'lucide-react'
import { useSessionStore } from '../../stores/sessionStore'
import { useMessageImageStore } from '../../stores/messageImageStore'
import { useUiStore } from '../../stores/uiStore'
import type { StreamStatus } from '../../stores/sessionStore'
import { getBlockRenderer } from '../../services/blockRenderers'
import { normalizeBlockLike, type BlockLike } from '../../services/outputContract.js'
import type { Message } from '../../types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface Props {
  onAction: (msg: string) => void
  onRetry?: () => void
  onGenerateImage?: (messageId: string) => void
  onRetriggerPlugins?: (messageId: string) => void
}

const chatText: Record<string, Record<string, string>> = {
  zh: {
    block: '区块',
    copy: '复制',
    regenerateImage: '重新生成配图',
    generateImage: '生成配图',
    regenerate: '重新生成',
    editAndResend: '编辑并重新发送',
    delete: '删除',
    rawMessageData: '消息原始数据',
    id: 'ID',
    role: '角色',
    type: '类型',
    scene: '场景',
    content: '内容',
    rawContent: '原始内容',
    blocks: '区块',
    close: '关闭',
    storyImageAlt: '剧情配图',
    beginAdventure: '开始你的冒险',
    beginAdventureHint: '发送一条消息以开始游戏',
    cancel: '取消',
    send: '发送',
    clickViewRaw: '点击查看原始数据',
    generatingImage: '生成配图中...',
    generationFailed: '生成失败',
    retry: '重试',
    generationDone: '生成完成',
  },
  en: {
    block: 'Block',
    copy: 'Copy',
    regenerateImage: 'Regenerate image',
    generateImage: 'Generate image',
    regenerate: 'Regenerate',
    editAndResend: 'Edit and resend',
    delete: 'Delete',
    rawMessageData: 'Raw Message Data',
    id: 'ID',
    role: 'Role',
    type: 'Type',
    scene: 'Scene',
    content: 'Content',
    rawContent: 'Raw Content',
    blocks: 'Blocks',
    close: 'Close',
    storyImageAlt: 'Story image',
    beginAdventure: 'Begin your adventure',
    beginAdventureHint: 'Send a message to start the game',
    cancel: 'Cancel',
    send: 'Send',
    clickViewRaw: 'Click to view raw data',
    generatingImage: 'Generating image...',
    generationFailed: 'Generation failed',
    retry: 'Retry',
    generationDone: 'Done',
  },
}

/** Fallback for block types with no registered renderer. */
function FallbackBlock({ type, data, label }: { type: string; data: unknown; label: string }) {
  return (
    <details className="bg-muted/50 border rounded-xl px-4 py-2 max-w-[80%] text-xs">
      <summary className="text-muted-foreground cursor-pointer font-medium hover:text-foreground">
        {label}: <code className="bg-muted px-1 py-0.5 rounded">{type}</code>
      </summary>
      <pre className="mt-2 text-muted-foreground overflow-x-auto bg-background/50 p-2 rounded-md border border-border/50">
        {JSON.stringify(data, null, 2)}
      </pre>
    </details>
  )
}

/** Block types that should be grouped when consecutive. */
const GROUPABLE_BLOCK_TYPES = new Set(['codex_entry', 'item_update'])

interface GroupedBlock {
  type: string
  items: { data: unknown; blockId: string; output?: unknown }[]
}

function groupConsecutiveBlocks(blocks: BlockLike[], idPrefix: string): (GroupedBlock | { single: true; block: BlockLike; idx: number })[] {
  const result: (GroupedBlock | { single: true; block: BlockLike; idx: number })[] = []
  let i = 0
  while (i < blocks.length) {
    const normalized = normalizeBlockLike(blocks[i], `${idPrefix}:${i}`)
    if (!normalized) { i++; continue }
    if (GROUPABLE_BLOCK_TYPES.has(normalized.type)) {
      const group: GroupedBlock = { type: normalized.type, items: [] }
      while (i < blocks.length) {
        const n = normalizeBlockLike(blocks[i], `${idPrefix}:${i}`)
        if (!n || n.type !== group.type) break
        group.items.push({ data: n.data, blockId: n.block_id || `${idPrefix}:${i}:${n.type}`, output: n.output })
        i++
      }
      result.push(group)
    } else {
      result.push({ single: true, block: blocks[i], idx: i })
      i++
    }
  }
  return result
}

/** Render a list of blocks (attached to a message or pending). */
function BlockList({
  blocks,
  onAction,
  locked,
  idPrefix,
  t,
}: {
  blocks: BlockLike[]
  onAction: (msg: string) => void
  locked?: boolean
  idPrefix: string
  t: Record<string, string>
}) {
  const grouped = groupConsecutiveBlocks(blocks, idPrefix)
  return (
    <>
      {grouped.map((entry, gi) => {
        if ('single' in entry) {
          const normalized = normalizeBlockLike(entry.block, `${idPrefix}:${entry.idx}`)
          if (!normalized) return null
          const Renderer = getBlockRenderer(normalized.type)
          const blockId = normalized.block_id || `${idPrefix}:${entry.idx}:${normalized.type}`
          return (
            <div key={blockId} className="flex justify-start">
              {Renderer ? (
                <Renderer data={normalized.data} blockId={blockId} onAction={onAction} locked={locked} />
              ) : (
                <FallbackBlock type={normalized.type} data={normalized.data} label={t.block} />
              )}
            </div>
          )
        }
        // Grouped block
        const Renderer = getBlockRenderer(entry.type)
        if (!Renderer) return null
        const groupKey = entry.items.map((it) => it.blockId).join(',')
        const groupedData = entry.items.map((it) => it.data)
        return (
          <div key={`group-${gi}-${groupKey}`} className="flex justify-start">
            <Renderer data={groupedData} blockId={entry.items[0].blockId} onAction={onAction} locked={locked} />
          </div>
        )
      })}
    </>
  )
}

/** Hover action bar for messages. */
function MessageActions({
  msg,
  isLast,
  onCopy,
  onDelete,
  onRegenerate,
  onEdit,
  onGenerateImage,
  onRetriggerPlugins,
  imageLoading,
  hasImage,
  t,
}: {
  msg: Message
  isLast: boolean
  onCopy: () => void
  onDelete: () => void
  onRegenerate?: () => void
  onEdit?: () => void
  onGenerateImage?: () => void
  onRetriggerPlugins?: () => void
  imageLoading?: boolean
  hasImage?: boolean
  t: Record<string, string>
}) {
  return (
    <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={onCopy}>
            <Copy className="w-3.5 h-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent><p>{t.copy}</p></TooltipContent>
      </Tooltip>

      {msg.role === 'assistant' && onGenerateImage && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button 
              variant="ghost" 
              size="icon" 
              className="h-6 w-6 text-muted-foreground hover:text-purple-400 disabled:opacity-50" 
              onClick={onGenerateImage}
              disabled={imageLoading}
            >
              <ImageIcon className={`w-3.5 h-3.5 ${imageLoading ? 'animate-pulse' : ''}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>{hasImage ? t.regenerateImage : t.generateImage}</p></TooltipContent>
        </Tooltip>
      )}

      {msg.role === 'assistant' && isLast && onRegenerate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={onRegenerate}>
              <RotateCcw className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>{t.regenerate}</p></TooltipContent>
        </Tooltip>
      )}

      {msg.role === 'assistant' && onRetriggerPlugins && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-cyan-400" onClick={onRetriggerPlugins}>
              <Plug className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>重新触发插件</p></TooltipContent>
        </Tooltip>
      )}

      {msg.role === 'user' && onEdit && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground" onClick={onEdit}>
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent><p>{t.editAndResend}</p></TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" onClick={onDelete}>
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent><p>{t.delete}</p></TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Raw message inspector overlay. */
function RawMessageViewer({ msg, onClose, t }: { msg: Message; onClose: () => void; t: Record<string, string> }) {
  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-4 py-3 border-b shrink-0">
          <DialogTitle className="text-sm font-medium">{t.rawMessageData}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs font-mono">
          <div className="grid grid-cols-[100px_1fr] gap-2">
            <span className="text-muted-foreground">{t.id}:</span>
            <span className="text-foreground">{msg.id}</span>
            
            <span className="text-muted-foreground">{t.role}:</span>
            <span className="text-foreground">{msg.role}</span>
            
            <span className="text-muted-foreground">{t.type}:</span>
            <span className="text-foreground">{msg.message_type}</span>
            
            {msg.scene_id && (
              <>
                <span className="text-muted-foreground">{t.scene}:</span>
                <span className="text-foreground">{msg.scene_id}</span>
              </>
            )}
          </div>
          
          <div className="space-y-1.5">
            <span className="text-muted-foreground block font-medium">{t.content}:</span>
            <pre className="text-foreground whitespace-pre-wrap bg-muted/50 border rounded-md p-3 overflow-x-auto">
              {msg.content}
            </pre>
          </div>
          
          {msg.raw_content && msg.raw_content !== msg.content && (
            <div className="space-y-1.5">
              <span className="text-muted-foreground block font-medium">{t.rawContent}:</span>
              <pre className="text-foreground whitespace-pre-wrap bg-muted/50 border rounded-md p-3 overflow-x-auto">
                {msg.raw_content}
              </pre>
            </div>
          )}
          
          {msg.blocks && msg.blocks.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-muted-foreground block font-medium">{t.blocks} ({msg.blocks.length}):</span>
              <pre className="text-foreground whitespace-pre-wrap bg-muted/50 border rounded-md p-3 overflow-x-auto">
                {JSON.stringify(msg.blocks, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ChatMessages({ onAction, onRetry, onGenerateImage, onRetriggerPlugins }: Props) {
  const { messages, isStreaming, streamingContent, streamStatus, pendingBlocks, deleteMessage, deleteMessagesFrom, pluginProcessing, pluginProgress, lastPluginSummary } = useSessionStore()
  const { messageImages, imageLoadingMessages } = useMessageImageStore()
  const language = useUiStore((s) => s.language)
  const t = chatText[language] ?? chatText.en
  const bottomRef = useRef<HTMLDivElement>(null)
  const [inspectMsg, setInspectMsg] = useState<Message | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent, pendingBlocks])

  const handleCopy = useCallback((content: string) => {
    navigator.clipboard.writeText(content).catch((err) => console.warn('[chat] clipboard', err))
  }, [])

  const handleDelete = useCallback((msgId: string) => {
    deleteMessage(msgId)
  }, [deleteMessage])

  const handleDeleteFrom = useCallback((msgId: string) => {
    deleteMessagesFrom(msgId)
  }, [deleteMessagesFrom])

  const handleEdit = useCallback((msg: Message) => {
    setEditingId(msg.id)
    setEditText(msg.content)
  }, [])

  const handleEditSubmit = useCallback((msgId: string) => {
    const text = editText.trim()
    if (!text) return
    deleteMessagesFrom(msgId)
    setEditingId(null)
    setEditText('')
    onAction(text)
  }, [editText, deleteMessagesFrom, onAction])

  const handleEditCancel = useCallback(() => {
    setEditingId(null)
    setEditText('')
  }, [])

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent, msgId: string) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleEditSubmit(msgId)
    }
    if (e.key === 'Escape') {
      handleEditCancel()
    }
  }, [handleEditSubmit, handleEditCancel])

  const lastMsgIndex = messages.length - 1

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 scroll-smooth bg-background">
      {messages.length === 0 && !isStreaming && (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground opacity-50">
          <p className="text-lg font-medium mb-2">{t.beginAdventure}</p>
          <p className="text-sm">{t.beginAdventureHint}</p>
        </div>
      )}

      <div className="max-w-4xl mx-auto space-y-6">
        {messages.map((msg, idx) => {
          const isLast = idx === lastMsgIndex
          const blocksLocked = !isLast

          if (msg.role === 'system') {
            return (
              <div key={msg.id} className="flex justify-center group py-2">
                <Badge variant="secondary" className="px-4 py-1.5 text-xs font-normal bg-muted text-muted-foreground shadow-sm whitespace-normal text-center max-w-lg break-words">
                  {msg.content}
                </Badge>
              </div>
            )
          }

          if (msg.role === 'user') {
            if (editingId === msg.id) {
              return (
                <div key={msg.id} className="flex justify-end">
                  <div className="bg-muted border rounded-2xl rounded-tr-sm max-w-[85%] p-3 space-y-3 shadow-sm w-full sm:w-[400px]">
                    <textarea
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => handleEditKeyDown(e, msg.id)}
                      className="w-full bg-background text-foreground text-sm rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary min-h-[80px] border"
                      rows={3}
                      autoFocus
                    />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="sm" onClick={handleEditCancel}>
                        {t.cancel}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => handleEditSubmit(msg.id)}
                        disabled={!editText.trim()}
                      >
                        {t.send}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            }

            return (
              <div key={msg.id} className="flex justify-end group">
                <div className="flex items-end gap-2 flex-row-reverse">
                  <div
                    className="px-5 py-3 rounded-2xl rounded-tr-sm max-w-[85%] text-sm shadow-sm cursor-pointer transition-all bg-primary text-primary-foreground hover:bg-primary/90"
                    onClick={() => setInspectMsg(msg)}
                    title={t.clickViewRaw}
                  >
                    {msg.content}
                  </div>
                  <MessageActions
                    msg={msg}
                    isLast={isLast}
                    onCopy={() => handleCopy(msg.content)}
                    onDelete={() => handleDeleteFrom(msg.id)}
                    onEdit={() => handleEdit(msg)}
                    t={t}
                  />
                </div>
              </div>
            )
          }

          // assistant
          const hasAssistantText = Boolean((msg.content || '').trim())
          return (
            <div key={msg.id} className="space-y-3 group">
              {hasAssistantText && (
                <div className="flex justify-start">
                  <div className="flex items-end gap-2">
                    <div
                      className="px-5 py-3 rounded-2xl rounded-tl-sm max-w-[85%] text-sm markdown-content cursor-pointer transition-all bg-muted/50 border text-foreground shadow-sm hover:bg-muted/70"
                      onClick={() => setInspectMsg(msg)}
                      title={t.clickViewRaw}
                    >
                      <Markdown>{msg.content}</Markdown>
                    </div>
                    <MessageActions
                      msg={msg}
                      isLast={isLast}
                      onCopy={() => handleCopy(msg.content)}
                      onDelete={() => handleDelete(msg.id)}
                      onRegenerate={isLast && !isStreaming ? onRetry : undefined}
                      onGenerateImage={onGenerateImage ? () => onGenerateImage(msg.id) : undefined}
                      onRetriggerPlugins={onRetriggerPlugins && !isStreaming && !pluginProcessing ? () => onRetriggerPlugins(msg.id) : undefined}
                      imageLoading={imageLoadingMessages.has(msg.id)}
                      hasImage={!!messageImages[msg.id]?.length}
                      t={t}
                    />
                  </div>
                </div>
              )}
              
              {messageImages[msg.id]?.length > 0 && (
                <BlockList
                  blocks={messageImages[msg.id].map((img, i) => ({
                    type: 'story_image',
                    data: img,
                    block_id: `img-${msg.id}-${img.image_id || i}`,
                  }))}
                  onAction={onAction}
                  locked={blocksLocked}
                  idPrefix={`${msg.id}-img`}
                  t={t}
                />
              )}
              
              {imageLoadingMessages.has(msg.id) && (
                <div className="flex justify-start pl-1">
                  <div className="bg-muted/50 border rounded-xl px-4 py-3 max-w-[80%] flex items-center gap-3">
                    <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    <span className="text-xs text-muted-foreground font-medium">{t.generatingImage}</span>
                  </div>
                </div>
              )}
              
              {msg.blocks && msg.blocks.length > 0 && (
                <BlockList
                  blocks={msg.blocks}
                  onAction={onAction}
                  locked={blocksLocked}
                  idPrefix={msg.id}
                  t={t}
                />
              )}

              {isLast && msg.role === 'assistant' && (!msg.blocks || msg.blocks.length === 0) && onRetriggerPlugins && !isStreaming && !pluginProcessing && (
                <div className="flex justify-start pl-1">
                  <button
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-cyan-400 bg-muted/30 hover:bg-muted/50 border border-dashed border-muted-foreground/30 rounded-lg px-3 py-1.5 transition-colors"
                    onClick={() => onRetriggerPlugins(msg.id)}
                  >
                    <Plug className="w-3 h-3" />
                    <span>{'\u52a0\u8f7d\u63d2\u4ef6\uff08\u89d2\u8272\u5361\u3001\u573a\u666f\u7b49\uff09'}</span>
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {isStreaming && streamingContent && (
          <div className="flex justify-start">
            <div className="px-5 py-3 rounded-2xl rounded-tl-sm max-w-[85%] text-sm markdown-content bg-muted/30 border border-primary/20 text-foreground shadow-sm ring-1 ring-primary/10">
              <Markdown>{streamingContent}</Markdown>
              <span className="inline-block w-1.5 h-4 ml-1 bg-primary/70 animate-pulse align-middle" />
            </div>
          </div>
        )}

        {isStreaming && !streamingContent && (
          <div className="flex justify-start">
            <div className="px-5 py-4 rounded-2xl rounded-tl-sm bg-muted/30 border shadow-sm">
              <div className="flex gap-1.5">
                <span className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        {pluginProcessing && !isStreaming && (
          <div className="flex justify-start">
            <div className="px-4 py-2.5 rounded-2xl rounded-tl-sm bg-muted/20 border border-dashed border-primary/30 shadow-sm">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="w-2 h-2 bg-primary/50 rounded-full animate-pulse" />
                {pluginProgress ? (
                  <span>
                    插件处理中 · 第 {pluginProgress.round} 轮
                    {pluginProgress.tool_calls.length > 0 && ` · ${pluginProgress.tool_calls.join(', ')}`}
                  </span>
                ) : (
                  <span>插件处理中，请稍候…</span>
                )}
              </div>
            </div>
          </div>
        )}

        {lastPluginSummary && !pluginProcessing && !isStreaming && (
          <div className="flex justify-start">
            <details className="px-3 py-1.5 rounded-lg bg-muted/20 border border-muted-foreground/20 text-[11px] text-muted-foreground max-w-[80%]">
              <summary className="cursor-pointer select-none flex items-center gap-1.5">
                <Plug className="w-3 h-3 text-cyan-400" />
                <span>插件执行完成 · {lastPluginSummary.rounds} 轮 · {lastPluginSummary.tool_calls.length} 次调用 · {lastPluginSummary.blocks_emitted.length} 个 block</span>
              </summary>
              <div className="mt-1 pl-4 space-y-0.5">
                {lastPluginSummary.tool_calls.length > 0 && (
                  <div><span className="text-muted-foreground/70">工具: </span>{[...new Set(lastPluginSummary.tool_calls)].join(', ')}</div>
                )}
                {lastPluginSummary.blocks_emitted.length > 0 && (
                  <div><span className="text-muted-foreground/70">Blocks: </span>{lastPluginSummary.blocks_emitted.join(', ')}</div>
                )}
              </div>
            </details>
          </div>
        )}

        {pendingBlocks.length > 0 && (
          <BlockList
            blocks={pendingBlocks.map((b) => ({
              type: b.type,
              data: b.data,
              block_id: b.blockId,
              output: b.output,
            }))}
            onAction={onAction}
            idPrefix="pending"
            t={t}
          />
        )}
      </div>

      <StatusBar status={streamStatus} onRetry={onRetry} t={t} />

      <div ref={bottomRef} className="h-4" />

      {inspectMsg && <RawMessageViewer msg={inspectMsg} onClose={() => setInspectMsg(null)} t={t} />}
    </div>
  )
}

function StatusBar({ status, onRetry, t }: { status: StreamStatus; onRetry?: () => void; t: Record<string, string> }) {
  if (status === 'idle') return null

  if (status === 'error') {
    return (
      <div className="flex justify-center my-4">
        <Alert variant="destructive" className="max-w-md py-2 px-4 inline-flex items-center w-auto shadow-sm">
          <AlertCircle className="h-4 w-4 mr-2" />
          <AlertDescription className="text-xs flex items-center gap-3 mt-0">
            {t.generationFailed}
            {onRetry && (
              <Button variant="outline" size="sm" className="h-6 px-2 text-xs border-destructive/30 hover:bg-destructive/10" onClick={onRetry}>
                {t.retry}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  if (status === 'done') {
    return (
      <div className="flex justify-center my-4">
        <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-900 font-normal px-3 py-1 shadow-sm gap-1.5">
          <CheckCircle2 className="w-3.5 h-3.5" /> {t.generationDone}
        </Badge>
      </div>
    )
  }

  return null
}
