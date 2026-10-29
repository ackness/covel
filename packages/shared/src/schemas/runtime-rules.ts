/**
 * Cross-field rules of a runtime manifest, written once.
 *
 * The author writes a grouped RUNTIME.md (or the inline `runtime` of a
 * PLUGIN.md); the loader compiles it into the flat RuntimeManifest IR. Both
 * schemas apply these rules, each reporting an issue under its own field
 * path, so an author reads `schedule.detached` where the IR says
 * `turnCompletion`. JSON Schema cannot express them; the generated schemas
 * list them in their `description`.
 */

import { isKernelExtensionContract } from "../extension-points/contracts.js";

/** The manifest fields the rules read, independent of where a manifest writes them. */
export interface RuntimeRuleView {
  readonly outputContract?: string;
  readonly defaultProvider?: boolean;
  readonly runtimeType?: string;
  readonly handler?: string;
  readonly stage?: string;
  readonly visibility?: string;
  readonly requireExplicitCompletion?: boolean;
  /** Set when the turn finishes before this staged runtime does. */
  readonly detached?: {
    readonly settle?: boolean;
    readonly maxSettleWaitMs?: number;
    readonly maxQueueMs?: number;
    readonly maxExecutionMs?: number;
  };
  readonly trigger?: {
    readonly type?: string;
    readonly topic?: string;
    readonly startTurn?: number;
    readonly cooldownTurns?: number;
  };
  /** Cadence of an `auto` runtime, in logical turns. */
  readonly every?: number;
  readonly needs?: readonly (
    | string
    | {
        readonly scope?: string;
        readonly contract?: string;
        readonly capability?: string;
      }
  )[];
  readonly output?: { readonly schema?: string; readonly recordAs?: string };
  /** `true` when a `manual` / `event` activation runs as a background job. */
  readonly background?: boolean;
  readonly builtinTools?: readonly string[];
  /** Names of the inputs read from the same execution (not committed, not kernel). */
  readonly turnInputs?: readonly string[];
  /**
   * Inputs bound to a contract (`turn` and `committed` scope; not kernel
   * inputs). `required` is the effective value, `true` by default.
   */
  readonly contractInputs?: readonly {
    readonly name: string;
    readonly contract: string;
    readonly required: boolean;
  }[];
}

type RuleField =
  | "defaultProvider"
  | "outputContract"
  | "runtimeType"
  | "handler"
  | "stage"
  | "visibility"
  | "requireExplicitCompletion"
  | "detached"
  | "trigger"
  | "every"
  | "needs"
  | "output"
  | "background"
  | "inputs"
  | "builtinTools";

/** Where a manifest format writes each field the rules read. */
export type RuntimeRuleFieldPaths = Readonly<
  Record<RuleField, readonly string[]>
>;

/** The compiled RuntimeManifest IR. */
export const IR_RULE_FIELD_PATHS: RuntimeRuleFieldPaths = {
  defaultProvider: ["defaultProvider"],
  outputContract: ["outputContract"],
  runtimeType: ["runtimeType"],
  handler: ["handler"],
  stage: ["stage"],
  visibility: ["outputKind"],
  requireExplicitCompletion: ["requireExplicitCompletion"],
  detached: ["turnCompletion"],
  trigger: ["trigger"],
  every: ["trigger", "every"],
  needs: ["needs"],
  output: ["output"],
  background: ["execution"],
  inputs: ["inputs"],
  builtinTools: ["tools", "builtin"],
};

/** The grouped RUNTIME.md an author writes. */
export const AUTHORING_RULE_FIELD_PATHS: RuntimeRuleFieldPaths = {
  defaultProvider: ["provides"],
  outputContract: ["io", "output", "contract"],
  runtimeType: ["function"],
  handler: ["function", "handler"],
  stage: ["schedule", "stage"],
  visibility: ["io", "visibility"],
  requireExplicitCompletion: ["agent", "completion", "require"],
  detached: ["schedule", "detached"],
  trigger: ["schedule", "trigger"],
  every: ["schedule", "every"],
  needs: ["schedule", "needs"],
  output: ["io", "output"],
  background: ["schedule", "background"],
  inputs: ["io", "inputs"],
  builtinTools: ["agent", "tools", "builtin"],
};

export interface RuntimeRuleIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
  /**
   * `runtime`: the problem makes this one runtime unable to run, and nothing
   * else in the package. Loading leaves the runtime out and reports why;
   * authoring validation and installation reject the package.
   */
  readonly disables?: "runtime";
}

/** Zod issue `params` that mark an issue as {@link RuntimeRuleIssue.disables}. */
export const RUNTIME_DISABLING_ISSUE_PARAMS = { disables: "runtime" } as const;

/** Whether a Zod issue only disables the runtime it is about. */
export function isRuntimeDisablingIssue(issue: {
  readonly code?: string;
  readonly params?: unknown;
}): boolean {
  return (
    issue.code === "custom" &&
    typeof issue.params === "object" &&
    issue.params !== null &&
    (issue.params as { disables?: unknown }).disables === "runtime"
  );
}

/**
 * Check one runtime. `authoring` adds the rules that only an authored
 * manifest can break: the IR is compiled from one that passed them.
 */
export function runtimeRuleIssues(
  m: RuntimeRuleView,
  paths: RuntimeRuleFieldPaths,
  { authoring = false }: { readonly authoring?: boolean } = {},
): RuntimeRuleIssue[] {
  const issues: RuntimeRuleIssue[] = [];
  const at = (field: RuleField, ...rest: (string | number)[]) => [
    ...paths[field],
    ...rest,
  ];
  const name = (field: RuleField, ...rest: string[]) =>
    at(field, ...rest).join(".");
  const add = (
    path: readonly (string | number)[],
    message: string,
    disables?: "runtime",
  ) => issues.push({ path, message, ...(disables ? { disables } : {}) });

  if (m.defaultProvider && !m.outputContract)
    add(
      at("defaultProvider"),
      `a default provider requires ${name("outputContract")}`,
    );

  if (
    m.requireExplicitCompletion &&
    (m.runtimeType === "function" ||
      m.visibility === "story" ||
      m.output?.schema)
  )
    add(
      at("requireExplicitCompletion"),
      `explicit completion (${name("requireExplicitCompletion")}) is for non-story agent runtimes without ${name("output", "schema")}; completion uses tools or runtime-done`,
    );

  if (m.runtimeType === "function" && !m.handler?.trim())
    add(at("handler"), `${name("handler")} is required for a function runtime`);

  // recordAs is only meaningful with a schema validating the recorded value.
  if (m.output?.recordAs !== undefined && m.output.schema === undefined)
    add(
      at("output", "schema"),
      `${name("output", "schema")} is required when ${name("output", "recordAs")} is declared`,
    );

  // An event trigger without a topic never subscribes to anything.
  if (m.trigger?.type === "event" && !m.trigger.topic)
    add(
      at("trigger", "topic"),
      `${name("trigger", "topic")} is required for ${name("trigger", "type")} 'event'`,
    );

  const activated = m.trigger?.type === "event" || m.trigger?.type === "manual";
  // A stage places a runtime in the per-turn DAG; event/manual are detached.
  if (m.stage !== undefined && activated)
    add(
      at("stage"),
      `a runtime with ${name("stage")} cannot use ${name("trigger", "type")} 'event' or 'manual'`,
    );
  // A cadence counts the turns an `auto` runtime runs in; an activated one
  // runs when it is called.
  if (m.every !== undefined && activated)
    add(
      at("every"),
      `${name("every")} is for an 'auto' runtime; a runtime with ${name("trigger", "type")} 'event' or 'manual' runs when it is activated`,
    );

  const detached = m.detached;
  if (detached?.maxSettleWaitMs !== undefined && !detached.settle)
    add(
      at("detached", "maxSettleWaitMs"),
      `${name("detached", "maxSettleWaitMs")} requires ${name("detached", "settle")}`,
    );
  if (detached) {
    const runtime = `a detached runtime (${name("detached")})`;
    if (m.stage !== "post-turn" && m.stage !== "audit")
      add(
        at("stage"),
        `${runtime} is only valid on ${name("stage")} 'post-turn' or 'audit'`,
      );
    if (m.visibility === "story")
      add(
        at("visibility"),
        `${runtime} cannot have ${name("visibility")} 'story'`,
      );
    if (activated)
      add(
        at("trigger", "type"),
        `event/manual runtimes run in the background with ${name("background")}; ${runtime} is for staged runtimes`,
      );
  }

  // Background work cannot wait for player input. Runtime execution also
  // rejects suspension returned by a handler or a triggered event runtime.
  if (m.builtinTools?.includes("suspend") && (m.background || detached))
    add(
      at("builtinTools"),
      "a background runtime cannot use the 'suspend' tool",
    );

  // `needs(scope: session)` gates on the persistent setup snapshot — the
  // positive gate lives in the setup selection path only, so on any other
  // stage the declaration would be accepted-but-inert. Reject it instead of
  // letting a dead gate ship.
  if (m.stage !== "setup")
    for (const [i, need] of (m.needs ?? []).entries())
      if (typeof need !== "string" && need.scope === "session")
        add(
          at("needs", i, "scope"),
          `${name("needs")} scope 'session' is only valid with ${name("stage")} 'setup' (it gates on the persistent setup snapshot)`,
        );

  // Setup runs before the turn loop: fixed auto trigger, no cadence fields.
  if (m.stage === "setup") {
    if (m.trigger && (m.trigger.type ?? "auto") !== "auto")
      add(
        at("trigger", "type"),
        `${name("stage")} 'setup' requires ${name("trigger", "type")} 'auto'`,
      );
    for (const field of ["startTurn", "cooldownTurns"] as const)
      if (m.trigger?.[field] !== undefined)
        add(
          at("trigger", field),
          `${name("stage")} 'setup' cannot set ${name("trigger", field)}`,
        );
    if (m.every !== undefined)
      add(at("every"), `${name("stage")} 'setup' cannot set ${name("every")}`);
  }

  if (!authoring) return issues;

  // The scheduler runs `auto` runtimes stage by stage. Without a stage this
  // one would never run; no default is guessed.
  if ((m.trigger?.type ?? "auto") === "auto" && m.stage === undefined)
    add(
      at("stage"),
      `${name("stage")} is required for ${name("trigger", "type")} 'auto', the default; choose setup, pre-turn, narrative, post-turn or audit, or use trigger 'manual' or 'event'`,
      "runtime",
    );

  // A story runtime must run without any other package: the player can play
  // with only one narrative plugin. Every contract is foreign, so a contract
  // that must resolve (a required input or a `needs` gate) would turn the
  // story off with its provider. Kernel extension contracts are exempt.
  if (m.visibility === "story") {
    const story = `a story runtime (${name("visibility")} 'story')`;
    for (const input of m.contractInputs ?? [])
      if (input.required && !isKernelExtensionContract(input.contract))
        add(
          at("inputs", input.name, "required"),
          `${story} cannot require contract ${input.contract}: set ${name("inputs", input.name, "required")}: false so the story still runs when no provider is active`,
        );
    for (const [i, need] of (m.needs ?? []).entries()) {
      if (typeof need === "string") continue;
      const contract = need.contract ?? need.capability;
      if (contract !== undefined && !isKernelExtensionContract(contract))
        add(
          at("needs", i),
          `${story} cannot gate on contract ${contract} in ${name("needs")}; bind it as an optional input (required: false) or use schedule.after to order only`,
        );
    }
  }

  // An event/manual runtime that always runs in the background has no
  // same-execution upstream: no activation could satisfy a turn input.
  if (activated && m.background)
    for (const input of m.turnInputs ?? [])
      add(
        at("inputs", input),
        `an event/manual runtime that runs in the background (${name("background")}) cannot read a same-execution input; read it with scope: committed or let the caller wait for it`,
        "runtime",
      );

  return issues;
}
