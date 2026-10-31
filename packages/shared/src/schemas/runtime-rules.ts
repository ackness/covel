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

import {
  CHARACTER_ACTOR_CONTRACT,
  TURN_POLICY_CONTRACT,
  FRAMEWORK_TOOL_NAMES,
} from "@covel/plugin-handlers-utils";
import { isKernelExtensionContract } from "../extension-points/contracts.js";
import {
  defaultAgentLoop,
  defaultLoopPreset,
  LOOP_PRESETS,
  type LoopPresetId,
} from "./runtime-defaults.js";

/** A model-facing tool name: what providers accept as a function name. */
export const SERVICE_IMPORT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The tool name of a service import: `as` when written, else the contract
 * without its version, dots turned into dashes (`inventory.items@1` →
 * `inventory-items`). Model-facing names carry no version.
 */
export function serviceImportName(
  entry: string | { readonly contract: string; readonly as?: string },
): string {
  if (typeof entry !== "string" && entry.as !== undefined) return entry.as;
  const contract = typeof entry === "string" ? entry : entry.contract;
  return contract.replace(/@[^@]*$/, "").replace(/\./g, "-");
}

/** The manifest fields the rules read, independent of where a manifest writes them. */
export interface RuntimeRuleView {
  readonly outputContract?: string;
  readonly defaultProvider?: boolean;
  readonly runtimeType?: string;
  readonly handler?: string;
  readonly stage?: string;
  readonly visibility?: string;
  readonly requireExplicitCompletion?: boolean;
  /** `true` when the runtime runs only as a sub-agent and is never scheduled. */
  readonly subagentOnly?: boolean;
  /** The guard module, if any. */
  readonly guard?: string;
  /**
   * The agent loop settings the rules read: the profile overrides as written,
   * and the runtime's time limit. Absent for a function runtime.
   */
  readonly loop?: {
    readonly preset?: string;
    readonly stream?: boolean;
    readonly steering?: boolean;
    readonly truncation?: string;
    readonly deadlineReserveMs?: number;
    /** The written time limit; the authored rules fall back to the default. */
    readonly timeoutMs?: number;
  };
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
  /** Ordering-only upstreams. */
  readonly after?: readonly unknown[];
  readonly output?: { readonly schema?: string; readonly recordAs?: string };
  /** `true` when a `manual` / `event` activation runs as a background job. */
  readonly background?: boolean;
  readonly builtinTools?: readonly string[];
  /** The package's own tools the runtime names. */
  readonly pluginTools?: readonly string[];
  /**
   * Imported services, with the tool name each one gets. `explicit` is set
   * when the author chose the name (`as`); the derived one is checked here.
   */
  readonly serviceImports?: readonly {
    readonly contract: string;
    readonly name: string;
    readonly explicit?: boolean;
  }[];
  /** Tools whose successful call completes the run. */
  readonly completingTools?: readonly string[];
  /** The authored short form of one completing tool. */
  readonly finishWith?: string;
  /** Names of the inputs read from the same execution (not committed, not kernel). */
  readonly turnInputs?: readonly string[];
  readonly operationsInputs?: readonly {
    readonly name: string;
    readonly path?: readonly (string | number)[];
  }[];
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
  | "subagentOnly"
  | "guard"
  | "loopPreset"
  | "loop"
  | "timeoutMs"
  | "detached"
  | "trigger"
  | "every"
  | "needs"
  | "after"
  | "output"
  | "background"
  | "inputs"
  | "builtinTools"
  | "pluginTools"
  | "serviceImports"
  | "completingTools"
  | "finishWith";

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
  subagentOnly: ["subagentOnly"],
  guard: ["guard"],
  loopPreset: ["loopProfile", "preset"],
  loop: ["loopProfile"],
  timeoutMs: ["timeoutMs"],
  detached: ["turnCompletion"],
  trigger: ["trigger"],
  every: ["trigger", "every"],
  needs: ["needs"],
  after: ["after"],
  output: ["output"],
  background: ["execution"],
  inputs: ["inputs"],
  builtinTools: ["tools", "builtin"],
  pluginTools: ["tools", "plugin"],
  serviceImports: ["tools", "services"],
  completingTools: ["completeAfterTools"],
  // The IR has only the long form; nothing writes this path.
  finishWith: ["completeAfterTools"],
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
  subagentOnly: ["schedule", "subagentOnly"],
  guard: ["guard"],
  loopPreset: ["agent", "loop", "profile"],
  loop: ["agent", "loop"],
  timeoutMs: ["agent", "loop", "timeoutMs"],
  detached: ["schedule", "detached"],
  trigger: ["schedule", "trigger"],
  every: ["schedule", "every"],
  needs: ["schedule", "needs"],
  after: ["schedule", "after"],
  output: ["io", "output"],
  background: ["schedule", "background"],
  inputs: ["io", "inputs"],
  builtinTools: ["agent", "tools", "builtin"],
  pluginTools: ["agent", "tools", "plugin"],
  serviceImports: ["agent", "tools", "services"],
  completingTools: ["agent", "completion", "afterTools"],
  finishWith: ["agent", "finishWith"],
};

type RulePath = (
  field: RuleField,
  ...rest: (string | number)[]
) => (string | number)[];

function isLoopPresetId(value: string | undefined): value is LoopPresetId {
  return value !== undefined && Object.hasOwn(LOOP_PRESETS, value);
}

/**
 * The agent loop profile rules. Only a story writes the narrative feed and
 * reads the player's interjections, so streaming and steering need
 * `visibility: story`; a kept truncated reply is one the player has already
 * read as it streamed.
 */
function loopProfileIssues(
  m: RuntimeRuleView,
  loop: NonNullable<RuntimeRuleView["loop"]>,
  { authoring }: { readonly authoring: boolean },
  at: RulePath,
  name: (field: RuleField, ...rest: string[]) => string,
  add: (path: readonly (string | number)[], message: string) => void,
): void {
  const story = m.visibility === "story";
  const storyOnly = `only a story (${name("visibility")} 'story') writes the narrative feed and reads player interjections`;
  if (loop.preset === "story" && !story)
    add(
      at("loopPreset"),
      `${name("loopPreset")} 'story' requires ${name("visibility")} 'story'; use 'actor' or 'system'`,
    );
  const preset =
    LOOP_PRESETS[
      isLoopPresetId(loop.preset)
        ? loop.preset
        : defaultLoopPreset(story ? "story" : undefined)
    ];
  const stream = loop.stream ?? preset.stream;
  const steering = loop.steering ?? preset.steering;
  // A story preset on another runtime is reported once, above.
  if (!story && loop.preset !== "story") {
    if (stream)
      add(
        at("loop", "stream"),
        `${name("loop", "stream")}: true requires ${name("visibility")} 'story'; ${storyOnly}`,
      );
    if (steering)
      add(
        at("loop", "steering"),
        `${name("loop", "steering")}: true requires ${name("visibility")} 'story'; ${storyOnly}`,
      );
  }
  // The preset's truncation counts too: turning a story's streaming off
  // without also rejecting truncation would keep a reply nobody read.
  const keptCut = `only a reply the player read as it streamed is kept when cut`;
  if (loop.truncation === "accept" && !stream)
    add(
      at("loop", "truncation"),
      `${name("loop", "truncation")} 'accept' requires ${name("loop", "stream")}: true; ${keptCut}`,
    );
  else if (
    loop.truncation === undefined &&
    preset.truncation === "accept" &&
    !stream
  )
    add(
      at("loop", "stream"),
      `${name("loop", "stream")}: false also needs ${name("loop", "truncation")} 'reject', since the profile keeps a truncated reply; ${keptCut}`,
    );
  const reserve = loop.deadlineReserveMs;
  // The loader fills an agent's default time limit, so an authored runtime
  // is checked against the limit its compiled form will carry.
  const timeoutMs =
    loop.timeoutMs ??
    (authoring && m.runtimeType !== "function"
      ? defaultAgentLoop(story ? "story" : undefined).timeoutMs
      : undefined);
  if (reserve !== undefined && timeoutMs !== undefined && reserve >= timeoutMs)
    add(
      at("loop", "finalizer", "deadlineReserveMs"),
      `${name("loop", "finalizer", "deadlineReserveMs")} must be smaller than ${name("timeoutMs")} (${timeoutMs})`,
    );
}

/**
 * A sub-agent-only runtime is never scheduled: another runtime runs it with
 * `ctx.agents.run` or `delegate`, and it returns output only. Scheduling
 * fields would do nothing, so each one is an error.
 */
function subagentOnlyIssues(
  m: RuntimeRuleView,
  at: RulePath,
  name: (field: RuleField, ...rest: string[]) => string,
  add: (path: readonly (string | number)[], message: string) => void,
): void {
  const runtime = `a sub-agent-only runtime (${name("subagentOnly")})`;
  if (m.runtimeType === "function")
    add(
      at("subagentOnly"),
      `${runtime} must be an agent runtime; a function runtime calls sub-agents with ctx.agents.run`,
    );
  if (m.visibility === "story")
    add(
      at("visibility"),
      `${runtime} returns output to its caller and cannot have ${name("visibility")} 'story'`,
    );
  if (m.trigger?.type !== undefined && m.trigger.type !== "manual")
    add(
      at("trigger", "type"),
      `${runtime} is activated by its caller; ${name("trigger", "type")} must be 'manual' or left out`,
    );
  if (m.stage !== undefined)
    add(at("stage"), `${runtime} is never scheduled; remove ${name("stage")}`);
  if (m.needs?.length)
    add(at("needs"), `${runtime} is never scheduled; remove ${name("needs")}`);
  if (m.after?.length)
    add(at("after"), `${runtime} is never scheduled; remove ${name("after")}`);
  if (m.background)
    add(
      at("background"),
      `${runtime} answers its caller directly and cannot run in the background; remove ${name("background")}`,
    );
  if (m.output?.recordAs !== undefined)
    add(
      at("output", "recordAs"),
      `${runtime} returns output only and records nothing; remove ${name("output", "recordAs")}`,
    );
  if (m.guard !== undefined)
    add(
      at("guard"),
      `${runtime} runs without a guard; the caller decides when to run it`,
    );
}

const FRAMEWORK_TOOLS: ReadonlySet<string> = new Set(FRAMEWORK_TOOL_NAMES);

/**
 * Imported services become tools of their own name. A name must be one a
 * model provider accepts and must not shadow a framework tool, another tool
 * of the runtime or another import. A runtime must finish without another
 * plugin, so an import never completes it.
 */
function serviceImportIssues(
  m: RuntimeRuleView,
  imports: NonNullable<RuntimeRuleView["serviceImports"]>,
  at: RulePath,
  name: (field: RuleField, ...rest: string[]) => string,
  add: (path: readonly (string | number)[], message: string) => void,
): void {
  if (m.runtimeType === "function") {
    add(
      at("serviceImports"),
      `a function runtime calls services with ctx.services; remove ${name("serviceImports")}`,
    );
    return;
  }
  const own = new Set([...(m.builtinTools ?? []), ...(m.pluginTools ?? [])]);
  const names = new Set<string>();
  const contracts = new Set<string>();
  for (const [i, entry] of imports.entries()) {
    const field = name("serviceImports");
    if (contracts.has(entry.contract))
      add(
        at("serviceImports", i),
        `${field} imports ${entry.contract} twice; import each contract once`,
      );
    contracts.add(entry.contract);
    if (!SERVICE_IMPORT_NAME_PATTERN.test(entry.name)) {
      // The schema reports a written name that breaks the pattern.
      if (!entry.explicit)
        add(
          at("serviceImports", i),
          `the tool name "${entry.name}" derived from ${entry.contract} is not a valid tool name (letters, digits, _ and -, at most 64); name it with as`,
        );
      continue;
    }
    const path = entry.explicit
      ? at("serviceImports", i, "as")
      : at("serviceImports", i);
    if (FRAMEWORK_TOOLS.has(entry.name))
      add(
        path,
        `the imported tool "${entry.name}" has the name of a framework tool; name it with as`,
      );
    else if (own.has(entry.name))
      add(
        path,
        `the imported tool "${entry.name}" has the name of a tool the runtime already declares; name it with as`,
      );
    else if (names.has(entry.name))
      add(
        path,
        `two imports are named "${entry.name}"; name one of them with as`,
      );
    names.add(entry.name);
  }
  const completes = (tool: string) =>
    `the imported tool "${tool}" cannot complete the run: it is absent when its provider is; complete with a tool of the runtime's own`;
  for (const [i, tool] of (m.completingTools ?? []).entries())
    if (names.has(tool)) add(at("completingTools", i), completes(tool));
  if (m.finishWith !== undefined && names.has(m.finishWith))
    add(at("finishWith"), completes(m.finishWith));
}

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

  if (m.outputContract === TURN_POLICY_CONTRACT)
    add(
      at("outputContract"),
      "turn-policy@1 is a read service, not a runtime output",
      "runtime",
    );
  if (m.outputContract === CHARACTER_ACTOR_CONTRACT && !m.subagentOnly)
    add(
      at("subagentOnly"),
      "character-actor@1 requires a sub-agent-only agent runtime",
      "runtime",
    );

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

  if (m.loop) loopProfileIssues(m, m.loop, { authoring }, at, name, add);

  if (m.serviceImports?.length)
    serviceImportIssues(m, m.serviceImports, at, name, add);

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

  // A sub-agent-only runtime is activated by its caller: `manual` is implied.
  const triggerType = m.trigger?.type ?? (m.subagentOnly ? "manual" : "auto");
  const activated = triggerType === "event" || triggerType === "manual";
  if (m.subagentOnly) subagentOnlyIssues(m, at, name, add);
  // A stage places a runtime in the per-turn DAG; event/manual are detached.
  if (m.stage !== undefined && activated && !m.subagentOnly)
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
    for (const input of m.operationsInputs ?? [])
      add(
        input.path ?? at("inputs", input.name),
        "a detached runtime cannot read kernel input operations@1",
      );
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
  if (triggerType === "auto" && m.stage === undefined)
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
