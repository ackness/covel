// ── Types ─────────────────────────────────────────────────────────
export * from './types/index.js';

// ── Utilities ─────────────────────────────────────────────────────
export { deepMerge } from './utils/deep-merge.js';

// ── Schemas ──────────────────────────────────────────────────────
export {
  triggerTypeSchema,
  triggerConfigSchema,
  inputInjectDeclSchema,
  inputToolDeclSchema,
  inputConfigSchema,
  outputConfigSchema,
  toolsConfigSchema,
  configFieldTypeSchema,
  pluginConfigFieldSchema,
  runtimeManifestSchema,
} from './schemas/plugin.js';

export type { RuntimeManifestInput } from './schemas/plugin.js';
