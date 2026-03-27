// Central block renderer registration.
// Import this file once (e.g. in main.tsx) so renderers are available everywhere.
import { registerBlockRenderer } from './services/blockRenderers'
import type { BlockRendererProps } from './services/blockRenderers'
import { ChoicesRenderer } from './components/game/ChoicesRenderer'
import { FormRenderer } from './components/game/FormRenderer'
import { CharacterSheetRenderer } from './components/game/CharacterSheetRenderer'
import { NotificationRenderer } from './components/game/NotificationRenderer'
import { SceneUpdateRenderer } from './components/game/SceneUpdateRenderer'
import { AutoGuideRenderer } from './components/game/AutoGuideRenderer'
import { StoryImageRenderer } from './components/game/StoryImageRenderer'

// RPG gameplay plugin renderers
import { SkillCheckResultRenderer } from './blockRenderers/SkillCheckResultRenderer'
import { CombatStartRenderer, CombatRoundRenderer, CombatEndRenderer } from './blockRenderers/CombatRenderer'
import { LootRenderer } from './blockRenderers/LootRenderer'
import { QuestRenderer } from './blockRenderers/QuestRenderer'
import { ReputationRenderer } from './blockRenderers/ReputationRenderer'
import { StatusEffectRenderer } from './blockRenderers/StatusEffectRenderer'
import { RelationshipRenderer } from './blockRenderers/RelationshipRenderer'
import { CodexRenderer } from './blockRenderers/CodexRenderer'
import { ItemUpdateRenderer } from './blockRenderers/ItemUpdateRenderer'

/**
 * Adapter: converts json:choices data into json:guide format
 * so that even when the LLM outputs choices, the richer guide UI is used.
 */
function ChoicesAsGuideRenderer(props: BlockRendererProps) {
  const raw = props.data as { prompt?: string; options?: string[] } | null
  if (!raw || !raw.options) return ChoicesRenderer(props)
  const guideData = {
    ...raw,
    categories: [
      { style: 'safe', label: raw.prompt || '选择', suggestions: raw.options },
    ],
  }
  return AutoGuideRenderer({ ...props, data: guideData })
}

registerBlockRenderer('choices', ChoicesAsGuideRenderer)
registerBlockRenderer('form', FormRenderer)
registerBlockRenderer('character_sheet', CharacterSheetRenderer)
registerBlockRenderer('notification', NotificationRenderer)
registerBlockRenderer('scene_update', SceneUpdateRenderer)
registerBlockRenderer('guide', AutoGuideRenderer)
registerBlockRenderer('story_image', StoryImageRenderer)

// RPG gameplay plugin block renderers
registerBlockRenderer('skill_check_result', SkillCheckResultRenderer)
registerBlockRenderer('combat_start', CombatStartRenderer)
registerBlockRenderer('combat_round', CombatRoundRenderer)
registerBlockRenderer('combat_end', CombatEndRenderer)
registerBlockRenderer('loot', LootRenderer)
registerBlockRenderer('quest_update', QuestRenderer)
registerBlockRenderer('reputation_change', ReputationRenderer)
registerBlockRenderer('status_effect', StatusEffectRenderer)
registerBlockRenderer('relationship_change', RelationshipRenderer)
registerBlockRenderer('codex_entry', CodexRenderer)
registerBlockRenderer('item_update', ItemUpdateRenderer)
