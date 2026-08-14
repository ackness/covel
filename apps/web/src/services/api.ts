/**
 * API client for communicating with the Covel server.
 *
 * This file stays as the public compatibility entrypoint. Implementation is
 * split by endpoint family under ./api/.
 */

export { getDesktopRestToken } from "@/lib/desktop-bridge";
export {
  clearOperatorToken,
  clearSessionToken,
  getOperatorToken,
  getSessionToken,
  storeOperatorToken,
  storeSessionToken,
} from "./session-credentials.js";

export * from "./api/types.js";
export * from "./api/worlds.js";
export * from "./api/sessions.js";
export * from "./api/packages.js";
export * from "./api/llm.js";
export * from "./api/media.js";
export * from "./api/actions.js";
export {
  addCustomPreset,
  clearPrepRuntimeBindings,
  getCustomPresets,
  getParamOverrides,
  getPrepRuntimeBindings,
  getProviderKeys,
  getProviderPriceMultiplier,
  getProviderPriceMultipliers,
  getProviderProfiles,
  getSlotConfig,
  loadProviderKeysFromStorage,
  removeCustomPreset,
  setCustomPresets,
  setParamOverrides,
  setPrepRuntimeBindings,
  setProviderKeys,
  setProviderKeysAsync,
  setProviderPriceMultipliers,
  setProviderProfiles,
  setSlotConfig,
  slotBindingId,
} from "./api/model-settings.js";
export type {
  CustomPreset,
  ModelParameterOverrides,
  SlotConfigEntry,
} from "./api/model-settings.js";
export {
  flattenProviderProfiles,
  profilesFromLegacyPresets,
  upsertProviderModel,
} from "./api/provider-model-profiles.js";
export type {
  ProviderModelEntry,
  ProviderModelProfile,
} from "./api/provider-model-profiles.js";
export * from "./api/overlay.js";
export * from "./api/plugin-data.js";
export * from "./api/plugin-rpc.js";
export * from "./api/approvals.js";
export * from "./api/traces.js";
export * from "./api/health.js";
