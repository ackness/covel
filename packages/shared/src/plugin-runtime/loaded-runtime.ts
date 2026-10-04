import type { RuntimeManifest } from "../index.js";
import type { FunctionHandler, AgentGuard } from "./handler.js";
import type { PluginMessageCatalog } from "../utils/plugin-messages.js";

/** Level 2: fully loaded runtime ready for execution. */
export interface LoadedRuntime {
  readonly manifest: RuntimeManifest;
  readonly promptTemplate: string;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Published contract of the complete output, independent of output.schema. */
  readonly outputContractSchema?: Readonly<Record<string, unknown>>;
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
   * Published schemas of contract-sourced `inputs` bindings, keyed by binding
   * name. Each provider's full output must satisfy its contract before `select`.
   */
  readonly bindingContractSchemas?: Readonly<
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
  /**
   * Optional `inputs` / `input.inject` bindings whose `accepts` names a
   * contract that no installed package publishes. Their values cannot be
   * checked, so they are never delivered.
   */
  readonly unresolvedAccepts?: readonly string[];
  /** Published contracts for complete committed export values, keyed by binding. */
  readonly exportContractSchemas?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /** Handler function for `runtimeType: 'function'` runtimes. */
  readonly handler?: FunctionHandler;
  /** Guard function — runs before agent execution, returns `{ skip: true }` to bypass LLM. */
  readonly guard?: AgentGuard;
  /**
   * The plugin's `messages` translations, one per `locales/<locale>.yaml`.
   * The host turns them into `ctx.messages` for the session's language.
   */
  readonly messages?: readonly PluginMessageCatalog[];
  /** Loaded UI specs from ui/ directory, grouped by slot. */
  readonly uiSpecs?: {
    readonly right?: readonly Readonly<Record<string, unknown>>[];
    readonly message?: readonly Readonly<Record<string, unknown>>[];
    readonly left?: readonly Readonly<Record<string, unknown>>[];
  };
}
