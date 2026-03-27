import { useState, useEffect, useCallback } from 'react'
import { Server, Settings, Monitor, ShieldCheck, ShieldAlert, Cpu, Eye, EyeOff, Activity, RefreshCcw, Save, Check } from 'lucide-react'
import type { PresetModel } from '../../types'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import * as api from '../../services/api'
import type { LlmInfo } from '../../services/api'
import {
  getBrowserLlmConfig,
  saveBrowserLlmConfig,
  clearBrowserLlmConfig,
} from '../../utils/browserLlmConfig'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'

const T = {
  zh: {
    effectiveLabel: '当前生效',
    sourceEnv: '服务器环境变量',
    sourceProject: '项目配置',
    sourceBrowser: '浏览器本地',
    sourceDefault: '系统默认',
    keySet: 'API Key 已配置',
    keyServer: '服务器已配置',
    keyNotSet: '未配置',
    cloudProviders: '云端服务',
    localProviders: '本地兼容',
    customSection: '自定义（OpenAI 兼容）',
    customNote: '任何兼容 OpenAI 格式的服务均可使用：填写 API Base URL，模型名用 openai/<model-name> 格式。',
    model: '模型',
    modelPlaceholder: '例：deepseek/deepseek-chat',
    apiKey: 'API Key',
    apiKeyPlaceholder: '输入 API Key',
    apiKeyNote: '仅存储在你的浏览器中，不会上传到服务器',
    apiBase: 'API Base URL（可选）',
    apiBasePlaceholder: '例：https://api.deepseek.com',
    pluginSection: '插件模型（可选）',
    pluginModel: '插件模型',
    pluginApiKey: '插件 API Key',
    pluginApiBase: '插件 API Base',
    pluginModelPlaceholder: '例：openai/llama3.2',
    pluginApiKeyPlaceholder: '输入 API Key',
    pluginApiBasePlaceholder: '例：http://localhost:11434/v1',
    pluginSameAsMain: '与主模型相同',
    pluginCustom: '自定义模型',
    imageSection: '图片生成（可选）',
    imageModel: '图片模型',
    imageApiKey: '图片 API Key',
    imageApiBase: '图片 API Base',
    imageApiBaseAutoSuffix: '自动补全 /v1/chat/completions',
    imageApiBaseAutoSuffixHint: '将自动在 URL 末尾追加 /v1/chat/completions',
    imageApiBaseManualHint: '请输入完整的 API 端点地址',
    save: '保存配置',
    saving: '保存中...',
    saved: '已保存',
    reset: '恢复默认设置',
    test: '测试连接',
    testing: '测试中...',
    testOk: '连接成功',
    testFail: '连接失败',
  },
  en: {
    effectiveLabel: 'Effective',
    sourceEnv: 'Server .env',
    sourceProject: 'Project',
    sourceBrowser: 'Browser (local)',
    sourceDefault: 'Default',
    keySet: 'API Key set',
    keyServer: 'Set on server',
    keyNotSet: 'Not set',
    cloudProviders: 'Cloud',
    localProviders: 'Local (OpenAI-compat)',
    customSection: 'Custom (OpenAI-compatible)',
    customNote: 'Any OpenAI-compatible service works: set API Base URL and use openai/<model-name> as the model.',
    model: 'Model',
    modelPlaceholder: 'e.g. deepseek/deepseek-chat',
    apiKey: 'API Key',
    apiKeyPlaceholder: 'Enter API Key',
    apiKeyNote: 'Stored in your browser only — never uploaded to the server',
    apiBase: 'API Base URL (optional)',
    apiBasePlaceholder: 'e.g. https://api.deepseek.com',
    pluginSection: 'Plugin Model (optional)',
    pluginModel: 'Plugin Model',
    pluginApiKey: 'Plugin API Key',
    pluginApiBase: 'Plugin API Base',
    pluginModelPlaceholder: 'e.g. openai/llama3.2',
    pluginApiKeyPlaceholder: 'Enter API Key',
    pluginApiBasePlaceholder: 'e.g. http://localhost:11434/v1',
    pluginSameAsMain: 'Same as main model',
    pluginCustom: 'Custom model',
    imageSection: 'Image Generation (optional)',
    imageModel: 'Image Model',
    imageApiKey: 'Image API Key',
    imageApiBase: 'Image API Base',
    imageApiBaseAutoSuffix: 'Auto-append /v1/chat/completions',
    imageApiBaseAutoSuffixHint: 'Will auto-append /v1/chat/completions to the URL',
    imageApiBaseManualHint: 'Enter the full API endpoint URL',
    save: 'Save Config',
    saving: 'Saving...',
    saved: 'Saved',
    reset: 'Reset to Defaults',
    test: 'Test Connection',
    testing: 'Testing...',
    testOk: 'Connected',
    testFail: 'Failed',
  },
}

// OpenAI-compatible local service presets
const LOCAL_PRESETS = [
  { id: 'ollama', name: 'Ollama', model: 'openai/llama3.2', apiBase: 'http://localhost:11434/v1', apiKey: 'ollama' },
  { id: 'lmstudio', name: 'LM Studio', model: 'openai/local-model', apiBase: 'http://localhost:1234/v1', apiKey: 'lm-studio' },
  { id: 'openai-compat', name: '自定义', name_en: 'Custom', model: 'openai/', apiBase: '', apiKey: '' },
]

// Friendly provider display names
const PROVIDER_NAMES: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  google: 'Google',
}

interface Props {
  onLlmInfoChange?: (info: LlmInfo | null) => void
}

export function ModelSettings({ onLlmInfoChange }: Props) {
  const { currentProject, updateProject } = useProjectStore()
  const { language } = useUiStore()
  const t = T[language === 'zh' ? 'zh' : 'en']

  const [llmInfo, setLlmInfo] = useState<LlmInfo | null>(null)
  const [presets, setPresets] = useState<PresetModel[]>([])
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiBase, setApiBase] = useState('')
  const [pluginModel, setPluginModel] = useState('')
  const [pluginApiKey, setPluginApiKey] = useState('')
  const [pluginApiBase, setPluginApiBase] = useState('')
  const [pluginUseSameModel, setPluginUseSameModel] = useState(true)
  const [showPlugin, setShowPlugin] = useState(false)
  const [imageModel, setImageModel] = useState('')
  const [imageApiKey, setImageApiKey] = useState('')
  const [imageApiBase, setImageApiBase] = useState('')
  const [imageApiBaseAutoSuffix, setImageApiBaseAutoSuffix] = useState(true)
  const [showImage, setShowImage] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latency_ms: number; reply?: string; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const loadLlmInfo = useCallback(() => {
    api
      .getLlmInfo(currentProject?.id)
      .then((info) => {
        setLlmInfo(info)
        onLlmInfoChange?.(info)
      })
      .catch((err) => console.warn('[modelSettings] getLlmInfo', err))
  }, [currentProject?.id, onLlmInfoChange])

  useEffect(() => {
    loadLlmInfo()
    api.getPresetModels().then(setPresets).catch((err) => console.warn('[modelSettings] getPresets', err))
  }, [loadLlmInfo])

  useEffect(() => {
    if (!currentProject) return
    const local = getBrowserLlmConfig(currentProject.id)
    setModel(local.model || currentProject.llm_model || '')
    setApiKey(local.apiKey || '')
    setApiBase(local.apiBase || currentProject.llm_api_base || '')
    setPluginModel(local.pluginModel || '')
    setPluginApiKey(local.pluginApiKey || '')
    setPluginApiBase(local.pluginApiBase || '')
    setPluginUseSameModel(!local.pluginModel)
    setImageModel(local.imageModel || currentProject.image_model || '')
    setImageApiKey(local.imageApiKey || '')
    setImageApiBase(local.imageApiBase || currentProject.image_api_base || '')
    setImageApiBaseAutoSuffix(local.imageApiBaseAutoSuffix !== false)
  }, [currentProject?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Backfill model/apiBase from llmInfo when no explicit config is saved
  useEffect(() => {
    if (!llmInfo || !currentProject) return
    const local = getBrowserLlmConfig(currentProject.id)
    const hasExplicitModel = !!(local.model || currentProject.llm_model)
    if (!hasExplicitModel && llmInfo.model) {
      setModel((prev) => prev || llmInfo.model)
    }
    const hasExplicitBase = !!(local.apiBase || currentProject.llm_api_base)
    if (!hasExplicitBase && llmInfo.api_base) {
      setApiBase((prev) => prev || llmInfo.api_base || '')
    }
  }, [llmInfo, currentProject])

  // Determine where the current config comes from
  const getConfigSource = () => {
    const local = currentProject ? getBrowserLlmConfig(currentProject.id) : {}
    if (local.apiKey || local.model) return { label: t.sourceBrowser, icon: Monitor, variant: 'default' as const }
    if (currentProject?.llm_model || currentProject?.has_llm_api_key) return { label: t.sourceProject, icon: Settings, variant: 'secondary' as const }
    if (llmInfo?.source === 'env') return { label: t.sourceEnv, icon: Server, variant: 'outline' as const }
    return { label: t.sourceDefault, icon: Cpu, variant: 'outline' as const }
  }

  const sourceConfig = getConfigSource()
  const SourceIcon = sourceConfig.icon

  const apiKeyStatus = (): { label: string; ok: boolean } => {
    const local = currentProject ? getBrowserLlmConfig(currentProject.id) : {}
    if (local.apiKey) return { label: `${t.keySet} (${t.sourceBrowser})`, ok: true }
    if (llmInfo?.has_key) return { label: t.keyServer, ok: true }
    return { label: t.keyNotSet, ok: false }
  }

  // Group presets by provider
  const presetGroups = presets.reduce<Record<string, PresetModel[]>>((acc, p) => {
    const key = p.provider || 'other'
    ;(acc[key] ??= []).push(p)
    return acc
  }, {})

  const handlePresetClick = (preset: PresetModel) => {
    setModel(preset.model)
    setApiBase(preset.api_base || '')
    // preserve existing apiKey — user may have already entered one
  }

  const handleSave = async () => {
    if (!currentProject) return
    setSaving(true)
    try {
      // If user hasn't explicitly set model/apiBase, use the effective values from llmInfo
      const effectiveModel = model || llmInfo?.model || ''
      const effectiveApiBase = apiBase || llmInfo?.api_base || ''
      saveBrowserLlmConfig(currentProject.id, {
        model: effectiveModel || undefined,
        apiKey: apiKey || undefined,
        apiBase: effectiveApiBase || undefined,
        pluginModel: pluginUseSameModel ? undefined : (pluginModel || undefined),
        pluginApiKey: pluginUseSameModel ? undefined : (pluginApiKey || undefined),
        pluginApiBase: pluginUseSameModel ? undefined : (pluginApiBase || undefined),
        imageModel: imageModel || undefined,
        imageApiKey: imageApiKey || undefined,
        imageApiBase: imageApiBase || undefined,
        imageApiBaseAutoSuffix: imageApiBaseAutoSuffix,
      })
      setModel(effectiveModel)
      setApiBase(effectiveApiBase)
      await updateProject({
        llm_model: effectiveModel || undefined,
        llm_api_key: '',
        llm_api_base: effectiveApiBase || undefined,
        image_model: imageModel || undefined,
        image_api_key: '',
        image_api_base: imageApiBase || undefined,
      })
      loadLlmInfo()
      setSavedMsg(true)
      setTimeout(() => setSavedMsg(false), 2500)
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    if (!currentProject) return
    setSaving(true)
    try {
      clearBrowserLlmConfig(currentProject.id)
      await updateProject({
        llm_model: undefined,
        llm_api_key: '',
        llm_api_base: undefined,
        image_model: undefined,
        image_api_key: '',
        image_api_base: undefined,
      })
      setModel('')
      setApiKey('')
      setApiBase('')
      setPluginModel('')
      setPluginApiKey('')
      setPluginApiBase('')
      setPluginUseSameModel(true)
      setImageModel('')
      setImageApiKey('')
      setImageApiBase('')
      setImageApiBaseAutoSuffix(true)
      loadLlmInfo()
    } finally {
      setSaving(false)
    }
  }

  const keyStatus = apiKeyStatus()

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await api.testLlm()
      setTestResult(res)
    } catch (e) {
      setTestResult({ ok: false, latency_ms: 0, error: e instanceof Error ? e.message : 'Unknown error' })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex min-h-0 h-full flex-col bg-background">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-4">
          {/* Current effective config banner */}
          <Card className="bg-muted/30 border-muted">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t.effectiveLabel}</span>
                <Badge variant={sourceConfig.variant} className="flex items-center gap-1 text-[10px] font-normal h-5">
                  <SourceIcon className="w-3 h-3" />
                  {sourceConfig.label}
                </Badge>
              </div>
              <div className="font-mono text-primary font-medium truncate">
                {llmInfo?.model || '—'}
              </div>
              <div className="flex items-center justify-between pt-1">
                <div className="flex items-center gap-2 text-xs">
                  {keyStatus.ok ? (
                    <ShieldCheck className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-muted-foreground" />
                  )}
                  <span className={keyStatus.ok ? 'text-foreground font-medium' : 'text-muted-foreground'}>
                    {keyStatus.label}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs px-2.5"
                  onClick={handleTest}
                  disabled={testing || !keyStatus.ok}
                >
                  {testing ? (
                    <><RefreshCcw className="w-3 h-3 mr-1.5 animate-spin" />{t.testing}</>
                  ) : (
                    <><Activity className="w-3 h-3 mr-1.5" />{t.test}</>
                  )}
                </Button>
              </div>
              {testResult && (
                <div className={`text-xs px-3 py-2 rounded-md flex flex-col gap-1 border ${
                  testResult.ok 
                    ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400' 
                    : 'bg-destructive/10 text-destructive border-destructive/20'
                }`}>
                  <div className="flex items-center font-medium">
                    {testResult.ok ? t.testOk : t.testFail}
                    {testResult.ok && <span className="ml-2 opacity-80 font-normal">— {testResult.latency_ms}ms</span>}
                  </div>
                  {testResult.ok && testResult.reply ? (
                    <div className="font-mono text-[10px] opacity-80 truncate">"{testResult.reply.slice(0, 60)}..."</div>
                  ) : testResult.error ? (
                    <div className="opacity-80 break-words">{testResult.error}</div>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick preset buttons — cloud providers */}
          {Object.keys(presetGroups).length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Separator className="flex-1" />
                <span className="text-xs font-medium text-muted-foreground uppercase">{t.cloudProviders}</span>
                <Separator className="flex-1" />
              </div>
              <div className="space-y-4">
                {Object.entries(presetGroups).map(([provider, items]) => (
                  <div key={provider} className="space-y-2">
                    <div className="text-[11px] font-medium text-muted-foreground">
                      {PROVIDER_NAMES[provider] || provider}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {items.map((p) => (
                        <Button
                          key={p.id}
                          variant={model === p.model && (model || p.model) ? 'default' : 'outline'}
                          size="sm"
                          className="h-7 text-xs"
                          onClick={() => handlePresetClick(p)}
                        >
                          {language === 'en' && p.name_en ? p.name_en : p.name}
                        </Button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Local / OpenAI-compatible presets */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Separator className="flex-1" />
              <span className="text-xs font-medium text-muted-foreground uppercase">{t.localProviders}</span>
              <Separator className="flex-1" />
            </div>
            <div className="flex flex-wrap gap-2 mb-2">
              {LOCAL_PRESETS.map((p) => (
                <Button
                  key={p.id}
                  variant={apiBase === p.apiBase && p.apiBase ? 'secondary' : 'outline'}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => {
                    setModel(p.model)
                    setApiBase(p.apiBase)
                    setApiKey(p.apiKey)
                  }}
                >
                  {language === 'en' && 'name_en' in p && p.name_en ? p.name_en : p.name}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t.customNote}</p>
          </div>

          <div className="space-y-4">
            {/* Model */}
            <div className="space-y-2">
              <Label htmlFor="model" className="text-xs text-muted-foreground">{t.model}</Label>
              <Input
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={llmInfo?.model || t.modelPlaceholder}
                className="font-mono text-sm"
              />
            </div>

            {/* API Key */}
            <div className="space-y-2">
              <Label htmlFor="apiKey" className="text-xs text-muted-foreground">{t.apiKey}</Label>
              <Input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={llmInfo?.has_key ? `(${t.keyServer})` : t.apiKeyPlaceholder}
                className="font-mono text-sm"
              />
              <p className="text-[11px] text-muted-foreground">{t.apiKeyNote}</p>
            </div>

            {/* API Base */}
            <div className="space-y-2">
              <Label htmlFor="apiBase" className="text-xs text-muted-foreground">{t.apiBase}</Label>
              <Input
                id="apiBase"
                value={apiBase}
                onChange={(e) => setApiBase(e.target.value)}
                placeholder={llmInfo?.api_base || t.apiBasePlaceholder}
                className="font-mono text-sm"
              />
            </div>
          </div>

          {/* Plugin model — collapsible */}
          <div className="pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between px-2 text-xs font-medium text-muted-foreground hover:text-foreground mb-2"
              onClick={() => setShowPlugin(!showPlugin)}
            >
              <span className="flex items-center gap-2">
                <Cpu className="w-3.5 h-3.5" />
                {t.pluginSection}
              </span>
              {showPlugin ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </Button>

            {showPlugin && (
              <div className="space-y-4 p-4 bg-muted/20 border rounded-lg">
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setPluginUseSameModel(true)}
                    className={`flex-1 text-xs py-1.5 rounded-md border transition-colors ${
                      pluginUseSameModel
                        ? 'bg-primary/10 border-primary/40 text-primary font-medium'
                        : 'border-input text-muted-foreground hover:text-foreground hover:border-foreground/30'
                    }`}
                  >
                    {t.pluginSameAsMain}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPluginUseSameModel(false)}
                    className={`flex-1 text-xs py-1.5 rounded-md border transition-colors ${
                      !pluginUseSameModel
                        ? 'bg-primary/10 border-primary/40 text-primary font-medium'
                        : 'border-input text-muted-foreground hover:text-foreground hover:border-foreground/30'
                    }`}
                  >
                    {t.pluginCustom}
                  </button>
                </div>
                <div className={`space-y-4 transition-opacity ${pluginUseSameModel ? 'opacity-40 pointer-events-none' : ''}`}>
                  <div className="space-y-2">
                    <Label htmlFor="pluginModel" className="text-xs text-muted-foreground">{t.pluginModel}</Label>
                    <Input
                      id="pluginModel"
                      value={pluginModel}
                      onChange={(e) => setPluginModel(e.target.value)}
                      placeholder={t.pluginModelPlaceholder}
                      disabled={pluginUseSameModel}
                      className="font-mono text-sm h-8"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pluginApiKey" className="text-xs text-muted-foreground">{t.pluginApiKey}</Label>
                    <Input
                      id="pluginApiKey"
                      type="password"
                      value={pluginApiKey}
                      onChange={(e) => setPluginApiKey(e.target.value)}
                      placeholder={t.pluginApiKeyPlaceholder}
                      disabled={pluginUseSameModel}
                      className="font-mono text-sm h-8"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pluginApiBase" className="text-xs text-muted-foreground">{t.pluginApiBase}</Label>
                    <Input
                      id="pluginApiBase"
                      value={pluginApiBase}
                      onChange={(e) => setPluginApiBase(e.target.value)}
                      placeholder={t.pluginApiBasePlaceholder}
                      disabled={pluginUseSameModel}
                      className="font-mono text-sm h-8"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Image generation — collapsible */}
          <div className="pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between px-2 text-xs font-medium text-muted-foreground hover:text-foreground mb-2"
              onClick={() => setShowImage(!showImage)}
            >
              <span className="flex items-center gap-2">
                <Monitor className="w-3.5 h-3.5" />
                {t.imageSection}
              </span>
              {showImage ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </Button>
            
            {showImage && (
              <div className="space-y-4 p-4 bg-muted/20 border rounded-lg">
                <div className="space-y-2">
                  <Label htmlFor="imageModel" className="text-xs text-muted-foreground">{t.imageModel}</Label>
                  <Input
                    id="imageModel"
                    value={imageModel}
                    onChange={(e) => setImageModel(e.target.value)}
                    placeholder={currentProject?.image_model || 'gemini-2.5-flash-image-preview'}
                    className="font-mono text-sm h-8"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="imageApiKey" className="text-xs text-muted-foreground">{t.imageApiKey}</Label>
                  <Input
                    id="imageApiKey"
                    type="password"
                    value={imageApiKey}
                    onChange={(e) => setImageApiKey(e.target.value)}
                    placeholder={currentProject?.has_image_api_key ? '(set)' : t.apiKeyPlaceholder}
                    className="font-mono text-sm h-8"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="imageApiBase" className="text-xs text-muted-foreground">{t.imageApiBase}</Label>
                    <button
                      type="button"
                      onClick={() => setImageApiBaseAutoSuffix(!imageApiBaseAutoSuffix)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                        imageApiBaseAutoSuffix
                          ? 'bg-primary/10 border-primary/30 text-primary'
                          : 'bg-muted border-muted-foreground/20 text-muted-foreground'
                      }`}
                    >
                      {imageApiBaseAutoSuffix ? t.imageApiBaseAutoSuffix : t.imageApiBaseAutoSuffix}
                    </button>
                  </div>
                  <Input
                    id="imageApiBase"
                    value={imageApiBase}
                    onChange={(e) => setImageApiBase(e.target.value)}
                    placeholder={imageApiBaseAutoSuffix ? 'https://api.example.com' : 'https://api.example.com/v1/chat/completions'}
                    className="font-mono text-sm h-8"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    {imageApiBaseAutoSuffix ? t.imageApiBaseAutoSuffixHint : t.imageApiBaseManualHint}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      <div className="shrink-0 border-t bg-background p-4 flex gap-2">
        <Button
          variant="outline"
          className="flex-1 text-xs"
          onClick={handleReset}
          disabled={saving}
        >
          {t.reset}
        </Button>
        <Button
          className="flex-1 text-xs font-medium"
          onClick={handleSave}
          disabled={saving}
        >
          {savedMsg ? (
            <><Check className="w-3.5 h-3.5 mr-1.5" />{t.saved}</>
          ) : saving ? (
            <><RefreshCcw className="w-3.5 h-3.5 mr-1.5 animate-spin" />{t.saving}</>
          ) : (
            <><Save className="w-3.5 h-3.5 mr-1.5" />{t.save}</>
          )}
        </Button>
      </div>
    </div>
  )
}
