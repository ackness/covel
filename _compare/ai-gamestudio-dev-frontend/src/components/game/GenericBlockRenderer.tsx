/**
 * Schema-driven generic block renderer.
 *
 * Renders block data using a UI schema from the plugin system,
 * eliminating the need for custom React components per block type.
 */
import type { UISchema, UISchemaSection, UISchemaAction } from '../../stores/blockSchemaStore'
import { interpolate, interpolateDeep } from './generic/templateEngine'
import { CardLayout, BannerLayout, ButtonsLayout } from './generic/layouts'
import {
  KeyValueSection,
  TextSection,
  ListSection,
  TableSection,
  ProgressSection,
  TagsSection,
} from './generic/sections'

interface GenericBlockRendererProps {
  data: Record<string, unknown>
  blockId: string
  schema: UISchema
  onAction: (msg: string) => void
}

function renderSection(section: UISchemaSection) {
  switch (section.type) {
    case 'key-value':
      return <KeyValueSection items={section.items || []} />
    case 'text':
      return <TextSection content={section.content || ''} />
    case 'list':
      return <ListSection values={section.values || []} ordered={false} />
    case 'table':
      return <TableSection columns={section.columns || []} rows={section.rows || []} />
    case 'progress':
      return (
        <ProgressSection
          label={section.label || ''}
          current={Number(section.current) || 0}
          max={Number(section.max) || 100}
        />
      )
    case 'tags':
      return <TagsSection values={section.values || []} />
    default:
      return null
  }
}

function resolveButtons(
  actions: UISchemaAction[] | undefined,
  data: Record<string, unknown>,
): { label: string; actionTemplate: string }[] {
  if (!actions?.length) return []

  const buttons: { label: string; actionTemplate: string }[] = []

  for (const action of actions) {
    if (action.for_each) {
      // Iterate over an array field in data
      const items = data[action.for_each]
      if (Array.isArray(items)) {
        for (const item of items) {
          const itemData = typeof item === 'object' && item !== null
            ? { ...data, item }
            : { ...data, item }
          buttons.push({
            label: interpolate(action.label, itemData as Record<string, unknown>),
            actionTemplate: interpolate(
              action.action_template,
              itemData as Record<string, unknown>,
            ),
          })
        }
      }
    } else {
      buttons.push({
        label: interpolate(action.label, data),
        actionTemplate: interpolate(action.action_template, data),
      })
    }
  }

  return buttons
}

export function GenericBlockRenderer({ data, blockId, schema, onAction }: GenericBlockRendererProps) {
  // 1. Interpolate all template strings in sections with actual data
  const interpolatedSections = schema.sections
    ? interpolateDeep(schema.sections, data)
    : []

  const title = schema.title ? interpolate(schema.title, data) : undefined
  const text = schema.text ? interpolate(schema.text, data) : undefined
  const variant = schema.style?.variant || 'default'

  // 2. Resolve action buttons
  const buttons = resolveButtons(schema.actions, data)

  // 3. Wrap onAction to support block_response mode for interactive blocks
  const handleAction = (actionTemplate: string) => {
    if (schema.requires_response) {
      // Send as structured block_response message (parsed by GamePanel.handleSend)
      const blockResponse = JSON.stringify({
        type: 'block_response',
        block_type: data._block_type || 'unknown',
        block_id: blockId,
        data: { chosen: actionTemplate },
      })
      onAction(blockResponse)
    } else {
      onAction(actionTemplate)
    }
  }

  // 3. Select layout based on component type
  switch (schema.component) {
    case 'buttons':
      return (
        <ButtonsLayout
          title={title}
          text={text}
          buttons={buttons}
          onAction={handleAction}
        />
      )

    case 'banner':
      return (
        <BannerLayout title={title} variant={variant}>
          {interpolatedSections.map((section, i) => (
            <div key={i}>{renderSection(section)}</div>
          ))}
          {buttons.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {buttons.map((btn, i) => (
                <button
                  key={i}
                  onClick={() => handleAction(btn.actionTemplate)}
                  className="text-sm px-3 py-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg transition-colors"
                >
                  {btn.label}
                </button>
              ))}
            </div>
          )}
        </BannerLayout>
      )

    case 'none':
      // No UI rendering (backend-only blocks like state_update)
      return null

    case 'card':
    default:
      return (
        <CardLayout title={title} variant={variant}>
          {text && <p className="text-sm text-muted-foreground">{text}</p>}
          {interpolatedSections.map((section, i) => (
            <div key={i}>{renderSection(section)}</div>
          ))}
          {buttons.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {buttons.map((btn, i) => (
                <button
                  key={i}
                  onClick={() => handleAction(btn.actionTemplate)}
                  className="text-sm px-3 py-1.5 bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg transition-colors"
                >
                  {btn.label}
                </button>
              ))}
            </div>
          )}
        </CardLayout>
      )
  }
}
