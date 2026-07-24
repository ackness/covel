/**
 * Manifest → NormalizedRuntimeSpec normalization.
 *
 * The implementation moved to `@covel/shared` so that pure-shared consumers
 * (e.g. `@covel/context` prompt aggregation) can read the scheduling IR
 * without depending on the plugin loader. Re-exported here to keep the
 * loader's public surface and existing import sites stable.
 */

export {
  normalizeRuntimeManifest,
  stageForPriority,
  getRuntimeSpec,
} from "@covel/shared";
