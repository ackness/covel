// ── Types ─────────────────────────────────────────────────────────
export * from './types/index.js';

// ── Utilities ─────────────────────────────────────────────────────
export { deepMerge } from './utils/deep-merge.js';
export {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  splitPromptCacheSegments,
  stripPromptCacheMarkers,
} from './utils/prompt-cache.js';

// ── Plugin Schemas ───────────────────────────────────────────────
export {
  triggerTypeSchema,
  triggerConfigSchema,
  inputInjectDeclSchema,
  inputToolDeclSchema,
  inputConfigSchema,
  outputKindSchema,
  outputConfigSchema,
  toolsConfigSchema,
  configFieldTypeSchema,
  pluginConfigFieldSchema,
  hookDeclarationSchema,
  authorsNoteDeclSchema,
  postHistoryDeclSchema,
  runtimeManifestSchema,
} from './schemas/plugin.js';

export type { RuntimeManifestInput } from './schemas/plugin.js';

// ── World Schemas ───────────────────────────────────────────────
export {
  i18nTextSchema,
  worldManifestSchema,
  worldDimensionsSchema,
  worldGeographySchema,
  worldFactionSchema,
  worldPowerSystemSchema,
  worldHistoryEventSchema,
  worldEconomySchema,
  worldSocialStructureSchema,
  worldToneSchema,
  worldMechanicsSchema,
  worldStartingConditionsSchema,
  DIMENSION_KEY_SCHEMAS,
  DIMENSION_KEYS,
} from './schemas/world.js';

export type { WorldManifestInput } from './schemas/world.js';

// ── Validation Utilities ────────────────────────────────────────
export {
  validatePluginManifest,
  validateWorldManifest,
  validateDimensionData,
  validateDimensions,
  formatValidationErrors,
} from './schemas/validate.js';

export type {
  ManifestValidationResult,
  ManifestValidationError,
} from './schemas/validate.js';
