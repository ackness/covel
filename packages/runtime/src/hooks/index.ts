/**
 * Hook lifecycle pipeline — barrel export.
 */

export { HookPipeline, createHookPipeline } from "./pipeline.js";
export { HOOK_SEMANTICS } from "./types.js";
export {
  runSessionStartHook,
  runSessionEndHook,
  type SessionStartPayload,
  type SessionEndPayload,
} from "./wire-helpers.js";
export {
  MissingHookScopeError,
  requireHookScope,
  runWithHookScope,
  type HookScope,
} from "./hook-scope.js";
export type {
  HookEvent,
  HookSemantic,
  HookContext,
  HookResult,
  HookHandler,
  HookRegistration,
} from "./types.js";
export type { HookEnforce, HookDeclaration } from "@covel/shared";
