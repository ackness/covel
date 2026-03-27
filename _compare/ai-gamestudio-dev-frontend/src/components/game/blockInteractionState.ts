import type { BlockInteractionState } from '../../stores/blockInteractionStore'

export interface FormFieldShape {
  name: string
  type: 'text' | 'number' | 'select' | 'textarea' | 'checkbox'
  default?: string | number | boolean
}

export function buildChoicesInteractionState(
  options: string[],
  interaction?: BlockInteractionState,
): {
  submitted: boolean
  chosen: string[]
  selectedIndexes: number[]
} {
  const chosen = Array.isArray(interaction?.chosen) ? interaction!.chosen : []
  const selectedIndexes = chosen
    .map((opt) => options.indexOf(opt))
    .filter((idx) => idx >= 0)

  return {
    submitted: !!interaction?.submitted,
    chosen,
    selectedIndexes,
  }
}

export function buildFormInitialValues(
  fields: FormFieldShape[],
  interaction?: BlockInteractionState,
): Record<string, string | number | boolean> {
  if (interaction?.formValues) {
    return { ...interaction.formValues }
  }

  const defaults: Record<string, string | number | boolean> = {}
  for (const field of fields) {
    if (field.default !== undefined) {
      defaults[field.name] = field.default
      continue
    }
    if (field.type === 'checkbox') {
      defaults[field.name] = false
    } else {
      defaults[field.name] = ''
    }
  }
  return defaults
}

export function buildGuideInteractionState(
  interaction?: BlockInteractionState,
): {
  submitted: boolean
  chosenText: string
  collapsed: boolean
  customInput: string
} {
  return {
    submitted: !!interaction?.submitted,
    chosenText: typeof interaction?.chosen === 'string' ? interaction.chosen : '',
    collapsed: !!interaction?.collapsed,
    customInput: interaction?.customInput || '',
  }
}

export function buildCharacterSheetInteractionState(
  name: string,
  attributes: Record<string, string | number>,
  interaction?: BlockInteractionState,
  locked?: boolean,
): {
  confirmed: boolean
  editedName: string
  editedAttrs: Record<string, string | number>
} {
  return {
    confirmed: !!interaction?.confirmed || !!locked,
    editedName: interaction?.editedName || name,
    editedAttrs: interaction?.editedAttrs ? { ...interaction.editedAttrs } : { ...attributes },
  }
}
