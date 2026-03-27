import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { FilePlus2, Sparkles, BookTemplate, ArrowLeft, Loader2 } from 'lucide-react'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import * as api from '../../services/api'
import type { WorldTemplate } from '../../types'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type Step = 'info' | 'world'
type WorldMode = null | 'blank' | 'template' | 'ai'

interface Props {
  open: boolean
  onClose: () => void
}

const wizardText: Record<string, Record<string, string>> = {
  zh: {
    titleInfo: '创建新世界',
    titleWorld: '选择世界设定',
    stepInfo: '步骤 1/2 - 基本信息',
    stepWorld: '步骤 2/2 - 世界文档',
    projectName: '项目名称',
    projectNamePlaceholder: '我的史诗冒险',
    descriptionOptional: '项目描述（可选）',
    descriptionPlaceholder: '简要描述你的游戏世界...',
    blankStart: '空白开始',
    blankStartDesc: '从空白开始，在编辑器中自由编写世界文档',
    chooseTemplate: '选择模板',
    chooseTemplateDesc: '从预设世界模板中选择一个作为起点',
    aiGeneration: 'AI 生成',
    aiGenerationDesc: '描述你的世界，让 AI 自动生成完整设定',
    back: '返回',
    loadingTemplates: '加载模板中...',
    templateSearchPlaceholder: '搜索模板名称、题材、标签...',
    templateLanguageFilter: '语言筛选',
    templateFilterAll: '全部',
    templateAvailableCount: '可选模板',
    noTemplateMatch: '没有匹配的模板',
    noTemplateMatchHint: '试试修改关键词或语言筛选条件',
    genre: '题材',
    chooseDifferentTemplate: '选择其他模板',
    loadingContent: '加载内容中...',
    generatingWorldTitle: 'AI 正在生成你的世界...',
    generatingWorldHint: '这可能需要一点时间',
    genreTheme: '类型 / 题材',
    genreThemePlaceholder: '例如：暗黑奇幻、赛博朋克、武侠...',
    worldSettingOptional: '世界设定摘要（可选）',
    worldSettingPlaceholder: '描述你世界的核心设定...',
    narrativeToneOptional: '叙事基调（可选）',
    any: '任意',
    toneDark: '暗黑',
    toneLight: '轻松',
    toneEpic: '史诗',
    toneRealistic: '写实',
    generationLanguage: '生成语言',
    langZh: '中文',
    langEn: 'English',
    langJa: '日本語',
    langKo: '한국어',
    extraOptional: '补充说明（可选）',
    extraPlaceholder: '任何其他具体要求...',
    generatedResultEditable: '生成结果（可编辑）',
    previous: '上一步',
    cancel: '取消',
    next: '下一步',
    creating: '创建中...',
    createProject: '创建项目',
    useTemplate: '使用模板',
    generateWorld: '生成世界',
    generateFailed: '生成失败，请重试',
  },
  en: {
    titleInfo: 'Create New World',
    titleWorld: 'Choose World Setting',
    stepInfo: 'Step 1/2 - Basic Information',
    stepWorld: 'Step 2/2 - World Document',
    projectName: 'Project Name',
    projectNamePlaceholder: 'My Epic Quest',
    descriptionOptional: 'Description (Optional)',
    descriptionPlaceholder: 'Briefly describe your game world...',
    blankStart: 'Blank Start',
    blankStartDesc: 'Start from scratch and write the world document freely in the editor',
    chooseTemplate: 'Choose Template',
    chooseTemplateDesc: 'Select one of the preset world templates as a starting point',
    aiGeneration: 'AI Generation',
    aiGenerationDesc: 'Describe your world and let AI generate the complete setting automatically',
    back: 'Back',
    loadingTemplates: 'Loading templates...',
    templateSearchPlaceholder: 'Search by name, genre, or tags...',
    templateLanguageFilter: 'Language',
    templateFilterAll: 'All',
    templateAvailableCount: 'Templates',
    noTemplateMatch: 'No matching templates',
    noTemplateMatchHint: 'Try another keyword or language filter',
    genre: 'Genre',
    chooseDifferentTemplate: 'Choose different template',
    loadingContent: 'Loading content...',
    generatingWorldTitle: 'AI is generating your world...',
    generatingWorldHint: 'This may take a moment',
    genreTheme: 'Genre / Theme',
    genreThemePlaceholder: 'e.g. Dark Fantasy, Cyberpunk, Wuxia...',
    worldSettingOptional: 'World Setting Summary (Optional)',
    worldSettingPlaceholder: 'Describe the core setting of your world...',
    narrativeToneOptional: 'Narrative Tone (Optional)',
    any: 'Any',
    toneDark: 'Dark',
    toneLight: 'Light-hearted',
    toneEpic: 'Epic',
    toneRealistic: 'Realistic',
    generationLanguage: 'Generation Language',
    langZh: '中文',
    langEn: 'English',
    langJa: '日本語',
    langKo: '한국어',
    extraOptional: 'Additional Notes (Optional)',
    extraPlaceholder: 'Any other specific requirements...',
    generatedResultEditable: 'Generated Result (Editable)',
    previous: 'Previous',
    cancel: 'Cancel',
    next: 'Next',
    creating: 'Creating...',
    createProject: 'Create Project',
    useTemplate: 'Use Template',
    generateWorld: 'Generate World',
    generateFailed: 'Generation failed, please try again',
  },
}

export function CreateProjectWizard({ open, onClose }: Props) {
  const navigate = useNavigate()
  const { createProject } = useProjectStore()
  const language = useUiStore((s) => s.language)
  const t = wizardText[language] ?? wizardText.en

  // Step 1: basic info
  const [step, setStep] = useState<Step>('info')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  // Step 2: world setup
  const [worldMode, setWorldMode] = useState<WorldMode>(null)
  const [templates, setTemplates] = useState<WorldTemplate[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(false)
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [previewContent, setPreviewContent] = useState('')
  const [rawTemplateContent, setRawTemplateContent] = useState('')
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [templateQuery, setTemplateQuery] = useState('')
  const [templateLanguageFilter, setTemplateLanguageFilter] = useState<'all' | 'zh' | 'en'>('all')

  // AI generation
  const [aiGenre, setAiGenre] = useState('')
  const [aiSetting, setAiSetting] = useState('')
  const [aiTone, setAiTone] = useState('')
  const [aiLang, setAiLang] = useState('zh')
  const [aiExtra, setAiExtra] = useState('')
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [generatedDoc, setGeneratedDoc] = useState('')

  const [creating, setCreating] = useState(false)

  // Reset state when opening/closing
  useEffect(() => {
    if (open) {
      setStep('info')
      setName('')
      setDescription('')
      setWorldMode(null)
      setTemplates([])
      setSelectedSlug(null)
      setPreviewContent('')
      setTemplateQuery('')
      setTemplateLanguageFilter('all')
      setAiGenre('')
      setAiSetting('')
      setAiTone('')
      setAiLang('zh')
      setAiExtra('')
      setGenerateError('')
      setGeneratedDoc('')
    }
  }, [open])

  // Load templates when selecting template mode
  useEffect(() => {
    if (worldMode !== 'template') return
    setLoadingTemplates(true)
    api.getWorldTemplates(language).then(setTemplates).finally(() => setLoadingTemplates(false))
  }, [worldMode, language])

  const handleSelectTemplate = async (slug: string) => {
    setSelectedSlug(slug)
    setLoadingPreview(true)
    try {
      const detail = await api.getWorldTemplate(slug, language)
      setPreviewContent(detail.content)
      setRawTemplateContent(detail.raw)
    } finally {
      setLoadingPreview(false)
    }
  }

  const filteredTemplates = useMemo(() => {
    const query = templateQuery.trim().toLowerCase()
    const preferredLang = language === 'zh' ? 'zh' : 'en'

    return templates
      .filter((template) => {
        const lang = (template.language || '').toLowerCase()
        if (templateLanguageFilter !== 'all' && !lang.startsWith(templateLanguageFilter)) {
          return false
        }
        if (!query) return true
        const haystack = [
          template.name,
          template.description,
          template.genre,
          ...template.tags,
        ]
          .join(' ')
          .toLowerCase()
        return haystack.includes(query)
      })
      .sort((a, b) => {
        const aPreferred = (a.language || '').toLowerCase().startsWith(preferredLang) ? 0 : 1
        const bPreferred = (b.language || '').toLowerCase().startsWith(preferredLang) ? 0 : 1
        if (aPreferred !== bPreferred) return aPreferred - bPreferred
        return a.name.localeCompare(b.name)
      })
  }, [templates, templateQuery, templateLanguageFilter, language])

  const formatTemplateLanguage = (templateLanguage: string) => {
    const normalized = (templateLanguage || '').toLowerCase()
    if (normalized.startsWith('zh')) return t.langZh
    if (normalized.startsWith('en')) return t.langEn
    return templateLanguage ? templateLanguage.toUpperCase() : t.templateFilterAll
  }

  const handleGenerate = async () => {
    if (!aiGenre.trim()) return
    setGenerating(true)
    setGenerateError('')
    try {
      let doc = ''
      await api.generateWorldStream(
        {
          genre: aiGenre.trim(),
          setting: aiSetting.trim() || undefined,
          tone: aiTone.trim() || undefined,
          language: aiLang,
          extra_notes: aiExtra.trim() || undefined,
        },
        (chunk) => { doc += chunk; setGeneratedDoc(doc) },
      )
    } catch (err) {
      console.error('Failed to generate world:', err)
      setGenerateError(err instanceof Error ? err.message : t.generateFailed)
    } finally {
      setGenerating(false)
    }
  }

  const handleCreate = async (worldDoc: string) => {
    setCreating(true)
    try {
      const project = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        world_doc: worldDoc,
      })
      onClose()
      navigate(`/projects/${project.id}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[760px] max-h-[85vh] flex flex-col overflow-hidden p-0 gap-0">
        <DialogHeader className="px-6 py-4 border-b shrink-0">
          <DialogTitle className="text-xl">
            {step === 'info' ? t.titleInfo : t.titleWorld}
          </DialogTitle>
          <DialogDescription>
            {step === 'info' ? t.stepInfo : t.stepWorld}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1 px-6 py-4">
          <div className="space-y-4 pb-2">
            {step === 'info' && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="name">{t.projectName}</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t.projectNamePlaceholder}
                    autoFocus
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="desc">{t.descriptionOptional}</Label>
                  <Textarea
                    id="desc"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t.descriptionPlaceholder}
                    className="resize-none"
                    rows={3}
                  />
                </div>
              </div>
            )}

            {step === 'world' && !worldMode && (
              <div className="grid grid-cols-1 gap-3">
                <Card 
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setWorldMode('blank')}
                >
                  <CardHeader className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="p-1.5 bg-primary/10 rounded-md text-primary">
                        <FilePlus2 className="w-4 h-4" />
                      </div>
                      <CardTitle className="text-base">{t.blankStart}</CardTitle>
                    </div>
                    <CardDescription>{t.blankStartDesc}</CardDescription>
                  </CardHeader>
                </Card>
                <Card 
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setWorldMode('template')}
                >
                  <CardHeader className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="p-1.5 bg-primary/10 rounded-md text-primary">
                        <BookTemplate className="w-4 h-4" />
                      </div>
                      <CardTitle className="text-base">{t.chooseTemplate}</CardTitle>
                    </div>
                    <CardDescription>{t.chooseTemplateDesc}</CardDescription>
                  </CardHeader>
                </Card>
                <Card 
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setWorldMode('ai')}
                >
                  <CardHeader className="p-4">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="p-1.5 bg-primary/10 rounded-md text-primary">
                        <Sparkles className="w-4 h-4" />
                      </div>
                      <CardTitle className="text-base">{t.aiGeneration}</CardTitle>
                    </div>
                    <CardDescription>{t.aiGenerationDesc}</CardDescription>
                  </CardHeader>
                </Card>
              </div>
            )}

            {step === 'world' && worldMode === 'template' && (
              <div className="space-y-4">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="gap-2 -ml-2"
                  onClick={() => { setWorldMode(null); setSelectedSlug(null); setPreviewContent('') }}
                >
                  <ArrowLeft className="w-4 h-4" /> {t.back}
                </Button>

                {!selectedSlug ? (
                  loadingTemplates ? (
                    <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-sm">{t.loadingTemplates}</span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-2">
                        <Input
                          value={templateQuery}
                          onChange={(e) => setTemplateQuery(e.target.value)}
                          placeholder={t.templateSearchPlaceholder}
                        />
                        <select
                          value={templateLanguageFilter}
                          onChange={(e) => setTemplateLanguageFilter(e.target.value as 'all' | 'zh' | 'en')}
                          className="h-9 min-w-[130px] bg-background border border-input rounded px-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                          <option value="all">{t.templateLanguageFilter}: {t.templateFilterAll}</option>
                          <option value="zh">{t.templateLanguageFilter}: {t.langZh}</option>
                          <option value="en">{t.templateLanguageFilter}: {t.langEn}</option>
                        </select>
                      </div>

                      <div className="text-xs text-muted-foreground">
                        {t.templateAvailableCount}: {filteredTemplates.length}
                      </div>

                      {filteredTemplates.length === 0 ? (
                        <div className="text-center text-muted-foreground py-10 border rounded-lg bg-muted/20">
                          <p className="text-sm">{t.noTemplateMatch}</p>
                          <p className="text-xs mt-1">{t.noTemplateMatchHint}</p>
                        </div>
                      ) : (
                        <ScrollArea className="max-h-[45vh]">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pr-2">
                            {filteredTemplates.map((template) => (
                              <Card
                                key={template.slug}
                                className="cursor-pointer hover:border-primary/50 transition-colors h-full"
                                onClick={() => handleSelectTemplate(template.slug)}
                              >
                                <CardHeader className="p-4 h-full">
                                  <div className="flex items-start justify-between gap-2">
                                    <CardTitle className="text-base line-clamp-2">{template.name}</CardTitle>
                                    <Badge variant="outline" className="text-[10px] shrink-0">
                                      {formatTemplateLanguage(template.language)}
                                    </Badge>
                                  </div>
                                  <CardDescription className="mt-1 line-clamp-3">
                                    {template.description}
                                  </CardDescription>
                                  <div className="mt-3 flex flex-wrap gap-1.5">
                                    <Badge variant="secondary" className="font-normal text-[10px]">
                                      {t.genre}: {template.genre}
                                    </Badge>
                                    {template.tags.slice(0, 4).map((tag) => (
                                      <Badge key={tag} variant="secondary" className="font-normal text-[10px]">
                                        {tag}
                                      </Badge>
                                    ))}
                                  </div>
                                </CardHeader>
                              </Card>
                            ))}
                          </div>
                        </ScrollArea>
                      )}
                    </div>
                  )
                ) : (
                  <div className="space-y-3">
                    <Button 
                      variant="outline" 
                      size="sm"
                      onClick={() => { setSelectedSlug(null); setPreviewContent('') }}
                    >
                      {t.chooseDifferentTemplate}
                    </Button>
                    {loadingPreview ? (
                      <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm">{t.loadingContent}</span>
                      </div>
                    ) : (
                      <div className="rounded-lg border bg-muted/30">
                        <ScrollArea className="h-[42vh]">
                          <pre className="p-4 text-sm leading-6 whitespace-pre-wrap break-words font-mono text-foreground">
                            {previewContent}
                          </pre>
                        </ScrollArea>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {step === 'world' && worldMode === 'ai' && (
              <div className="space-y-4">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="gap-2 -ml-2"
                  onClick={() => { setWorldMode(null); setGeneratedDoc(''); setGenerateError('') }}
                  disabled={generating}
                >
                  <ArrowLeft className="w-4 h-4" /> {t.back}
                </Button>

                {generating ? (
                  <div className="flex flex-col items-center justify-center py-12 text-muted-foreground gap-4">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    <div className="text-center">
                      <p className="font-medium text-foreground">{t.generatingWorldTitle}</p>
                      <p className="text-sm mt-1">{t.generatingWorldHint}</p>
                    </div>
                  </div>
                ) : !generatedDoc ? (
                  <div className="space-y-4">
                    {generateError && (
                      <div className="p-3 bg-destructive/10 border border-destructive/20 text-destructive rounded-md text-sm">
                        {generateError}
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="genre">{t.genreTheme}</Label>
                      <Input
                        id="genre"
                        value={aiGenre}
                        onChange={(e) => setAiGenre(e.target.value)}
                        placeholder={t.genreThemePlaceholder}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="aiSetting">{t.worldSettingOptional}</Label>
                      <Textarea
                        id="aiSetting"
                        value={aiSetting}
                        onChange={(e) => setAiSetting(e.target.value)}
                        className="resize-none"
                        rows={2}
                        placeholder={t.worldSettingPlaceholder}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="tone">{t.narrativeToneOptional}</Label>
                        <Select value={aiTone || '__any'} onValueChange={(value) => setAiTone(value === '__any' ? '' : value)}>
                          <SelectTrigger id="tone" className="h-9">
                            <SelectValue placeholder={t.any} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__any">{t.any}</SelectItem>
                            <SelectItem value="暗黑">{t.toneDark}</SelectItem>
                            <SelectItem value="轻松">{t.toneLight}</SelectItem>
                            <SelectItem value="史诗">{t.toneEpic}</SelectItem>
                            <SelectItem value="写实">{t.toneRealistic}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="lang">{t.generationLanguage}</Label>
                        <Select value={aiLang} onValueChange={setAiLang}>
                          <SelectTrigger id="lang" className="h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="zh">{t.langZh}</SelectItem>
                            <SelectItem value="en">{t.langEn}</SelectItem>
                            <SelectItem value="ja">{t.langJa}</SelectItem>
                            <SelectItem value="ko">{t.langKo}</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="extra">{t.extraOptional}</Label>
                      <Textarea
                        id="extra"
                        value={aiExtra}
                        onChange={(e) => setAiExtra(e.target.value)}
                        className="resize-none"
                        rows={2}
                        placeholder={t.extraPlaceholder}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 flex flex-col h-[40vh]">
                    <Label>{t.generatedResultEditable}</Label>
                    <Textarea
                      value={generatedDoc}
                      onChange={(e) => setGeneratedDoc(e.target.value)}
                      className="flex-1 resize-none font-mono text-sm min-h-[300px]"
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="relative z-10 px-6 py-4 border-t bg-background sm:justify-between shrink-0">
          <div className="flex-1">
            {step === 'world' && !worldMode && (
              <Button variant="ghost" onClick={() => setStep('info')}>
                {t.previous}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t.cancel}
            </Button>

            {step === 'info' && (
              <Button 
                onClick={() => setStep('world')} 
                disabled={!name.trim()}
              >
                {t.next}
              </Button>
            )}

            {step === 'world' && worldMode === 'blank' && (
              <Button 
                onClick={() => handleCreate('')}
                disabled={creating}
              >
                {creating ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t.creating}</> : t.createProject}
              </Button>
            )}

            {step === 'world' && worldMode === 'template' && selectedSlug && previewContent && !loadingPreview && (
              <Button
                onClick={() => handleCreate(rawTemplateContent || previewContent)}
                disabled={creating}
              >
                {creating ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t.creating}</> : t.useTemplate}
              </Button>
            )}

            {step === 'world' && worldMode === 'ai' && !generatedDoc && !generating && (
              <Button 
                onClick={handleGenerate}
                disabled={!aiGenre.trim()}
              >
                <Sparkles className="w-4 h-4 mr-2" />
                {t.generateWorld}
              </Button>
            )}

            {step === 'world' && worldMode === 'ai' && generatedDoc && (
              <Button 
                onClick={() => handleCreate(generatedDoc)}
                disabled={creating}
              >
                {creating ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t.creating}</> : t.createProject}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
