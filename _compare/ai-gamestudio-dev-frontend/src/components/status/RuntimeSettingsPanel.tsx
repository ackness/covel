import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeSettingField } from '../../types'
import { useProjectStore } from '../../stores/projectStore'
import { useSessionStore } from '../../stores/sessionStore'
import { usePluginStore } from '../../stores/pluginStore'
import { useUiStore } from '../../stores/uiStore'
import { StorageFactory, type ISettingsStorage } from '../../services/settingsStorage'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { AlertCircle } from 'lucide-react'

type Scope = 'project' | 'session'

const rspText: Record<string, Record<string, string>> = {
  zh: {
    selectProject: '请选择一个项目以配置运行时设置。',
    loading: '加载运行时设置中...',
    description: '运行时设置将在下一轮对话中影响叙事、图像生成和选项。',
    editScope: '编辑范围',
    project: '项目',
    session: '存档',
    noSettings: '当前启用的插件未声明任何运行时设置。',
    overridden: '已覆盖',
    saving: '保存中...',
    enabled: '已启用',
    reset: '重置',
    localizedDefault: '用中文默认值',
  },
  en: {
    selectProject: 'Select a project to configure runtime settings.',
    loading: 'Loading runtime settings...',
    description: 'Runtime settings affect narration, image generation, and choices from the next turn.',
    editScope: 'Edit scope',
    project: 'Project',
    session: 'Session',
    noSettings: 'No runtime settings declared by currently enabled plugins.',
    overridden: 'overridden',
    saving: 'saving...',
    enabled: 'Enabled',
    reset: 'Reset',
    localizedDefault: 'Use localized default',
  },
}

function normalizeValueForField(field: RuntimeSettingField, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (field.type === 'boolean') return Boolean(raw)
  if (field.type === 'integer') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? Math.round(raw) : null
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (!trimmed) return null
      const parsed = Number.parseInt(trimmed, 10)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }
  if (field.type === 'number') {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      if (!trimmed) return null
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }
  if (field.type === 'enum') return String(raw)
  return String(raw)
}

function displayValue(field: RuntimeSettingField, value: unknown): string {
  if (value === null || value === undefined) return ''
  if (field.type === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

export function RuntimeSettingsPanel() {
  const currentProject = useProjectStore((s) => s.currentProject)
  const currentSession = useSessionStore((s) => s.currentSession)
  const plugins = usePluginStore((s) => s.plugins)
  const language = useUiStore((s) => s.language)
  const t = rspText[language] ?? rspText.en

  const pluginDisplayName = useCallback(
    (name: string): string => {
      const plugin = plugins.find((p) => p.name === name)
      if (!plugin) return name
      return plugin.i18n?.[language]?.name || plugin.name
    },
    [plugins, language],
  )

  const localizeField = useCallback(
    (field: RuntimeSettingField) => ({
      label: field.i18n?.[language]?.label || field.label,
      description: field.i18n?.[language]?.description || field.description,
      localizedDefault: field.i18n?.[language]?.default,
    }),
    [language],
  )
  const [scope, setScope] = useState<Scope>('project')
  const [loading, setLoading] = useState(false)
  const [fields, setFields] = useState<RuntimeSettingField[]>([])
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [projectOverrides, setProjectOverrides] = useState<Record<string, unknown>>({})
  const [sessionOverrides, setSessionOverrides] = useState<Record<string, unknown>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const storageRef = useRef<ISettingsStorage | null>(null)

  const getStorage = useCallback(async () => {
    if (!storageRef.current) {
      storageRef.current = await StorageFactory.create()
    }
    return storageRef.current
  }, [])

  const refresh = useCallback(async () => {
    if (!currentProject?.id) {
      setFields([])
      setValues({})
      setProjectOverrides({})
      setSessionOverrides({})
      return
    }
    setLoading(true)
    setError(null)
    try {
      const storage = await getStorage()
      const [schemaRes, valuesRes] = await Promise.all([
        storage.getSchema(currentProject.id),
        storage.getValues(currentProject.id, currentSession?.id),
      ])
      setFields(schemaRes.fields || [])
      setValues(valuesRes.values || {})
      setProjectOverrides(valuesRes.project_overrides || {})
      setSessionOverrides(valuesRes.session_overrides || {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load runtime settings')
      setFields([])
      setValues({})
    } finally {
      setLoading(false)
    }
  }, [currentProject?.id, currentSession?.id, getStorage])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!currentSession && scope === 'session') {
      setScope('project')
    }
  }, [currentSession, scope])

  const fieldsByPlugin = useMemo(() => {
    const grouped: Record<string, RuntimeSettingField[]> = {}
    for (const field of fields) {
      if (!grouped[field.plugin_name]) grouped[field.plugin_name] = []
      grouped[field.plugin_name].push(field)
    }
    for (const key of Object.keys(grouped)) {
      grouped[key].sort((a, b) => {
        const ao = Number(a.order || 0)
        const bo = Number(b.order || 0)
        if (ao !== bo) return ao - bo
        return a.key.localeCompare(b.key)
      })
    }
    return grouped
  }, [fields])

  const patchField = useCallback(
    async (field: RuntimeSettingField, rawValue: unknown, reset = false) => {
      if (!currentProject?.id) return
      const targetScope: Scope = field.scope === 'both' ? scope : field.scope
      if (targetScope === 'session' && !currentSession?.id) return

      const normalized = reset ? null : normalizeValueForField(field, rawValue)
      setSavingKey(field.key)
      setError(null)
      setValues((prev) => ({ ...prev, [field.key]: normalized }))

      try {
        const storage = await getStorage()
        const patched = await storage.patch({
          projectId: currentProject.id,
          sessionId: targetScope === 'session' ? currentSession?.id : undefined,
          scope: targetScope,
          values: { [field.key]: normalized },
        })
        setValues(patched.values || {})
        setProjectOverrides(patched.project_overrides || {})
        setSessionOverrides(patched.session_overrides || {})
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update setting')
        await refresh()
      } finally {
        setSavingKey(null)
      }
    },
    [currentProject?.id, currentSession?.id, scope, refresh, getStorage],
  )

  if (!currentProject) {
    return (
      <div className="text-center text-muted-foreground py-8 text-sm">
        {t.selectProject}
      </div>
    )
  }

  if (loading && fields.length === 0) {
    return <div className="text-center text-muted-foreground py-8 text-sm">{t.loading}</div>
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border bg-muted/30 px-3 py-2 space-y-2">
        <p className="text-xs text-muted-foreground">
          {t.description}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t.editScope}</span>
          <Button
            variant={scope === 'project' ? 'default' : 'secondary'}
            size="sm"
            onClick={() => setScope('project')}
            className="text-xs h-6 px-2"
          >
            {t.project}
          </Button>
          <Button
            variant={scope === 'session' ? 'default' : 'secondary'}
            size="sm"
            onClick={() => setScope('session')}
            disabled={!currentSession}
            className="text-xs h-6 px-2"
          >
            {t.session}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="py-2">
          <AlertCircle className="h-3 w-3" />
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}

      {Object.keys(fieldsByPlugin).length === 0 && (
        <div className="text-center text-muted-foreground py-8 text-sm">
          {t.noSettings}
        </div>
      )}

      {Object.entries(fieldsByPlugin).map(([pluginName, pluginFields]) => (
        <div key={pluginName} className="rounded-lg border bg-card p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{pluginDisplayName(pluginName)}</p>
            {pluginDisplayName(pluginName) !== pluginName && (
              <span className="text-[10px] text-muted-foreground font-mono">{pluginName}</span>
            )}
          </div>
          {pluginFields.map((field) => {
            const currentValue = values[field.key]
            const effectiveScope = field.scope === 'both' ? scope : field.scope
            const isOverridden = effectiveScope === 'project'
              ? Object.prototype.hasOwnProperty.call(projectOverrides, field.key)
              : Object.prototype.hasOwnProperty.call(sessionOverrides, field.key)
            const disabledByScope = field.scope === 'session' && !currentSession
            const { label: fieldLabel, description: fieldDescription, localizedDefault } = localizeField(field)

            // Show localized default when the field hasn't been explicitly overridden
            // and the localized locale provides an alternative default value.
            const effectiveDisplayValue = (v: unknown) => {
              const raw = displayValue(field, v)
              if (!isOverridden && localizedDefault !== undefined) return localizedDefault
              return raw
            }

            return (
              <div key={field.key} className="space-y-1 border rounded-md p-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium">{fieldLabel}</p>
                  <div className="flex items-center gap-1">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-auto">
                      {field.scope}
                    </Badge>
                    {isOverridden && (
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-auto text-primary">
                        {t.overridden}
                      </Badge>
                    )}
                    {savingKey === field.key && (
                      <span className="text-[10px] text-primary">{t.saving}</span>
                    )}
                  </div>
                </div>

                {fieldDescription && (
                  <p className="text-[11px] text-muted-foreground">{fieldDescription}</p>
                )}

                {field.type === 'boolean' ? (
                  <label className="inline-flex items-center gap-2 text-xs text-foreground cursor-pointer">
                    <Checkbox
                      checked={Boolean(currentValue)}
                      disabled={disabledByScope}
                      onCheckedChange={(checked: boolean) => patchField(field, checked)}
                    />
                    {t.enabled}
                  </label>
                ) : field.type === 'enum' ? (
                  <Select
                    value={displayValue(field, currentValue)}
                    disabled={disabledByScope}
                    onValueChange={(v: string) => patchField(field, v)}
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(field.options || []).map((opt) => (
                        <SelectItem key={String(opt.value)} value={String(opt.value)} className="text-xs">
                          {opt.i18n?.[language]?.label || opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : field.component === 'textarea' ? (
                  <Textarea
                    value={effectiveDisplayValue(currentValue)}
                    disabled={disabledByScope}
                    onChange={(e) => patchField(field, e.target.value)}
                    className="min-h-20 text-xs"
                  />
                ) : (
                  <Input
                    type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
                    min={field.min}
                    max={field.max}
                    step={field.step || (field.type === 'integer' ? 1 : undefined)}
                    value={effectiveDisplayValue(currentValue)}
                    disabled={disabledByScope}
                    onChange={(e) => patchField(field, e.target.value)}
                    className="h-7 text-xs"
                  />
                )}

                <div className="flex items-center justify-between">
                  <p className="text-[10px] text-muted-foreground">
                    key: <code>{field.key}</code>
                  </p>
                  <div className="flex items-center gap-1">
                    {localizedDefault !== undefined && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => patchField(field, localizedDefault)}
                        disabled={disabledByScope}
                        className="text-[10px] h-5 px-2"
                      >
                        {t.localizedDefault}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => patchField(field, null, true)}
                      disabled={disabledByScope}
                      className="text-[10px] h-5 px-2"
                    >
                      {t.reset}
                    </Button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}
