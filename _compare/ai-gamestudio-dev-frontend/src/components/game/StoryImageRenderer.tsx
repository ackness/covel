import { useState, type ReactNode } from 'react'
import type { BlockRendererProps } from '../../services/blockRenderers'
import { useUiStore } from '../../stores/uiStore'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

// ---------------------------------------------------------------------------
// i18n
// ---------------------------------------------------------------------------
const texts: Record<string, Record<string, string>> = {
  zh: {
    storyImage: '剧情配图',
    ready: '就绪',
    error: '错误',
    generating: '生成中…',
    viewDetails: '查看详情',
    regenerate: '重新生成',
    context: '上下文',
    hideContext: '收起上下文',
    background: '背景',
    prompt: '提示词',
    continuity: '连续性',
    imageFailed: '图片生成失败。',
    imageGenerating: '正在生成图片，请稍候…',
    regenNote: '可选的重新生成备注',
    showDetails: '显示详情',
    hideDetails: '隐藏详情',
    close: '关闭',
    detailsSubtitle: '左侧查看图片，右侧查看生成详情与状态信息。',
    detailsInfo: '详情信息',
    statusSummary: '状态概览',
    statusLabel: '生成状态',
    imageIdLabel: '图片 ID',
    modelLabel: '模型',
    providerNoteLabel: '服务说明',
    apiBaseLabel: 'API 地址',
    layoutPreferenceLabel: '布局偏好',
    referenceImageIdsLabel: '参考图 ID',
    referenceImagesLabel: '参考图信息',
    createdAt: '创建时间',
    imageUnavailable: '暂无可预览图片',
    llmEnhanced: 'LLM 增强',
    originalPrompt: '原始提示词',
    storyBackground: '故事背景',
    continuityNotes: '连续性注记',
    sceneFrames: '场景分镜',
    enhancedPrompt: '增强后提示词',
    generatedPrompt: '生成的提示词',
    preEnhancement: '增强前提示词',
    none: '（无）',
    worldContext: '世界上下文',
    worldLore: '世界设定',
    textWorldState: '文本世界状态',
    metadata: '元数据',
  },
  en: {
    storyImage: 'Story Image',
    ready: 'ready',
    error: 'error',
    generating: 'generating…',
    viewDetails: 'View details',
    regenerate: 'Regenerate',
    context: 'Context',
    hideContext: 'Hide context',
    background: 'Background',
    prompt: 'Prompt',
    continuity: 'Continuity',
    imageFailed: 'Image generation failed.',
    imageGenerating: 'Generating image, please wait…',
    regenNote: 'Optional regeneration note',
    showDetails: 'Show details',
    hideDetails: 'Hide details',
    close: 'Close',
    detailsSubtitle: 'Image preview on the left, generation details and states on the right.',
    detailsInfo: 'Details',
    statusSummary: 'Status Summary',
    statusLabel: 'Status',
    imageIdLabel: 'Image ID',
    modelLabel: 'Model',
    providerNoteLabel: 'Provider Note',
    apiBaseLabel: 'API Base',
    layoutPreferenceLabel: 'Layout Preference',
    referenceImageIdsLabel: 'Reference Image IDs',
    referenceImagesLabel: 'Reference Images',
    createdAt: 'Created At',
    imageUnavailable: 'No image available for preview',
    llmEnhanced: 'LLM Enhanced',
    originalPrompt: 'Original Prompt',
    storyBackground: 'Story Background',
    continuityNotes: 'Continuity Notes',
    sceneFrames: 'Scene Frames',
    enhancedPrompt: 'Enhanced Prompt',
    generatedPrompt: 'Generated Prompt',
    preEnhancement: 'Pre-Enhancement Prompt',
    none: '(none)',
    worldContext: 'World Context',
    worldLore: 'World Lore',
    textWorldState: 'Text World State',
    metadata: 'Metadata',
  },
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface StoryImageData {
  status?: 'ok' | 'error' | 'generating'
  image_id?: string
  created_at?: string
  title?: string
  story_background?: string
  prompt?: string
  continuity_notes?: string
  image_url?: string
  error?: string
  can_regenerate?: boolean
  reference_image_ids?: string[]
  scene_frames?: string[]
  layout_preference?: string
  reference_images?: Array<{ image_id?: string; title?: string }>
  provider_model?: string
  provider_note?: string
  settings_applied?: Record<string, unknown>
  debug?: {
    generated_prompt?: string
    enhanced_prompt?: string
    world_lore_excerpt?: string
    text_world_state?: string
    reference_images?: Array<{ image_id?: string; title?: string }>
    runtime_settings?: Record<string, unknown>
    provider_model?: string
    api_base?: string
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function resolveStatus(payload: StoryImageData): 'ok' | 'error' | 'generating' {
  if (payload.status === 'ok' || payload.status === 'error' || payload.status === 'generating') {
    return payload.status
  }
  return payload.image_url ? 'ok' : 'error'
}

function formatTimestamp(value?: string) {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return `${parsed.toLocaleDateString()} ${parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function statusText(status: 'ok' | 'error' | 'generating', t: Record<string, string>) {
  return status === 'ok' ? t.ready : status === 'generating' ? t.generating : t.error
}

function StatusBadge({
  status,
  t,
}: {
  status: 'ok' | 'error' | 'generating'
  t: Record<string, string>
}) {
  return (
    <Badge
      variant="outline"
      className={
        status === 'ok'
          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
          : status === 'generating'
            ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
            : 'border-red-500/40 bg-red-500/15 text-red-300'
      }
    >
      {statusText(status, t)}
    </Badge>
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-lg border bg-card p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <ScrollArea className="h-56 rounded-md border bg-muted/15">
        <div className="space-y-3 p-2">{children}</div>
      </ScrollArea>
    </section>
  )
}

function DetailField({
  label,
  value,
  fallback,
}: {
  label: string
  value?: string | null
  fallback?: string
}) {
  const content = value && value.trim() ? value : fallback
  if (!content) return null

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <pre className="m-0 whitespace-pre-wrap break-words rounded-md border bg-muted/25 p-2 text-xs leading-relaxed text-foreground/90">
        {content}
      </pre>
    </div>
  )
}

function StatusLine({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null

  return (
    <div className="flex items-start justify-between gap-2 rounded-md border bg-muted/20 px-2 py-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="max-w-[70%] break-all text-right">{value}</span>
    </div>
  )
}

function ImageDetailsDialog({
  open,
  onOpenChange,
  payload,
  t,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  payload: StoryImageData
  t: Record<string, string>
}) {
  const status = resolveStatus(payload)
  const statusLabel = statusText(status, t)
  const model = payload.debug?.provider_model || payload.provider_model
  const apiBase = payload.debug?.api_base
  const enhanced = payload.debug?.enhanced_prompt
  const generated = payload.debug?.generated_prompt
  const hasOriginalPrompt = Boolean(
    payload.prompt || payload.story_background || payload.continuity_notes || payload.scene_frames?.length,
  )
  const hasWorldContext = Boolean(payload.debug?.world_lore_excerpt || payload.debug?.text_world_state)
  const metadata = JSON.stringify(
    {
      image_id: payload.image_id,
      title: payload.title,
      status,
      provider_model: model,
      api_base: apiBase,
      provider_note: payload.provider_note,
      layout_preference: payload.layout_preference,
      reference_image_ids: payload.reference_image_ids,
      reference_images: payload.reference_images,
      settings_applied: payload.settings_applied,
      runtime_settings: payload.debug?.runtime_settings,
    },
    null,
    2,
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-[1200px] h-[88vh] p-0 gap-0 overflow-hidden">
        <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r">
            <DialogHeader className="gap-1 border-b px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <DialogTitle className="truncate text-base">{payload.title || t.storyImage}</DialogTitle>
                <StatusBadge status={status} t={t} />
              </div>
              <DialogDescription className="text-xs">
                {t.detailsSubtitle}
              </DialogDescription>
            </DialogHeader>
            <div className="flex-1 min-h-0 bg-muted/20 p-4">
              <div className="flex h-full items-center justify-center rounded-lg border border-dashed bg-background/40 p-2">
                {payload.image_url ? (
                  <img
                    src={payload.image_url}
                    alt={payload.prompt || t.storyImage}
                    className="h-full max-h-full w-full rounded-md object-contain"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">{t.imageUnavailable}</p>
                )}
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="border-b px-4 py-3">
              <p className="text-sm font-medium">{t.detailsInfo}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {model && (
                  <Badge variant="outline">
                    {t.modelLabel}: {model}
                  </Badge>
                )}
                {enhanced && <Badge variant="secondary">{t.llmEnhanced}</Badge>}
                {payload.image_id && (
                  <Badge variant="outline" className="font-mono">
                    {t.imageIdLabel}: {payload.image_id.slice(0, 12)}
                  </Badge>
                )}
              </div>
            </div>

            <ScrollArea className="flex-1 min-h-0">
              <div className="space-y-3 p-4">
                <DetailSection title={t.statusSummary}>
                  <StatusLine label={t.statusLabel} value={statusLabel} />
                  <StatusLine label={t.createdAt} value={formatTimestamp(payload.created_at)} />
                  <StatusLine label={t.layoutPreferenceLabel} value={payload.layout_preference} />
                  <DetailField label={t.providerNoteLabel} value={payload.provider_note} />
                  <DetailField label={t.apiBaseLabel} value={apiBase} />
                  <DetailField
                    label={t.referenceImageIdsLabel}
                    value={payload.reference_image_ids?.join('\n')}
                  />
                  <DetailField
                    label={t.referenceImagesLabel}
                    value={
                      payload.reference_images && payload.reference_images.length > 0
                        ? JSON.stringify(payload.reference_images, null, 2)
                        : undefined
                    }
                  />
                </DetailSection>

                {hasOriginalPrompt && (
                  <DetailSection title={t.originalPrompt}>
                    <DetailField label={t.prompt} value={payload.prompt} />
                    <DetailField label={t.storyBackground} value={payload.story_background} />
                    <DetailField label={t.continuityNotes} value={payload.continuity_notes} />
                    <DetailField label={t.sceneFrames} value={payload.scene_frames?.join('\n')} />
                  </DetailSection>
                )}

                <DetailSection title={enhanced ? t.enhancedPrompt : t.generatedPrompt}>
                  <DetailField
                    label={enhanced ? t.enhancedPrompt : t.generatedPrompt}
                    value={enhanced || generated}
                    fallback={t.none}
                  />
                  {enhanced && generated && (
                    <DetailField
                      label={t.preEnhancement}
                      value={generated}
                    />
                  )}
                </DetailSection>

                {hasWorldContext && (
                  <DetailSection title={t.worldContext}>
                    <DetailField label={t.worldLore} value={payload.debug?.world_lore_excerpt} />
                    <DetailField label={t.textWorldState} value={payload.debug?.text_world_state} />
                  </DetailSection>
                )}

                <DetailSection title={t.metadata}>
                  <DetailField label={t.metadata} value={metadata} />
                </DetailSection>
              </div>
            </ScrollArea>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function StoryImageRenderer({ data, blockId, onAction, locked }: BlockRendererProps) {
  const language = useUiStore((s) => s.language)
  const t = texts[language] ?? texts.en
  const payload = data && typeof data === 'object' ? (data as StoryImageData) : null
  const [expanded, setExpanded] = useState(false)
  const [reason, setReason] = useState('')
  const [lightboxOpen, setLightboxOpen] = useState(false)

  if (!payload) return null

  const status = resolveStatus(payload)
  const canRegenerate = Boolean(payload.can_regenerate) && !locked && (
    !!payload.image_id || (!!payload.story_background && !!payload.prompt)
  )

  const handleRegenerate = () => {
    onAction(
      JSON.stringify({
        type: 'block_response',
        block_type: 'story_image',
        block_id: blockId,
        data: {
          action: 'regenerate',
          image_id: payload.image_id || undefined,
          title: payload.title || undefined,
          story_background: payload.story_background || undefined,
          prompt: payload.prompt || undefined,
          continuity_notes: payload.continuity_notes || undefined,
          reference_image_ids: payload.reference_image_ids || undefined,
          scene_frames: payload.scene_frames || undefined,
          layout_preference: payload.layout_preference || undefined,
          reason: reason.trim() || undefined,
        },
      }),
    )
  }

  return (
    <div className="bg-card border rounded-xl p-3 max-w-[80%] space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{payload.title || t.storyImage}</p>
        <span
          className={`text-[10px] px-2 py-0.5 rounded ${
            status === 'ok'
              ? 'bg-emerald-900/60 text-emerald-300'
              : status === 'generating'
                ? 'bg-blue-900/60 text-blue-300'
                : 'bg-red-900/60 text-red-300'
          }`}
        >
          {status === 'ok' ? t.ready : status === 'generating' ? t.generating : t.error}
        </span>
      </div>

      {status === 'generating' ? (
        <div className="flex items-center gap-3 text-sm text-blue-300 bg-blue-900/20 border border-blue-800/40 rounded-lg px-4 py-3">
          <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          {t.imageGenerating}
        </div>
      ) : status === 'ok' && payload.image_url ? (
        <img
          src={payload.image_url}
          alt={payload.prompt || t.storyImage}
          className="w-full max-h-[460px] object-contain rounded-lg border bg-muted"
          loading="lazy"
        />
      ) : (
        <div className="text-sm text-red-300 bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">
          {payload.error || t.imageFailed}
        </div>
      )}

      {/* Action buttons row — always visible */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          size="sm"
          variant="outline"
          onClick={() => setLightboxOpen(true)}
        >
          {t.viewDetails}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={handleRegenerate}
          disabled={!canRegenerate}
        >
          {t.regenerate}
        </Button>
        {(payload.story_background || payload.prompt || payload.continuity_notes) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? t.hideContext : t.context}
          </Button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 text-xs text-foreground/80 bg-muted/50 border rounded-lg p-3">
          {payload.story_background && (
            <div className="space-y-1">
              <p className="text-muted-foreground">{t.background}</p>
              <pre className="m-0 whitespace-pre-wrap break-words leading-relaxed">{payload.story_background}</pre>
            </div>
          )}
          {payload.prompt && (
            <div className="space-y-1">
              <p className="text-muted-foreground">{t.prompt}</p>
              <pre className="m-0 whitespace-pre-wrap break-words leading-relaxed">{payload.prompt}</pre>
            </div>
          )}
          {payload.continuity_notes && (
            <div className="space-y-1">
              <p className="text-muted-foreground">{t.continuity}</p>
              <pre className="m-0 whitespace-pre-wrap break-words leading-relaxed">{payload.continuity_notes}</pre>
            </div>
          )}
        </div>
      )}

      {canRegenerate && (
        <Input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t.regenNote}
          className="h-8 text-xs"
        />
      )}

      <ImageDetailsDialog
        open={lightboxOpen}
        onOpenChange={setLightboxOpen}
        payload={payload}
        t={t}
      />
    </div>
  )
}
