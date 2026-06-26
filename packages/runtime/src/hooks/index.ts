/**
 * Hook lifecycle pipeline — barrel export.
 */

export { HookPipeline, createHookPipeline } from "./pipeline.js";
export { HOOK_SEMANTICS } from "./types.js";
export {
  registerPluginHooks,
  type PluginHookSource,
  type RegisterPluginHooksOptions,
} from "./register-plugin-hooks.js";
export {
  runSessionStartHook,
  runSessionEndHook,
  type SessionStartPayload,
  type SessionEndPayload,
} from "./wire-helpers.js";
export {
  runWithHookScope,
  currentActivePluginIds,
  type HookScope,
} from "./hook-scope.js";
export type {
  HookEvent,
  HookSemantic,
  HookEnforce,
  HookContext,
  HookResult,
  HookHandler,
  HookRegistration,
  HookDeclaration,
} from "./types.js";
