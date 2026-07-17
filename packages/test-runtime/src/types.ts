import type { MediaStore } from "@covel/store";

/**
 * Shared options for the runtime-debug harness.
 *
 * Lives in its own module so both `runner.ts` (consumer) and `cases.ts`
 * (builder) can depend on it without forming an import cycle.
 */
export interface RunRuntimeDebugOptions {
  readonly target?: string;
  readonly runtimeId?: string;
  readonly pluginId?: string;
  readonly pluginsDir?: string;
  readonly sessionId?: string;
  readonly locale?: string;
  readonly message?: string;
  readonly payload?: Record<string, unknown>;
  readonly userSettings?: Record<string, unknown>;
  readonly llmResponse?: Record<string, unknown>;
  readonly llmResponses?: readonly Record<string, unknown>[];
  readonly llmContent?: string;
  readonly llmObject?: Record<string, unknown>;
  /** Optional preset id surfaced by the mock gateway's resolveSlot. */
  readonly mockPresetId?: string;
  readonly showPrompts?: boolean;
  readonly ignoreUpstreams?: boolean;
  readonly expectsBackgroundFollower?: boolean;
  readonly mode?: "mock" | "live";
  readonly caseName?: string;
  readonly mediaStore?: MediaStore;
}
