import { useState, useEffect, useRef } from 'react'
import type { LlmProfile, PresetModel } from '../../types'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'
import * as api from '../../services/api'
import type { LlmInfo } from '../../services/api'
import {
  clearBrowserLlmConfig,
  getBrowserLlmConfig,
  saveBrowserLlmConfig,
} from '../../utils/browserLlmConfig'

interface Props {
  llmInfo: LlmInfo | null
  onClose: () => void
  onSaved: () => void
}

const modelPanelText: Record<string, Record<string, string>> = {
  zh: {
    title: '模型配置',
    modelPreset: '模型预设',
    selectPreset: '-- 选择一个预设 --',
    custom: '自定义...',
    savedProfile: '已保存配置',
    useGlobalDefault: '-- 使用全局默认 --',
    deletePreset: '删除预设',
    deleteShort: '删',
    model: '模型',
    apiKey: 'API Key',
    apiBase: 'API Base',
    pluginLlm: '插件模型（可选）',
    pluginModel: '插件模型',
    pluginApiKey: '插件 API Key',
    pluginApiBase: '插件 API Base',
    pluginModelPlaceholder: '例：openai/llama3.2',
    pluginApiKeyPlaceholder: '输入 API Key',
    pluginApiBasePlaceholder: '例：http://localhost:11434/v1',
    pluginSameAsMain: '与主模型相同',
    pluginCustom: '自定义模型',
    pluginReasoning: '插件推理',
    reasoningNone: '关闭',
    reasoningLow: '低',
    reasoningMedium: '中',
    reasoningHigh: '高',
    imageGeneration: '图片生成',
    imageModel: '图片模型',
    imageApiKey: '图片 API Key',
    imageApiBase: '图片 API Base',
    imageApiBaseAutoSuffix: '自动补全 /v1/chat/completions',
    imageApiBaseAutoSuffixHint: '将自动在 URL 末尾追加 /v1/chat/completions',
    imageApiBaseManualHint: '请输入完整的 API 端点地址',
    saving: '保存中...',
    saveToProject: '保存到项目',
    saveAsPreset: '另存为预设',
    presetNamePlaceholder: '预设名称，例如 GPT-4o',
    confirm: '确认',
    cancel: '取消',
    resetToGlobal: '重置为全局默认',
    sourceBrowser: '浏览器',
    sourceProject: '项目',
    sourceEnv: '.env',
    sourceNone: '',
    keySetInEnv: '(在 .env 中已设置)',
    keySetInBrowser: '(在浏览器中已设置)',
    keySetInProjectEnv: '(在项目/.env 中已设置)',
    testConnection: '测试连接',
    testing: '测试中...',
  },
  en: {
    title: 'Model Configuration',
    modelPreset: 'Model Preset',
    selectPreset: '-- Select a preset --',
    custom: 'Custom...',
    savedProfile: 'Saved Profile',
    useGlobalDefault: '-- Use global default --',
    deletePreset: 'Delete preset',
    deleteShort: 'Del',
    model: 'Model',
    apiKey: 'API Key',
    apiBase: 'API Base',
    pluginLlm: 'Plugin Model (optional)',
    pluginModel: 'Plugin Model',
    pluginApiKey: 'Plugin API Key',
    pluginApiBase: 'Plugin API Base',
    pluginModelPlaceholder: 'e.g. openai/llama3.2',
    pluginApiKeyPlaceholder: 'Enter API Key',
    pluginApiBasePlaceholder: 'e.g. http://localhost:11434/v1',
    pluginSameAsMain: 'Same as main model',
    pluginCustom: 'Custom model',
    pluginReasoning: 'Plugin Reasoning',
    reasoningNone: 'Off',
    reasoningLow: 'Low',
    reasoningMedium: 'Medium',
    reasoningHigh: 'High',
    imageGeneration: 'Image Generation',
    imageModel: 'Image Model',
    imageApiKey: 'Image API Key',
    imageApiBase: 'Image API Base',
    imageApiBaseAutoSuffix: 'Auto-append /v1/chat/completions',
    imageApiBaseAutoSuffixHint: 'Will auto-append /v1/chat/completions to the URL',
    imageApiBaseManualHint: 'Enter the full API endpoint URL',
    saving: 'Saving...',
    saveToProject: 'Save to Project',
    saveAsPreset: 'Save as Preset',
    presetNamePlaceholder: 'Preset name, e.g. GPT-4o',
    confirm: 'Confirm',
    cancel: 'Cancel',
    resetToGlobal: 'Reset to Global Default',
    sourceBrowser: 'browser',
    sourceProject: 'project',
    sourceEnv: '.env',
    sourceNone: '',
    keySetInEnv: '(set in .env)',
    keySetInBrowser: '(set in browser)',
    keySetInProjectEnv: '(set in project/.env)',
    testConnection: 'Test',
    testing: 'Testing...',
  },
}

export function ModelConfigPanel({ llmInfo, onClose, onSaved }: Props) {
  const { currentProject, updateProject } = useProjectStore()
  const language = useUiStore((s) => s.language)
  const t = modelPanelText[language] ?? modelPanelText.en
  const panelRef = useRef<HTMLDivElement>(null)

  const [profiles, setProfiles] = useState<LlmProfile[]>([])
  const [presetModels, setPresetModels] = useState<PresetModel[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState<string>('')
  const [selectedPresetId, setSelectedPresetId] = useState<string>('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [apiBase, setApiBase] = useState('')
  const [pluginModel, setPluginModel] = useState('')
  const [pluginApiKey, setPluginApiKey] = useState('')
  const [pluginApiBase, setPluginApiBase] = useState('')
  const [pluginUseSameModel, setPluginUseSameModel] = useState(true)
  const [pluginReasoningEffort, setPluginReasoningEffort] = useState('none')
  const [imageModel, setImageModel] = useState('')
  const [imageApiKey, setImageApiKey] = useState('')
  const [imageApiBase, setImageApiBase] = useState('')
  const [imageApiBaseAutoSuffix, setImageApiBaseAutoSuffix] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveProfileName, setSaveProfileName] = useState('')
  const [showSaveProfile, setShowSaveProfile] = useState(false)
  const browserConfig = currentProject ? getBrowserLlmConfig(currentProject.id) : {}

  // Test connection state
  const [mainTestResult, setMainTestResult] = useState<{ok: boolean; latency_ms?: number; error?: string} | null>(null)
  const [mainTesting, setMainTesting] = useState(false)
  const [pluginTestResult, setPluginTestResult] = useState<{ok: boolean; latency_ms?: number; error?: string} | null>(null)
  const [pluginTesting, setPluginTesting] = useState(false)

  const testModel = async (m: string, key: string, base: string): Promise<{ok: boolean; reply?: string; error?: string; latency_ms?: number}> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (m) headers['x-llm-model'] = m
    if (key) headers['x-llm-api-key'] = key
    if (base) headers['x-llm-api-base'] = base
    const res = await fetch('/api/llm/test', { method: 'POST', headers })
    return res.json()
  }

  const handleTestMain = async () => {
    setMainTesting(true)
    setMainTestResult(null)
    try {
      const result = await testModel(model, apiKey, apiBase)
      setMainTestResult(result)
    } catch {
      setMainTestResult({ ok: false, error: 'Network error' })
    }
    setMainTesting(false)
  }

  const handleTestPlugin = async () => {
    setPluginTesting(true)
    setPluginTestResult(null)
    try {
      const result = await testModel(pluginModel, pluginApiKey, pluginApiBase)
      setPluginTestResult(result)
    } catch {
      setPluginTestResult({ ok: false, error: 'Network error' })
    }
    setPluginTesting(false)
  }

  // Load profiles and preset models on mount
  useEffect(() => {
    api.getLlmProfiles().then((loadedProfiles) => {
      setProfiles(loadedProfiles)
      // Auto-match profile if current project config matches a profile
      if (currentProject) {
        const projectModel = currentProject.llm_model || ''
        const projectApiBase = currentProject.llm_api_base || ''
        
        const matchedProfile = loadedProfiles.find((p) => {
          // Match by model name
          if (p.model !== projectModel) return false
          // If profile has api_base, project should match (or both empty)
          const profileApiBase = p.api_base || ''
          if (profileApiBase && profileApiBase !== projectApiBase) return false
          return true
        })
        
        if (matchedProfile) {
          setSelectedProfileId(matchedProfile.id)
        }
      }
    }).catch((err) => console.warn('[modelConfig] getLlmProfiles', err))
    api.getPresetModels().then(setPresetModels).catch((err) => console.warn('[modelConfig] getPresets', err))
  }, [currentProject?.id])

  // Initialize fields from current project
  useEffect(() => {
    if (currentProject) {
      const local = getBrowserLlmConfig(currentProject.id)
      setModel(local.model || currentProject.llm_model || '')
      setApiKey(local.apiKey || '')
      setApiBase(local.apiBase || currentProject.llm_api_base || '')
      setPluginModel(local.pluginModel || '')
      setPluginApiKey(local.pluginApiKey || '')
      setPluginApiBase(local.pluginApiBase || '')
      setPluginUseSameModel(!local.pluginModel)
      setPluginReasoningEffort(local.pluginReasoningEffort || 'none')
      setImageModel(local.imageModel || currentProject.image_model || '')
      setImageApiKey(local.imageApiKey || '')
      setImageApiBase(local.imageApiBase || currentProject.image_api_base || '')
      setImageApiBaseAutoSuffix(local.imageApiBaseAutoSuffix !== false)
    }
  }, [currentProject?.id])

  // Close on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  const handleProfileSelect = async (profileId: string) => {
    setSelectedProfileId(profileId)
    setSelectedPresetId('') // Clear preset selection when profile is selected
    
    if (profileId === '') {
      // Reset to project values or empty
      const local = currentProject ? getBrowserLlmConfig(currentProject.id) : {}
      setModel(local.model || currentProject?.llm_model || '')
      setApiKey(local.apiKey || '')
      setApiBase(local.apiBase || currentProject?.llm_api_base || '')
      return
    }
    
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile || !currentProject) return
    
    // Auto-apply profile to project immediately (API key is browser-local by default)
    setSaving(true)
    try {
      await updateProject({
        llm_model: profile.model || undefined,
        llm_api_key: '',
        llm_api_base: profile.api_base || undefined,
      })
      saveBrowserLlmConfig(currentProject.id, {
        model: profile.model,
        apiBase: profile.api_base || undefined,
      })
      // Update local state to reflect applied profile
      setModel(profile.model)
      setApiKey(getBrowserLlmConfig(currentProject.id).apiKey || '')
      setApiBase(profile.api_base || '')
      onSaved() // Refresh parent component
    } catch {
      // Error handling - revert selection
      setSelectedProfileId('')
    } finally {
      setSaving(false)
    }
  }

  const handlePresetSelect = async (presetId: string) => {
    setSelectedPresetId(presetId)
    setSelectedProfileId('') // Clear profile selection when preset is selected
    
    if (presetId === '') {
      // Reset to project values or empty
      const local = currentProject ? getBrowserLlmConfig(currentProject.id) : {}
      setModel(local.model || currentProject?.llm_model || '')
      setApiKey(local.apiKey || '')
      setApiBase(local.apiBase || currentProject?.llm_api_base || '')
      return
    }
    
    const preset = presetModels.find((p) => p.id === presetId)
    if (!preset || !currentProject) return
    
    // Auto-apply preset to project immediately
    setSaving(true)
    try {
      let newModel = preset.model
      let newApiBase = preset.api_base
      
      // Special handling for openrouter-custom
      if (presetId === 'openrouter-custom') {
        newModel = '' // Leave empty for user to input
        newApiBase = 'https://openrouter.ai/api/v1'
      }
      
      await updateProject({
        llm_model: newModel || undefined,
        llm_api_key: '',
        llm_api_base: newApiBase || undefined,
      })
      saveBrowserLlmConfig(currentProject.id, {
        model: newModel || undefined,
        apiKey: undefined,
        apiBase: newApiBase || undefined,
      })
      
      setModel(newModel)
      setApiKey('') // Clear API key - user must enter their own
      setApiBase(newApiBase)
      onSaved() // Refresh parent component
    } catch {
      setSelectedPresetId('')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveToProject = async () => {
    if (!currentProject) return
    setSaving(true)
    try {
      saveBrowserLlmConfig(currentProject.id, {
        model,
        apiKey,
        apiBase,
        pluginModel: pluginUseSameModel ? undefined : (pluginModel || undefined),
        pluginApiKey: pluginUseSameModel ? undefined : (pluginApiKey || undefined),
        pluginApiBase: pluginUseSameModel ? undefined : (pluginApiBase || undefined),
        pluginReasoningEffort: pluginReasoningEffort === 'none' ? undefined : pluginReasoningEffort,
        imageModel,
        imageApiKey,
        imageApiBase,
        imageApiBaseAutoSuffix,
      })
      await updateProject({
        llm_model: model || undefined,
        llm_api_key: '',
        llm_api_base: apiBase || undefined,
        image_model: imageModel || undefined,
        image_api_key: '',
        image_api_base: imageApiBase || undefined,
      })
      onSaved()
    } catch {
      // error is visible via UI state
    } finally {
      setSaving(false)
    }
  }

  const handleSaveAsProfile = async () => {
    if (!saveProfileName.trim() || !model.trim()) return
    setSaving(true)
    try {
      const newProfile = await api.createLlmProfile({
        name: saveProfileName.trim(),
        model: model.trim(),
        // API key stays in browser storage by default.
        api_key: undefined,
        api_base: apiBase || undefined,
      })
      setProfiles((prev) => [newProfile, ...prev])
      setSelectedProfileId(newProfile.id)
      setShowSaveProfile(false)
      setSaveProfileName('')
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteProfile = async (profileId: string) => {
    try {
      await api.deleteLlmProfile(profileId)
      setProfiles((prev) => prev.filter((p) => p.id !== profileId))
      if (selectedProfileId === profileId) {
        setSelectedProfileId('')
      }
    } catch {
      // ignore
    }
  }

  const handleClearProjectConfig = async () => {
    if (!currentProject) return
    setSaving(true)
    try {
      await updateProject({
        llm_model: undefined,
        llm_api_key: '',
        llm_api_base: undefined,
        image_model: undefined,
        image_api_key: '',
        image_api_base: undefined,
      })
      clearBrowserLlmConfig(currentProject.id)
      setModel('')
      setApiKey('')
      setApiBase('')
      setPluginModel('')
      setPluginApiKey('')
      setPluginApiBase('')
      setPluginUseSameModel(true)
      setPluginReasoningEffort('none')
      setImageModel('')
      setImageApiKey('')
      setImageApiBase('')
      setImageApiBaseAutoSuffix(true)
      setSelectedProfileId('')
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  // Determine source for each field
  const getSource = (field: 'model' | 'api_key' | 'api_base') => {
    const browserVal = field === 'model' ? browserConfig.model :
                       field === 'api_key' ? browserConfig.apiKey :
                       browserConfig.apiBase
    if (browserVal) return 'browser'
    const projectVal = field === 'model' ? currentProject?.llm_model :
                       field === 'api_key' ? (currentProject?.has_llm_api_key ? '***' : null) :
                       currentProject?.llm_api_base
    if (projectVal) return 'project'
    const envVal = field === 'model' ? llmInfo?.model :
                   field === 'api_key' ? (llmInfo?.has_key ? '***' : null) :
                   llmInfo?.api_base
    if (envVal) return 'env'
    return 'none'
  }

  const sourceLabel = (field: 'model' | 'api_key' | 'api_base') => {
    const src = getSource(field)
    if (src === 'browser') return t.sourceBrowser
    if (src === 'project') return t.sourceProject
    if (src === 'env') return t.sourceEnv
    return t.sourceNone
  }

  return (
    <div
      ref={panelRef}
      className="absolute top-full left-0 mt-1 w-80 bg-popover border rounded-lg shadow-xl z-50 overflow-hidden"
    >
      <div className="p-3 border-b flex items-center justify-between">
        <span className="text-sm font-medium">{t.title}</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-lg leading-none">&times;</button>
      </div>

      <div className="p-3 space-y-3 max-h-96 overflow-y-auto">
        {/* Preset Model selector */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">{t.modelPreset}</label>
          <select
            value={selectedPresetId}
            onChange={(e) => handlePresetSelect(e.target.value)}
            className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">{t.selectPreset}</option>
            <optgroup label="DeepSeek">
              {presetModels
                .filter((p) => p.provider === 'deepseek')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {language === 'en' && p.name_en ? p.name_en : p.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="OpenRouter">
              {presetModels
                .filter((p) => p.provider === 'openrouter')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {language === 'en' && p.name_en ? p.name_en : p.name}
                  </option>
                ))}
            </optgroup>
            <option value="custom">{t.custom}</option>
          </select>
        </div>

        {/* Profile selector */}
        <div>
          <label className="text-xs text-muted-foreground block mb-1">{t.savedProfile}</label>
          <div className="flex gap-1">
            <select
              value={selectedProfileId}
              onChange={(e) => handleProfileSelect(e.target.value)}
              className="flex-1 bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="">{t.useGlobalDefault}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.model})
                </option>
              ))}
            </select>
            {selectedProfileId && (
              <button
                onClick={() => handleDeleteProfile(selectedProfileId)}
                className="px-2 py-1 text-xs text-destructive hover:text-destructive/80 hover:bg-muted rounded"
                title={t.deletePreset}
              >
                {t.deleteShort}
              </button>
            )}
          </div>
        </div>

        {/* Model */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <label className="text-xs text-muted-foreground">{t.model}</label>
            {sourceLabel('model') && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {sourceLabel('model')}
              </span>
            )}
          </div>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={llmInfo?.model || 'gpt-4o-mini'}
            className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* API Key */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <label className="text-xs text-muted-foreground">{t.apiKey}</label>
            {sourceLabel('api_key') && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {sourceLabel('api_key')}
              </span>
            )}
          </div>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={llmInfo?.has_key ? t.keySetInEnv : 'sk-...'}
            className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* API Base */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <label className="text-xs text-muted-foreground">{t.apiBase}</label>
            {sourceLabel('api_base') && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                {sourceLabel('api_base')}
              </span>
            )}
          </div>
          <input
            type="text"
            value={apiBase}
            onChange={(e) => setApiBase(e.target.value)}
            placeholder={llmInfo?.api_base || 'https://api.openai.com/v1'}
            className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Test main model connection */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTestMain}
            disabled={mainTesting || !model}
            className="px-2.5 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50 transition-colors"
          >
            {mainTesting ? t.testing : t.testConnection}
          </button>
          {mainTestResult && (
            <span className={`text-xs ${mainTestResult.ok ? 'text-emerald-500' : 'text-destructive'}`}>
              {mainTestResult.ok ? `OK ${mainTestResult.latency_ms}ms` : mainTestResult.error}
            </span>
          )}
        </div>

        {/* Actions */}
        <div className="pt-1 border-t" />

        {/* Plugin Agent model config */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t.pluginLlm}</div>

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

          <div className={`space-y-2 transition-opacity ${pluginUseSameModel ? 'opacity-40 pointer-events-none' : ''}`}>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t.pluginModel}</label>
              <input
                type="text"
                value={pluginModel}
                onChange={(e) => setPluginModel(e.target.value)}
                placeholder={t.pluginModelPlaceholder}
                disabled={pluginUseSameModel}
                className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t.pluginApiKey}</label>
              <input
                type="password"
                value={pluginApiKey}
                onChange={(e) => setPluginApiKey(e.target.value)}
                placeholder={t.pluginApiKeyPlaceholder}
                disabled={pluginUseSameModel}
                className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground block mb-1">{t.pluginApiBase}</label>
              <input
                type="text"
                value={pluginApiBase}
                onChange={(e) => setPluginApiBase(e.target.value)}
                placeholder={t.pluginApiBasePlaceholder}
                disabled={pluginUseSameModel}
                className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
            </div>

            {/* Test plugin model connection */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleTestPlugin}
                disabled={pluginTesting || pluginUseSameModel || !pluginModel}
                className="px-2.5 py-1 text-xs border rounded hover:bg-muted disabled:opacity-50 transition-colors"
              >
                {pluginTesting ? t.testing : t.testConnection}
              </button>
              {pluginTestResult && (
                <span className={`text-xs ${pluginTestResult.ok ? 'text-emerald-500' : 'text-destructive'}`}>
                  {pluginTestResult.ok ? `OK ${pluginTestResult.latency_ms}ms` : pluginTestResult.error}
                </span>
              )}
            </div>
          </div>

          {/* Plugin reasoning effort */}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t.pluginReasoning}</label>
            <select
              value={pluginReasoningEffort}
              onChange={(e) => setPluginReasoningEffort(e.target.value)}
              className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="none">{t.reasoningNone}</option>
              <option value="low">{t.reasoningLow}</option>
              <option value="medium">{t.reasoningMedium}</option>
              <option value="high">{t.reasoningHigh}</option>
            </select>
          </div>
        </div>

        {/* Actions */}
        <div className="pt-1 border-t" />

        {/* Image generation config */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">{t.imageGeneration}</div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t.imageModel}</label>
            <input
              type="text"
              value={imageModel}
              onChange={(e) => setImageModel(e.target.value)}
              placeholder={currentProject?.image_model || 'gemini-2.5-flash-image-preview'}
              className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground block mb-1">{t.imageApiKey}</label>
            <input
              type="password"
              value={imageApiKey}
              onChange={(e) => setImageApiKey(e.target.value)}
              placeholder={
                browserConfig.imageApiKey
                  ? t.keySetInBrowser
                  : currentProject?.has_image_api_key
                    ? t.keySetInProjectEnv
                    : 'sk-...'
              }
              className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-muted-foreground">{t.imageApiBase}</label>
              <button
                type="button"
                onClick={() => setImageApiBaseAutoSuffix(!imageApiBaseAutoSuffix)}
                className={`text-[10px] px-1.5 py-0.5 rounded-full border transition-colors ${
                  imageApiBaseAutoSuffix
                    ? 'bg-primary/10 border-primary/30 text-primary'
                    : 'bg-muted border-muted-foreground/20 text-muted-foreground'
                }`}
              >
                {t.imageApiBaseAutoSuffix}
              </button>
            </div>
            <input
              type="text"
              value={imageApiBase}
              onChange={(e) => setImageApiBase(e.target.value)}
              placeholder={imageApiBaseAutoSuffix ? 'https://api.example.com' : 'https://api.example.com/v1/chat/completions'}
              className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              {imageApiBaseAutoSuffix ? t.imageApiBaseAutoSuffixHint : t.imageApiBaseManualHint}
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleSaveToProject}
            disabled={saving}
            className="flex-1 px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded text-xs font-medium transition-colors"
          >
            {saving ? t.saving : t.saveToProject}
          </button>
          <button
            onClick={() => setShowSaveProfile(true)}
            disabled={!model.trim()}
            className="px-3 py-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50 rounded text-xs font-medium transition-colors"
          >
            {t.saveAsPreset}
          </button>
        </div>

        {/* Save as profile form */}
        {showSaveProfile && (
          <div className="border rounded p-2 space-y-2">
            <input
              type="text"
              value={saveProfileName}
              onChange={(e) => setSaveProfileName(e.target.value)}
              placeholder={t.presetNamePlaceholder}
              className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveAsProfile()
                if (e.key === 'Escape') setShowSaveProfile(false)
              }}
            />
            <div className="flex gap-2">
              <button
                onClick={handleSaveAsProfile}
                disabled={saving || !saveProfileName.trim()}
                className="flex-1 px-2 py-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded text-xs transition-colors"
              >
                {t.confirm}
              </button>
              <button
                onClick={() => setShowSaveProfile(false)}
                className="px-2 py-1 bg-muted hover:bg-muted/80 text-foreground rounded text-xs transition-colors"
              >
                {t.cancel}
              </button>
            </div>
          </div>
        )}

        {/* Reset to default */}
        {(currentProject?.llm_model || currentProject?.has_llm_api_key || currentProject?.llm_api_base) && (
          <button
            onClick={handleClearProjectConfig}
            disabled={saving}
            className="w-full px-3 py-1.5 border hover:bg-muted text-muted-foreground hover:text-foreground rounded text-xs transition-colors"
          >
            {t.resetToGlobal}
          </button>
        )}
      </div>
    </div>
  )
}
