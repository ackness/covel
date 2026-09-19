import type { RuntimeManifest, RuntimeActivation } from "../index.js";
import type { FunctionHandler, AgentGuard } from "./handler.js";

/** Level 2: fully loaded runtime ready for execution. */
export interface LoadedRuntime {
  readonly manifest: RuntimeManifest;
  readonly promptTemplate: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /**
   * Activation-payload JSON Schema loaded from `input.schema` — enforced on
   * `RuntimeActivation.payload` before dispatch for both function and agent
   * runtimes (docs 02 §3.3).
   */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
  /**
   * Per-binding `accepts` JSON Schemas, keyed by `inputs.<name>`. Validates the
   * injected same-execution binding value (docs 02 §3.1).
   */
  readonly bindingAcceptsSchemas?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /**
   * Per-export-binding `accepts` JSON Schemas, keyed by the `input.inject`
   * runtime-export `name`. Validates the frozen cross-execution export value at
   * consume time (docs 02 §3.4.4).
   */
  readonly exportAcceptsSchemas?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /** Handler function for `runtimeType: 'function'` runtimes. */
  readonly handler?: FunctionHandler;
  /** Guard function — runs before agent execution, returns `{ skip: true }` to bypass LLM. */
  readonly guard?: AgentGuard;
  /** Loaded UI specs from ui/ directory, grouped by slot. */
  readonly uiSpecs?: {
    readonly right?: readonly Readonly<Record<string, unknown>>[];
    readonly message?: readonly Readonly<Record<string, unknown>>[];
    readonly left?: readonly Readonly<Record<string, unknown>>[];
  };
}
