# core-persona

Provides the narrator's voice, behavior rules, and world context as the foundation system prompt layer.

## Responsibilities
- Establish the narrator persona (calm, concrete, GM-style)
- Inject world lore as authoritative reference material
- Match narration style to the world genre (wuxia, cyberpunk, cultivation, harbor noir, etc.)
- Enforce the rule: never decide for the player, always describe and let them choose

## Context Priority
This plugin runs at `pre_story` phase with priority 100 (highest), ensuring the narrator persona and world setting are always the first context layer seen by the LLM.
