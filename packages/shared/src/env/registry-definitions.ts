/**
 * Aggregated environment-variable registry.
 *
 * The definitions are split by group under `env/groups/*.ts` for
 * maintainability; this module re-exports the shared types and stitches the
 * groups back into the single `COVEL_ENV_REGISTRY` tuple that the rest of the
 * codebase consumes. Group order is preserved (storage → server → desktop →
 * ai → feature → web → test → packaging) so name lookups and any
 * ordering-sensitive consumers behave identically to the pre-split registry.
 */

import { AI_ENV_VARS } from "./groups/ai.js";
import { DESKTOP_ENV_VARS } from "./groups/desktop.js";
import { FEATURE_ENV_VARS } from "./groups/feature.js";
import { PACKAGING_ENV_VARS } from "./groups/packaging.js";
import { SERVER_ENV_VARS } from "./groups/server.js";
import { STORAGE_ENV_VARS } from "./groups/storage.js";
import { TEST_ENV_VARS } from "./groups/test.js";
import { WEB_ENV_VARS } from "./groups/web.js";

export type {
  EnvGroup,
  EnvStatus,
  EnvValueType,
  EnvVarDefinition,
} from "./types.js";

export const COVEL_ENV_REGISTRY = [
  ...STORAGE_ENV_VARS,
  ...SERVER_ENV_VARS,
  ...DESKTOP_ENV_VARS,
  ...AI_ENV_VARS,
  ...FEATURE_ENV_VARS,
  ...WEB_ENV_VARS,
  ...TEST_ENV_VARS,
  ...PACKAGING_ENV_VARS,
] as const;

export type CovelEnvName = (typeof COVEL_ENV_REGISTRY)[number]["name"];

export const COVEL_FEATURE_FLAGS = ["COVEL_LLM_RETRY_DISABLED"] as const;

export type CovelFeatureFlag = (typeof COVEL_FEATURE_FLAGS)[number];
