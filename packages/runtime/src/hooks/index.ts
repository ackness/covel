/**
 * Hook lifecycle pipeline — barrel export.
 */

export { HookPipeline, createHookPipeline } from './pipeline.js';
export type {
  HookEvent,
  HookContext,
  HookResult,
  HookHandler,
  HookRegistration,
  HookDeclaration,
} from './types.js';
