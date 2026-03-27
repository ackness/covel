import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import { reviseWorld, generateWorldStream, getLlmInfo } from '../../services/api'
import type { ReviseWorldResult } from '../../services/api'
import { getBrowserLlmConfig } from '../../utils/browserLlmConfig'
import { parseFrontmatter, serializeFrontmatter, hasFrontmatter } from '../../utils/frontmatter'
import type { WorldMeta } from '../../utils/frontmatter'

const T = {
  zh: {
    aiPlaceholder: 'AI 指令：如"增加一个海盗势力"、"丰富魔法体系的描述"、"添加3个新NPC"',
    aiRevise: 'AI 修改',
    generating: '生成中...',
    diffHint: '修改预览（绿色高亮为变更部分）',
    accept: '接受',
    reject: '拒绝',
    saving: '保存中...',
    saved: '已保存',
    saveFailed: '保存失败',
    noApiKey: '使用 AI 功能需要先在「模型」标签页配置 API Key',
    editorPlaceholder:
      '# 我的游戏世界\n\n在此描述你的世界背景、地理、势力、核心冲突和 DM 指引...\n\n提示：可参考 WORLD-SPEC 规范组织文档结构，或使用上方 AI 指令自动修改。',
    emptyTitle: '开始创建你的世界文档',
    emptyDesc: '世界文档是游戏的核心设定，DM（AI 主持人）将依据它来引导游戏。',
    emptyStructure: '推荐结构',
    emptySection1: '# 世界名称 — 简洁有力的标题',
    emptySection2: '## 世界背景 — 时代、核心概念、当前局势',
    emptySection3: '## 地理 — 重要地点和区域划分',
    emptySection4: '## 势力 — 阵营、种族或门派',
    emptySection5: '## 核心冲突 — 3-5 个多层次矛盾线',
    emptySection6: '## DM 指引 — 叙事风格、NPC、规则',
    emptyUseTemplate: '使用模板开始',
    emptyAiGenerate: 'AI 生成',
    emptyOrManual: '或直接在下方编辑器中编写',
    genGenre: '类型 / 题材',
    genGenrePlaceholder: '如：暗黑奇幻、赛博朋克、武侠...',
    genSetting: '世界设定简述（可选）',
    genSettingPlaceholder: '描述你想要的世界设定...',
    genTone: '叙事基调（可选）',
    genToneNone: '不指定',
    genExtra: '补充说明（可选）',
    genExtraPlaceholder: '任何额外要求...',
    genSubmit: '生成世界',
    genGenerating: 'AI 正在生成世界文档...',
    genCancel: '取消',
    metaName: '世界名称',
    metaDesc: '简介',
    metaGenre: '类型',
    metaTags: '标签（逗号分隔）',
    metaPlugins: '推荐插件（逗号分隔）',
    metaSection: '元数据',
    export: '导出',
  },
  en: {
    aiPlaceholder: 'AI instruction: e.g. "add a pirate faction", "expand the magic system", "add 3 new NPCs"',
    aiRevise: 'AI Revise',
    generating: 'Generating...',
    diffHint: 'Revision preview (green highlights show changes)',
    accept: 'Accept',
    reject: 'Reject',
    saving: 'Saving...',
    saved: 'Saved',
    saveFailed: 'Save failed',
    noApiKey: 'Configure API Key in the "Model" tab to use AI features',
    editorPlaceholder:
      '# My Game World\n\nDescribe your world background, geography, factions, core conflicts, and DM guidelines here...\n\nTip: Follow the WORLD-SPEC structure, or use the AI instruction bar above to revise automatically.',
    emptyTitle: 'Create Your World Document',
    emptyDesc: 'The world document is the core setting for your game. The DM (AI game master) uses it to guide gameplay.',
    emptyStructure: 'Recommended Structure',
    emptySection1: '# World Name — a concise, evocative title',
    emptySection2: '## World Background — era, core concepts, current situation',
    emptySection3: '## Geography — key locations and regions',
    emptySection4: '## Factions — factions, races, or clans',
    emptySection5: '## Core Conflicts — 3-5 multi-layered conflicts',
    emptySection6: '## DM Guidelines — narrative style, NPCs, rules',
    emptyUseTemplate: 'Start with Template',
    emptyAiGenerate: 'AI Generate',
    emptyOrManual: 'or write directly in the editor below',
    genGenre: 'Genre / Theme',
    genGenrePlaceholder: 'e.g. dark fantasy, cyberpunk, wuxia...',
    genSetting: 'World setting (optional)',
    genSettingPlaceholder: 'Describe the world you want...',
    genTone: 'Narrative tone (optional)',
    genToneNone: 'Not specified',
    genExtra: 'Extra notes (optional)',
    genExtraPlaceholder: 'Any additional requirements...',
    genSubmit: 'Generate World',
    genGenerating: 'AI is generating the world document...',
    genCancel: 'Cancel',
    metaName: 'World Name',
    metaDesc: 'Description',
    metaGenre: 'Genre',
    metaTags: 'Tags (comma-separated)',
    metaPlugins: 'Plugins (comma-separated)',
    metaSection: 'Metadata',
    export: 'Export',
  },
}

const SKELETON: Record<string, string> = {
  zh: `# 我的游戏世界

## 世界背景

（描述时代背景、核心概念、当前局势）

## 地理

### 主要区域

- **地点1**：描述...
- **地点2**：描述...

## 势力

| 名称 | 特点 | 所在地 |
|------|------|--------|
| 阵营1 | 描述... | 地点 |

## 核心冲突

- **冲突1**：描述...
- **冲突2**：描述...
- **冲突3**：描述...

## DM 指引

### 叙事风格
- （风格要点）

### 重要 NPC

#### 角色名（身份）
- 外貌：...
- 性格：...
- 剧情作用：...

### 玩法触发指引

- **技能检定**：（何时需要检定）
- **战斗**：（何时进入战斗）
- **物品管理**：（何时记录物品）
`,
  en: `# My Game World

## World Background

(Describe the era, core concepts, and current situation)

## Geography

### Main Region

- **Location 1**: Description...
- **Location 2**: Description...

## Factions

| Name | Traits | Location |
|------|--------|----------|
| Faction 1 | Description... | Location |

## Core Conflicts

- **Conflict 1**: Description...
- **Conflict 2**: Description...
- **Conflict 3**: Description...

## DM Guidelines

### Narrative Style
- (Style notes)

### Key NPCs

#### Character Name (Role)
- Appearance: ...
- Personality: ...
- Plot role: ...

### Gameplay Trigger Guide

- **Skill Checks**: (When to trigger)
- **Combat**: (When to enter combat)
- **Inventory**: (When to track items)
`,
}

function buildHighlightedSegments(doc: string, edits: { new_text: string }[]): { text: string; highlight: boolean }[] {
  if (!edits.length) return [{ text: doc, highlight: false }]
  const segments: { text: string; highlight: boolean }[] = []
  let cursor = 0
  for (const edit of edits) {
    const idx = doc.indexOf(edit.new_text, cursor)
    if (idx === -1) continue
    if (idx > cursor) segments.push({ text: doc.slice(cursor, idx), highlight: false })
    segments.push({ text: doc.slice(idx, idx + edit.new_text.length), highlight: true })
    cursor = idx + edit.new_text.length
  }
  if (cursor < doc.length) segments.push({ text: doc.slice(cursor), highlight: false })
  return segments
}

export function MarkdownEditor() {
  const { currentProject, updateWorldDoc } = useProjectStore()
  const { language } = useUiStore()
  const t = T[language === 'zh' ? 'zh' : 'en']
  const [content, setContent] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [aiInstruction, setAiInstruction] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [reviseResult, setReviseResult] = useState<ReviseWorldResult | null>(null)
  const [hasKey, setHasKey] = useState(true)
  const [showGenForm, setShowGenForm] = useState(false)
  const [genGenre, setGenGenre] = useState('')
  const [genSetting, setGenSetting] = useState('')
  const [genTone, setGenTone] = useState('')
  const [genExtra, setGenExtra] = useState('')
  const [genLoading, setGenLoading] = useState(false)
  const [genError, setGenError] = useState('')
  const [showMeta, setShowMeta] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resetStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastQueuedValueRef = useRef('')

  const parsed = useMemo(() => parseFrontmatter(content), [content])

  useEffect(() => {
    if (currentProject) {
      setContent(currentProject.world_doc || '')
    }
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (resetStatusTimerRef.current) {
      clearTimeout(resetStatusTimerRef.current)
      resetStatusTimerRef.current = null
    }
    setSaveStatus('idle')
  }, [currentProject?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (resetStatusTimerRef.current) clearTimeout(resetStatusTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const local = getBrowserLlmConfig(currentProject?.id)
    if (local.apiKey) { setHasKey(true); return }
    getLlmInfo(currentProject?.id).then((info) => setHasKey(info.has_key)).catch((err) => console.warn('[editor] getLlmInfo', err))
  }, [currentProject?.id])

  const saveNow = useCallback(
    async (value: string) => {
      const projectId = currentProject?.id
      if (!projectId) return
      setSaveStatus('saving')
      try {
        await updateWorldDoc(value, projectId)
        setSaveStatus('saved')
        if (resetStatusTimerRef.current) clearTimeout(resetStatusTimerRef.current)
        resetStatusTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000)
      } catch (error) {
        console.error('Failed to save world doc:', error)
        setSaveStatus('error')
      }
    },
    [currentProject?.id, updateWorldDoc],
  )

  const debouncedSave = useCallback(
    (value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      if (resetStatusTimerRef.current) {
        clearTimeout(resetStatusTimerRef.current)
        resetStatusTimerRef.current = null
      }
      lastQueuedValueRef.current = value
      setSaveStatus('idle')
      timerRef.current = setTimeout(async () => {
        timerRef.current = null
        await saveNow(value)
      }, 1000)
    },
    [saveNow],
  )

  const updateMeta = (patch: Partial<WorldMeta>) => {
    const newMeta = { ...parsed.meta, ...patch }
    const full = serializeFrontmatter(newMeta, parsed.body)
    setContent(full)
    debouncedSave(full)
  }

  const handleBodyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const full = serializeFrontmatter(parsed.meta, e.target.value)
    setContent(full)
    debouncedSave(full)
  }

  const handleBodyPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData('text/plain')
    if (hasFrontmatter(text)) {
      e.preventDefault()
      setContent(text)
      debouncedSave(text)
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setContent(value)
    debouncedSave(value)
  }

  const handleBlur = () => {
    if (!currentProject?.id) return
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      void saveNow(lastQueuedValueRef.current || content)
    }
  }

  const handleRevise = async () => {
    if (!aiInstruction.trim() || !content.trim()) return
    if (!hasKey) { setAiError(t.noApiKey); return }
    setAiLoading(true)
    setAiError('')
    try {
      const result = await reviseWorld({ world_doc: content, instruction: aiInstruction, language })
      setReviseResult(result)
    } catch (e: unknown) {
      setAiError(e instanceof Error ? e.message : 'AI revision failed')
    } finally {
      setAiLoading(false)
    }
  }

  const handleUseSkeleton = () => {
    const skeleton = SKELETON[language === 'zh' ? 'zh' : 'en']
    setContent(skeleton)
    debouncedSave(skeleton)
  }

  const handleGenerate = async () => {
    if (!genGenre.trim()) return
    if (!hasKey) { setGenError(t.noApiKey); return }
    setGenLoading(true)
    setGenError('')
    let doc = ''
    try {
      await generateWorldStream(
        {
          genre: genGenre.trim(),
          setting: genSetting.trim() || undefined,
          tone: genTone.trim() || undefined,
          language,
          extra_notes: genExtra.trim() || undefined,
        },
        (chunk) => { doc += chunk; setContent(doc) },
      )
      debouncedSave(doc)
      setShowGenForm(false)
    } catch (e: unknown) {
      setGenError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenLoading(false)
    }
  }

  const handleAccept = () => {
    if (!reviseResult) return
    setContent(reviseResult.world_doc)
    debouncedSave(reviseResult.world_doc)
    setReviseResult(null)
    setAiInstruction('')
  }

  const handleReject = () => {
    setReviseResult(null)
  }

  const isEmpty = !content.trim() || genLoading

  const handleExport = () => {
    const name = parsed.meta.name || currentProject?.name || 'world'
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b">
        {!hasKey && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" title={t.noApiKey} />}
        <input
          type="text"
          value={aiInstruction}
          onChange={(e) => setAiInstruction(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !aiLoading && handleRevise()}
          placeholder={hasKey ? t.aiPlaceholder : t.noApiKey}
          className="flex-1 px-2 py-1 text-xs bg-background text-foreground rounded border border-input focus:outline-none focus:ring-1 focus:ring-ring"
          disabled={aiLoading || reviseResult !== null}
        />
        <button
          onClick={handleRevise}
          disabled={aiLoading || !aiInstruction.trim() || isEmpty || reviseResult !== null}
          className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
        >
          {aiLoading ? t.generating : t.aiRevise}
        </button>
        <button
          onClick={handleExport}
          disabled={isEmpty}
          className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          title={t.export}
        >
          {t.export}
        </button>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {saveStatus === 'saving' && t.saving}
          {saveStatus === 'saved' && t.saved}
          {saveStatus === 'error' && t.saveFailed}
        </span>
      </div>
      {aiError && <div className="px-3 py-1 text-xs text-destructive bg-destructive/10">{aiError}</div>}
      {reviseResult !== null ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1 bg-muted/30 border-b">
            <span className="text-xs text-muted-foreground flex-1">
              {reviseResult.edits.length > 0
                ? `${reviseResult.edits.length} ${language === 'zh' ? '处修改' : 'change(s)'} — ${t.diffHint}`
                : t.diffHint}
            </span>
            <button onClick={handleAccept} className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90">{t.accept}</button>
            <button onClick={handleReject} className="px-3 py-1 text-xs bg-secondary text-secondary-foreground rounded hover:bg-secondary/80">{t.reject}</button>
          </div>
          <pre className="flex-1 p-4 bg-muted/20 text-sm font-mono overflow-auto leading-relaxed whitespace-pre-wrap">
            {buildHighlightedSegments(reviseResult.world_doc, reviseResult.edits).map((seg, i) =>
              seg.highlight
                ? <mark key={i} className="bg-green-900/50 text-green-200 rounded px-0.5">{seg.text}</mark>
                : <span key={i} className="text-foreground">{seg.text}</span>
            )}
          </pre>
        </div>
      ) : isEmpty ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-6 py-5 space-y-3 border-b">
            <h3 className="text-sm font-medium">{t.emptyTitle}</h3>
            <p className="text-xs text-muted-foreground">{t.emptyDesc}</p>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground font-medium">{t.emptyStructure}</p>
              {[t.emptySection1, t.emptySection2, t.emptySection3, t.emptySection4, t.emptySection5, t.emptySection6].map((s) => (
                <p key={s} className="text-xs text-muted-foreground font-mono pl-2">{s}</p>
              ))}
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button onClick={handleUseSkeleton} className="px-3 py-1.5 text-xs bg-secondary text-secondary-foreground rounded hover:bg-secondary/80">{t.emptyUseTemplate}</button>
              <button onClick={() => setShowGenForm(true)} disabled={!hasKey} className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed">{t.emptyAiGenerate}</button>
              <span className="text-xs text-muted-foreground/60">{t.emptyOrManual}</span>
            </div>
            {showGenForm && (
              <div className="space-y-2 pt-2 border-t">
                {genLoading ? (
                  <div className="flex items-center gap-2 py-4 justify-center">
                    <div className="w-4 h-4 border-2 border-muted border-t-primary rounded-full animate-spin" />
                    <span className="text-xs text-foreground">{t.genGenerating}</span>
                  </div>
                ) : (
                  <>
                    {genError && <div className="text-xs text-destructive bg-destructive/10 px-2 py-1 rounded">{genError}</div>}
                    <div>
                      <label className="block text-xs text-muted-foreground mb-0.5">{t.genGenre}</label>
                      <input type="text" value={genGenre} onChange={(e) => setGenGenre(e.target.value)} placeholder={t.genGenrePlaceholder} className="w-full px-2 py-1 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                    </div>
                    <div>
                      <label className="block text-xs text-muted-foreground mb-0.5">{t.genSetting}</label>
                      <input type="text" value={genSetting} onChange={(e) => setGenSetting(e.target.value)} placeholder={t.genSettingPlaceholder} className="w-full px-2 py-1 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-xs text-muted-foreground mb-0.5">{t.genTone}</label>
                        <select value={genTone} onChange={(e) => setGenTone(e.target.value)} className="w-full px-2 py-1 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring">
                          <option value="">{t.genToneNone}</option>
                          <option value="暗黑">暗黑 / Dark</option>
                          <option value="轻松">轻松 / Light</option>
                          <option value="史诗">史诗 / Epic</option>
                          <option value="写实">写实 / Realistic</option>
                        </select>
                      </div>
                      <div className="flex-1">
                        <label className="block text-xs text-muted-foreground mb-0.5">{t.genExtra}</label>
                        <input type="text" value={genExtra} onChange={(e) => setGenExtra(e.target.value)} placeholder={t.genExtraPlaceholder} className="w-full px-2 py-1 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                      </div>
                    </div>
                    <div className="flex gap-2 pt-1">
                      <button onClick={handleGenerate} disabled={!genGenre.trim()} className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed">{t.genSubmit}</button>
                      <button onClick={() => setShowGenForm(false)} className="px-3 py-1 text-xs text-muted-foreground hover:text-foreground">{t.genCancel}</button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <textarea
            value={content}
            onChange={handleChange}
            onBlur={handleBlur}
            className="flex-1 w-full p-4 bg-background text-foreground text-sm font-mono resize-none focus:outline-none leading-relaxed"
            placeholder={t.editorPlaceholder}
            spellCheck={false}
          />
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="border-b">
            <button
              onClick={() => setShowMeta(!showMeta)}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50"
            >
              <span className="text-[10px]">{showMeta ? '▼' : '▶'}</span>
              <span>{t.metaSection}</span>
              {parsed.meta.name && <span className="text-muted-foreground/50 ml-1">— {parsed.meta.name}</span>}
            </button>
            {showMeta && (
              <div className="px-3 pb-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                <div>
                  <label className="block text-[10px] text-muted-foreground">{t.metaName}</label>
                  <input type="text" value={parsed.meta.name} onChange={(e) => updateMeta({ name: e.target.value })} className="w-full px-1.5 py-0.5 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div>
                  <label className="block text-[10px] text-muted-foreground">{t.metaGenre}</label>
                  <input type="text" value={parsed.meta.genre} onChange={(e) => updateMeta({ genre: e.target.value })} className="w-full px-1.5 py-0.5 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] text-muted-foreground">{t.metaDesc}</label>
                  <input type="text" value={parsed.meta.description} onChange={(e) => updateMeta({ description: e.target.value })} className="w-full px-1.5 py-0.5 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div>
                  <label className="block text-[10px] text-muted-foreground">{t.metaTags}</label>
                  <input type="text" value={parsed.meta.tags.join(', ')} onChange={(e) => updateMeta({ tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} className="w-full px-1.5 py-0.5 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div>
                  <label className="block text-[10px] text-muted-foreground">{t.metaPlugins}</label>
                  <input type="text" value={parsed.meta.plugins.join(', ')} onChange={(e) => updateMeta({ plugins: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} className="w-full px-1.5 py-0.5 text-xs bg-background border border-input rounded text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
              </div>
            )}
          </div>
          <textarea
            value={parsed.body}
            onChange={handleBodyChange}
            onPaste={handleBodyPaste}
            onBlur={handleBlur}
            className="flex-1 w-full p-4 bg-background text-foreground text-sm font-mono resize-none focus:outline-none leading-relaxed"
            placeholder={t.editorPlaceholder}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  )
}
