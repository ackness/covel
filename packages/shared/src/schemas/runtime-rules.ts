/**
 * Cross-field rules of a runtime manifest, written once.
 *
 * The author writes a grouped RUNTIME.md (or the inline `runtime` of a
 * PLUGIN.md); the loader compiles it into the flat RuntimeManifest IR. Both
 * schemas apply these rules, each reporting an issue under its own field
 * path, so an author reads `schedule.completion.mode` where the IR says
 * `turnCompletion.mode`. JSON Schema cannot express them; the generated
 * schemas list them in their `description`.
 */

/** The manifest fields the rules read, independent of where a manifest writes them. */
export interface RuntimeRuleView {
  readonly outputContract?: string;
  readonly defaultProvider?: boolean;
  readonly runtimeType?: string;
  readonly handler?: string;
  readonly stage?: string;
  readonly visibility?: string;
  readonly requireExplicitCompletion?: boolean;
  readonly completion?: {
    readonly mode?: string;
    readonly settle?: string;
    readonly maxSettleWaitMs?: number;
    readonly maxQueueMs?: number;
    readonly maxExecutionMs?: number;
    readonly overlap?: string;
    readonly stalePolicy?: string;
  };
  readonly trigger?: {
    readonly type?: string;
    readonly topic?: string;
    readonly interval?: number;
    readonly startTurn?: number;
    readonly cooldownTurns?: number;
  };
  readonly needs?: readonly (string | { readonly scope?: string })[];
  readonly output?: { readonly schema?: string; readonly recordAs?: string };
  /** `sync` or `background`: how a `manual` / `event` activation runs. */
  readonly execution?: string;
  /** Names of the inputs read from the same execution (not committed, not kernel). */
  readonly turnInputs?: readonly string[];
}

type RuleField =
  | "defaultProvider"
  | "outputContract"
  | "runtimeType"
  | "handler"
  | "stage"
  | "visibility"
  | "requireExplicitCompletion"
  | "completion"
  | "trigger"
  | "needs"
  | "output"
  | "execution"
  | "inputs";

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
  completion: ["turnCompletion"],
  trigger: ["trigger"],
  needs: ["needs"],
  output: ["output"],
  execution: ["execution"],
  inputs: ["inputs"],
};

/** The grouped RUNTIME.md an author writes. */
export const AUTHORING_RULE_FIELD_PATHS: RuntimeRuleFieldPaths = {
  defaultProvider: ["provides"],
  outputContract: ["io", "output", "contract"],
  runtimeType: ["type"],
  handler: ["function", "handler"],
  stage: ["schedule", "stage"],
  visibility: ["io", "visibility"],
  requireExplicitCompletion: ["agent", "loop", "completion", "require"],
  completion: ["schedule", "completion"],
  trigger: ["schedule", "trigger"],
  needs: ["schedule", "needs"],
  output: ["io", "output"],
  execution: ["schedule", "manual", "execution"],
  inputs: ["io", "inputs"],
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

  const completion = m.completion;
  if (
    completion?.maxSettleWaitMs !== undefined &&
    completion.settle === undefined
  )
    add(
      at("completion", "maxSettleWaitMs"),
      `${name("completion", "maxSettleWaitMs")} requires ${name("completion", "settle")}`,
    );
  if ((completion?.mode ?? "await") === "detached") {
    const mode = `${name("completion", "mode")} 'detached'`;
    if (m.stage !== "post-turn" && m.stage !== "audit")
      add(
        at("stage"),
        `${mode} is only valid on ${name("stage")} 'post-turn' or 'audit'`,
      );
    if (m.visibility === "story")
      add(
        at("visibility"),
        `${mode} cannot be used with ${name("visibility")} 'story'`,
      );
    if (activated)
      add(
        at("trigger", "type"),
        `event/manual runtimes run in the background with ${name("execution")}; ${mode} is for staged runtimes`,
      );
  } else if (
    completion?.settle !== undefined ||
    completion?.maxSettleWaitMs !== undefined ||
    completion?.maxQueueMs !== undefined ||
    completion?.maxExecutionMs !== undefined ||
    completion?.overlap !== undefined ||
    completion?.stalePolicy !== undefined
  )
    add(
      at("completion", "mode"),
      `the detached options of ${name("completion")} require ${name("completion", "mode")} 'detached'`,
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
  if (m.stage === "setup" && m.trigger) {
    if (m.trigger.type !== "auto")
      add(
        at("trigger", "type"),
        `${name("stage")} 'setup' requires ${name("trigger", "type")} 'auto'`,
      );
    for (const field of ["interval", "startTurn", "cooldownTurns"] as const)
      if (m.trigger[field] !== undefined)
        add(
          at("trigger", field),
          `${name("stage")} 'setup' cannot set ${name("trigger", field)}`,
        );
  }

  if (!authoring) return issues;

  // The scheduler runs `auto` / `scheduled` runtimes stage by stage. Without
  // a stage this one would never run; no default is guessed.
  const triggerType = m.trigger?.type ?? "auto";
  if (
    (triggerType === "auto" || triggerType === "scheduled") &&
    m.stage === undefined
  )
    add(
      at("stage"),
      `${name("stage")} is required for ${name("trigger", "type")} '${triggerType}'; choose setup, pre-turn, narrative, post-turn or audit, or use trigger 'manual' or 'event'`,
      "runtime",
    );

  // An event/manual runtime that always runs in the background has no
  // same-execution upstream: no activation could satisfy a turn input.
  if (activated && m.execution === "background")
    for (const input of m.turnInputs ?? [])
      add(
        at("inputs", input),
        `${name("execution")} 'background' on an event/manual runtime cannot read a same-execution input; read it with scope: committed or run the runtime in sync`,
        "runtime",
      );

  return issues;
}
