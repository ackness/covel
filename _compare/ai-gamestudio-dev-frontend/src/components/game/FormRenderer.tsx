import { useState } from 'react'
import type { BlockRendererProps } from '../../services/blockRenderers'
import {
  EMPTY_BLOCK_INTERACTION,
  useBlockInteractionStore,
} from '../../stores/blockInteractionStore'
import { buildFormInitialValues, type FormFieldShape } from './blockInteractionState'

interface FormField {
  name: string
  label: string
  type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox'
  required?: boolean
  default?: string | number | boolean
  options?: string[]
  placeholder?: string
}

interface FormData {
  id: string
  title: string
  description?: string
  fields: FormField[]
  submit_label?: string
  submit_mode?: 'message' | 'structured'
}

export function FormRenderer({ data, blockId, onAction, locked }: BlockRendererProps) {
  const payload = data && typeof data === 'object' ? (data as FormData) : null

  const { id, title, description, fields = [], submit_label = '提交', submit_mode = 'message' } = payload ?? {
    id: '',
    title: '',
    description: undefined,
    fields: [],
    submit_label: '提交',
    submit_mode: 'message',
  }
  const interaction = useBlockInteractionStore(
    (s) => s.interactions[blockId] ?? EMPTY_BLOCK_INTERACTION,
  )
  const setInteraction = useBlockInteractionStore((s) => s.setInteraction)
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    return buildFormInitialValues(fields as FormFieldShape[], interaction)
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const submitted = !!interaction.submitted

  if (!payload) return null

  const getTextualValue = (name: string): string | number => {
    const value = values[name]
    return typeof value === 'string' || typeof value === 'number' ? value : ''
  }

  const updateValue = (name: string, value: string | number | boolean) => {
    setValues((prev) => {
      const next = { ...prev, [name]: value }
      setInteraction(blockId, { formValues: next })
      return next
    })
    setErrors((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
  }

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {}
    for (const field of fields) {
      if (field.required) {
        const val = values[field.name]
        if (val === '' || val === undefined || val === null) {
          newErrors[field.name] = `${field.label}不能为空`
        }
      }
    }
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = () => {
    if (!validate()) return
    setInteraction(blockId, { submitted: true, formValues: values })

    if (submit_mode === 'structured') {
      // Send structured message via WebSocket — caller should wire this up
      // For now, use onAction as fallback with a structured hint
      onAction(JSON.stringify({ type: 'form_submit', form_id: id, values }))
    } else {
      const parts = fields
        .filter((f) => values[f.name] !== '' && values[f.name] !== false)
        .map((f) => `${f.label}=${values[f.name]}`)
      onAction(`【表单提交】${title}: ${parts.join(', ')}`)
    }
  }

  if (locked || submitted) {
    return (
      <div className="bg-card border rounded-xl px-4 py-3 space-y-2 max-w-[80%] opacity-70">
        <p className="text-muted-foreground text-sm font-medium">{title}</p>
        <div className="space-y-1">
          {fields.map((field) => (
            <div key={field.name} className="text-sm">
              <span className="text-muted-foreground">{field.label}：</span>
              <span className="text-primary">
                {field.type === 'checkbox' ? (values[field.name] ? '是' : '否') : String(values[field.name])}
              </span>
            </div>
          ))}
        </div>
        <p className="text-emerald-500 text-xs">已提交</p>
      </div>
    )
  }

  return (
    <div className="bg-card border rounded-xl px-4 py-3 space-y-3 max-w-[80%]">
      <div>
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-muted-foreground text-xs mt-1">{description}</p>}
      </div>

      <div className="space-y-2">
        {fields.map((field) => (
          <div key={field.name}>
            <label className="block text-xs text-muted-foreground mb-1">
              {field.label}
              {field.required && <span className="text-red-400 ml-0.5">*</span>}
            </label>

            {field.type === 'text' && (
              <input
                type="text"
                value={getTextualValue(field.name)}
                onChange={(e) => updateValue(field.name, e.target.value)}
                placeholder={field.placeholder}
                className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}

            {field.type === 'number' && (
              <input
                type="number"
                value={getTextualValue(field.name)}
                onChange={(e) => updateValue(field.name, e.target.value === '' ? '' : Number(e.target.value))}
                placeholder={field.placeholder}
                className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}

            {field.type === 'textarea' && (
              <textarea
                value={getTextualValue(field.name)}
                onChange={(e) => updateValue(field.name, e.target.value)}
                placeholder={field.placeholder}
                rows={3}
                className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              />
            )}

            {field.type === 'select' && (
              <select
                value={getTextualValue(field.name)}
                onChange={(e) => updateValue(field.name, e.target.value)}
                className="w-full bg-background border border-input rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">请选择...</option>
                {(field.options || []).map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            )}

            {field.type === 'checkbox' && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!values[field.name]}
                  onChange={(e) => updateValue(field.name, e.target.checked)}
                  className="accent-cyan-500"
                />
                <span className="text-sm text-foreground/80">{field.placeholder || ''}</span>
              </label>
            )}

            {errors[field.name] && (
              <p className="text-destructive text-xs mt-0.5">{errors[field.name]}</p>
            )}
          </div>
        ))}
      </div>

      <button
        onClick={handleSubmit}
        className="text-xs px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/90 rounded transition-colors"
      >
        {submit_label}
      </button>
    </div>
  )
}
