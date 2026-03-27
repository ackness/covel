import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectStore } from '../../stores/projectStore'
import { useUiStore } from '../../stores/uiStore'

const DEFAULT_INIT_PROMPT: Record<string, string> = {
  zh:
    '玩家开始了一场新游戏。请根据世界观文档生成一段沉浸式的开场叙事。' +
    '在叙事末尾包含一个 json:character_sheet 代码块用于角色创建，' +
    '其中 editable_fields 需包含 \'name\'。' +
    '同时包含一个 json:scene_update 代码块来建立起始场景。',
  en:
    'The player starts a new game. Generate an immersive opening narrative based on the world document. ' +
    'At the end include a json:character_sheet block for character creation with editable_fields containing \'name\'. ' +
    'Also include a json:scene_update block to establish the starting scene.',
}

const uiText: Record<string, Record<string, string>> = {
  zh: { custom: '自定义', usingDefault: '使用默认', reset: '恢复默认', saving: '保存中...', saved: '已保存' },
  en: { custom: 'Custom', usingDefault: 'Using default', reset: 'Reset to default', saving: 'Saving...', saved: 'Saved' },
}

export function InitPromptEditor() {
  const { currentProject, updateProject } = useProjectStore()
  const [content, setContent] = useState('')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const language = useUiStore((s) => s.language)
  const t = uiText[language] ?? uiText.en

  useEffect(() => {
    if (currentProject) {
      setContent(currentProject.init_prompt || '')
    }
  }, [currentProject?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const debouncedSave = useCallback(
    (value: string) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      setSaveStatus('idle')
      timerRef.current = setTimeout(async () => {
        setSaveStatus('saving')
        try {
          await updateProject({ init_prompt: value || undefined })
          setSaveStatus('saved')
          setTimeout(() => setSaveStatus('idle'), 2000)
        } catch {
          setSaveStatus('idle')
        }
      }, 1000)
    },
    [updateProject],
  )

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setContent(value)
    debouncedSave(value)
  }

  const handleReset = () => {
    setContent('')
    debouncedSave('')
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 bg-muted/30 border-b">
        <span className="text-xs text-muted-foreground">
          {content ? t.custom : t.usingDefault}
        </span>
        <div className="flex items-center gap-2">
          {content && (
            <button
              onClick={handleReset}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t.reset}
            </button>
          )}
          <span className="text-xs text-muted-foreground">
            {saveStatus === 'saving' && t.saving}
            {saveStatus === 'saved' && t.saved}
          </span>
        </div>
      </div>
      <textarea
        value={content}
        onChange={handleChange}
        className="flex-1 w-full p-4 bg-background text-foreground text-sm font-mono resize-none focus:outline-none leading-relaxed"
        placeholder={DEFAULT_INIT_PROMPT[language] ?? DEFAULT_INIT_PROMPT.en}
        spellCheck={false}
      />
    </div>
  )
}
