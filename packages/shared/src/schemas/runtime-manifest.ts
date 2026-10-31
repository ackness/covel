import { z } from "zod";
import {
  AUTHORING_RULE_FIELD_PATHS,
  RUNTIME_DISABLING_ISSUE_PARAMS,
  runtimeRuleIssues,
  serviceImportName,
} from "./runtime-rules.js";
import {
  agentToolsConfigSchema,
  authoringEverySchema,
  contractIdSchema,
  authoringTriggerSchema,
  detachedOptionsSchema,
  stageSchema,
  toolsConfigSchema,
  effectsDeclSchema,
  permissionsDeclSchema,
  pluginDataInjectDeclSchema,
  runtimeManifestInputSchema,
} from "./plugin-schemas.js";
import {
  AGENT_LOOP_DEFAULTS,
  DEFAULT_FUNCTION_HANDLER,
} from "./runtime-defaults.js";

const loopDefault = (field: "timeoutMs" | "callTimeoutMs" | "maxRetries") =>
  `Defaults to ${AGENT_LOOP_DEFAULTS.system[field]}; ${AGENT_LOOP_DEFAULTS.story[field]} with \`io.visibility: story\`.`;

/** The agent loop settings the shared runtime rules read. */
function authoredLoopView(
  loop:
    | {
        readonly profile?: string;
        readonly stream?: boolean;
        readonly steering?: boolean;
        readonly truncation?: string;
        readonly timeoutMs?: number;
        readonly finalizer?: { readonly deadlineReserveMs?: number };
      }
    | undefined,
) {
  return {
    preset: loop?.profile,
    stream: loop?.stream,
    steering: loop?.steering,
    truncation: loop?.truncation,
    deadlineReserveMs: loop?.finalizer?.deadlineReserveMs,
    timeoutMs: loop?.timeoutMs,
  };
}

export { contractIdSchema };
const textSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.string()),
]);
const runtimeRefSchema = z
  .string()
  .min(1)
  .describe(
    "Runtime ID in this package: `<pluginId>/<runtimeId>`, or the package ID for a single runtime.",
  );
const contractRefSchema = contractIdSchema.describe(
  "Contract ID. List it in the package's `requires` when a provider must be active; otherwise the runtime uses it when one is.",
);
const cardinalitySchema = z
  .enum(["one", "all"])
  .describe(
    "`one` takes a single provider; `all` takes every provider. Defaults to `one`.",
  );
const dependencyScopeSchema = z
  .enum(["turn", "session"])
  .describe(
    "`turn` gates on the same execution. `session` gates on the persistent setup snapshot and is valid only on stage `setup`.",
  );
const runtimeSourceSchema = z.union([
  z.strictObject({ runtime: runtimeRefSchema }),
  z.strictObject({
    contract: contractRefSchema,
    cardinality: cardinalitySchema.optional(),
  }),
]);
// `after` only orders: a contract named there never activates a provider, so
// it does not have to be a dependency of the package.
const afterSourceSchema = z.union([
  z.strictObject({ runtime: runtimeRefSchema }),
  z.strictObject({
    contract: contractIdSchema.describe(
      "Contract ID. This runtime runs after the contract's active providers; it never activates a provider.",
    ),
    cardinality: cardinalitySchema.optional(),
  }),
]);
const sourceSchema = z.union([
  runtimeSourceSchema,
  z.strictObject({
    kernel: z
      .literal("turn-digest@1")
      .describe(
        "Kernel input: the frozen last player input and the runtime results observed so far.",
      ),
  }),
]);
const afterSchema = z.union([z.string().min(1), afterSourceSchema]);
const needsSchema = z.union([
  z.string().min(1),
  z.strictObject({
    runtime: runtimeRefSchema,
    scope: dependencyScopeSchema.optional(),
  }),
  z.strictObject({
    contract: contractRefSchema,
    cardinality: cardinalitySchema.optional(),
    scope: dependencyScopeSchema.optional(),
  }),
]);
export const runtimeAuthoringManifestSchema = z
  .strictObject({
    description: textSchema
      .describe(
        "What the runtime does. Plain string; translations go in locale files.",
      )
      .optional(),
    schedule: z
      .strictObject({
        stage: stageSchema
          .describe(
            "Stage the runtime runs in. Required for an `auto` trigger, the default. Order: `setup`, `pre-turn`, `narrative`, `post-turn`, `audit`.",
          )
          .optional(),
        every: authoringEverySchema.optional(),
        trigger: authoringTriggerSchema
          .describe(
            "When the runtime is activated. Leave it out for an `auto` runtime without options.",
          )
          .optional(),
        needs: z
          .array(needsSchema)
          .describe(
            "Upstream runtimes or contracts that must succeed first. Sets order and gates this runtime.",
          )
          .optional(),
        after: z
          .array(afterSchema)
          .describe(
            "Upstream runtimes or contracts that run first. Sets order only; it does not gate and does not activate a provider.",
          )
          .optional(),
        detached: z
          .union([z.boolean(), detachedOptionsSchema])
          .describe(
            "`true` lets the turn finish before this runtime does: it runs afterwards as a durable background job. Only on stage `post-turn` or `audit`. An object sets the job's options and also makes it detached. Defaults to `false`: the turn waits.",
          )
          .optional(),
        background: z
          .boolean()
          .describe(
            "`true` runs a `manual` or `event` activation as a durable background job: the caller gets a job ID at once. Defaults to `false`: the caller waits for the result.",
          )
          .optional(),
        subagentOnly: z
          .boolean()
          .describe(
            "`true` makes this agent runtime a sub-agent provider: the scheduler never runs it, and another runtime runs it with `ctx.agents.run` or the `delegate` tool. It implies `trigger: manual` and allows no `stage`, `needs`, `after`, `background`, `io.output.recordAs`, `guard` or `io.visibility: story`. Defaults to `false`.",
          )
          .optional(),
      })
      .describe("When and in what order the runtime runs.")
      .optional(),
    io: z
      .strictObject({
        inputs: z
          .record(
            z.string().min(1),
            z.strictObject({
              from: sourceSchema.describe(
                "Producer of the value: a runtime in this package, a contract, or a kernel input. A kernel input takes no other field.",
              ),
              scope: z
                .enum(["turn", "committed"])
                .describe(
                  "`turn` reads the same execution's upstream result. `committed` reads the latest committed export and needs `recordAs`. Defaults to `turn`.",
                )
                .optional(),
              select: z
                .string()
                .meta({
                  description:
                    "JSON Pointer applied to the upstream value. Declaring `select` with `scope: committed` is rejected; committed inputs read the complete export.",
                  examples: ["/narrativeOutput"],
                })
                .optional(),
              required: z
                .boolean()
                .describe(
                  "`true` stops this runtime when the upstream value is missing or failed. Defaults to `true`. A story runtime (`io.visibility: story`) must set it to `false` for contract inputs.",
                )
                .optional(),
              accepts: z
                .string()
                .describe(
                  "Schema the bound value must satisfy: a local path or `contract:<contractId>`. It adds to the public contract check.",
                )
                .optional(),
              recordAs: z
                .string()
                .describe(
                  "Export key to read from the producer. Required with `scope: committed`.",
                )
                .optional(),
            }),
          )
          .describe(
            "Typed input bindings keyed by local name. An agent reads them at `runtime-inputs.<name>.value`.",
          )
          .optional(),
        selfData: z
          .array(pluginDataInjectDeclSchema.omit({ kind: true }))
          .describe("Own plugin data inlined into the agent prompt.")
          .optional(),
        payloadSchema: z
          .string()
          .describe("Schema that validates the activation payload.")
          .optional(),
        output: z
          .strictObject({
            contract: contractIdSchema
              .describe(
                "Contract this runtime's output publishes. The package provides it; `provides` needs no entry for it.",
              )
              .optional(),
            schema: z
              .string()
              .describe("Private schema that validates the runtime's output.")
              .optional(),
            recordAs: z
              .string()
              .describe(
                "Export key under which the output is persisted for later executions. Requires `schema`.",
              )
              .optional(),
          })
          .describe("What the runtime produces.")
          .optional(),
        visibility: z
          .enum(["story", "system"])
          .describe(
            "Output kind the kernel dispatches on: `story` for the main narrative provider, `system` for every other runtime. Defaults to `system`.",
          )
          .optional(),
        concealed: z
          .boolean()
          .describe(
            "`true` for a runtime that handles hidden content. Its prompt, model reply, tool arguments, results and output are removed from traces, live streams and API results, and text it returns is not written to the conversation. Not allowed with `visibility: story`.",
          )
          .optional(),
      })
      .describe("What the runtime reads and produces.")
      .optional(),
    agent: z
      .strictObject({
        model: z
          .string()
          .meta({
            description:
              "Model slot the agent uses. Defaults to `story` with `io.visibility: story`, otherwise `plugin`.",
            examples: ["utility"],
          })
          .optional(),
        toolChoice: z
          .union([
            z.literal("required"),
            z.strictObject({
              name: z.string().min(1).describe("Name of the tool to force."),
            }),
          ])
          .describe(
            "`required` makes the model call a tool on every step. `{ name }` makes it call that one tool. Without it, the model chooses.",
          )
          .optional(),
        reasoning: z
          .boolean()
          .describe(
            "`false` turns model reasoning off for this runtime. Defaults to `true`: the model's own reasoning setting applies.",
          )
          .optional(),
        history: runtimeManifestInputSchema.shape.history,
        tools: agentToolsConfigSchema
          .describe("Tools the agent's model may call.")
          .optional(),
        advertiseEvents: z
          .boolean()
          .describe(
            "`true` lists the session's event directory in the prompt so the model knows which topics it may emit.",
          )
          .optional(),
        finishWith: z
          .string()
          .min(1)
          .describe(
            "Tool that ends the run: the run completes after a successful call to it, and fails if it ends without one. The model must call a tool on every step (`toolChoice: required`) unless `toolChoice` says otherwise. Not with `completion`, which is the long form for several tools or explicit completion.",
          )
          .optional(),
        completion: z
          .strictObject({
            require: z
              .enum(["explicit", "tool-use"])
              .describe(
                "`explicit` needs a completing tool or `runtime-done`. `tool-use` needs a successful tool named in `afterTools`, or any successful business tool when `afterTools` is empty. Failed calls and `runtime-done` do not count.",
              )
              .optional(),
            afterTools: z
              .array(z.string())
              .describe(
                "The runtime completes after a successful call to one of these tools.",
              )
              .optional(),
          })
          .describe(
            "How the agent run ends. For one completing tool, `finishWith` is shorter.",
          )
          .optional(),
        loop: z
          .strictObject({
            maxSteps: z
              .number()
              .int()
              .positive()
              .describe(
                "Maximum number of tool-call steps. Use 1 or 2 for a runtime that calls one tool and stops.",
              )
              .optional(),
            timeoutMs: z
              .number()
              .int()
              .positive()
              .describe(
                `Time limit of the runtime in ms. The time a streamed model call spends writing does not count. ${loopDefault("timeoutMs")}`,
              )
              .optional(),
            callTimeoutMs: z
              .number()
              .int()
              .positive()
              .describe(
                `Time limit of one model call that is not streamed, in ms. ${loopDefault("callTimeoutMs")}`,
              )
              .optional(),
            firstTokenTimeoutMs: z
              .number()
              .int()
              .positive()
              .describe(
                "Time limit for the first streamed token in ms, the same for every attempt. Without it an attempt waits at most 120000, and no longer than leaves room in `timeoutMs` for the retries still allowed.",
              )
              .optional(),
            idleTimeoutMs: z
              .number()
              .int()
              .positive()
              .describe(
                "Longest silence of a streamed model call that has started to write, in ms. A model that keeps writing is not cut off. Defaults to 120000.",
              )
              .optional(),
            maxRetries: z
              .number()
              .int()
              .min(0)
              .max(5)
              .describe(
                `Retries on a transient model failure; \`0\` disables retry. ${loopDefault("maxRetries")}`,
              )
              .optional(),
            loopDetection: z
              .number()
              .int()
              .min(0)
              .max(20)
              .describe(
                "Number of repeated tool calls that counts as a loop. Defaults to 3; `0` disables detection.",
              )
              .optional(),
            maxRecursionDepth: z
              .number()
              .int()
              .min(0)
              .max(50)
              .describe(
                "Maximum depth of nested `ctx.recursiveCall()`. Defaults to 10.",
              )
              .optional(),
            profile: z
              .enum(["story", "actor", "system"])
              .describe(
                "Loop profile the other loop behaviour keys override. `story` streams to the player, reads interjections and keeps a cut reply; `actor` and `system` do neither, and `actor` answers without tools where `system` fails. Defaults to `story` with `io.visibility: story`, otherwise `system`.",
              )
              .optional(),
            stream: z
              .boolean()
              .describe(
                "Show the model's text to the player as it streams. Needs `io.visibility: story`. Defaults to the profile's value: true for `story`.",
              )
              .optional(),
            steering: z
              .boolean()
              .describe(
                "Merge the player's interjections into the transcript before each step and after a prose finish. Needs `io.visibility: story`. Defaults to the profile's value: true for `story`.",
              )
              .optional(),
            truncation: z
              .enum(["accept", "reject"])
              .describe(
                "`accept` keeps a reply cut at the output limit; `reject` fails it. `accept` needs streaming. Defaults to `accept` for `story`, otherwise `reject`.",
              )
              .optional(),
            fallback: z
              .enum(["answer-without-tools", "fail"])
              .describe(
                "What a repeated tool loop does: `answer-without-tools` takes the tools away and asks for the answer; `fail` stops the runtime. Defaults to `fail` for `system`, otherwise `answer-without-tools`.",
              )
              .optional(),
            corrections: z
              .strictObject({
                toolUse: z
                  .number()
                  .int()
                  .min(0)
                  .max(3)
                  .describe(
                    "Corrections for missing required tool use or explicit completion. Defaults to 1.",
                  )
                  .optional(),
                review: z
                  .number()
                  .int()
                  .min(0)
                  .max(5)
                  .describe(
                    "Corrections after a PostLLMResponse rejection. Defaults to 2.",
                  )
                  .optional(),
                loopPerturbation: z
                  .number()
                  .int()
                  .min(0)
                  .max(3)
                  .describe(
                    "Perturbations before the repeated-tool fallback. Defaults to 1.",
                  )
                  .optional(),
                outputRepair: z
                  .number()
                  .int()
                  .min(0)
                  .max(3)
                  .describe(
                    "Requests with tools off to repair invalid output. Defaults to 1.",
                  )
                  .optional(),
              })
              .describe(
                "Independent correction budgets for one agent loop run; 0 disables that correction.",
              )
              .optional(),
            finalizer: z
              .strictObject({
                maxSteps: z
                  .boolean()
                  .describe(
                    "At the step limit, ask once for the answer with tools off. `false` makes the step limit always fail. Defaults to true.",
                  )
                  .optional(),
                deadlineReserveMs: z
                  .number()
                  .int()
                  .min(0)
                  .describe(
                    "Stop starting steps this many ms before the time limit and ask for the answer with tools off, when prose can complete the runtime. At most half of `timeoutMs` is used; smaller than `timeoutMs`. Defaults to 0, off.",
                  )
                  .optional(),
              })
              .describe("The final answer step, with tools off.")
              .optional(),
          })
          .describe(
            "Time, retry and step limits of the agent loop, and its profile.",
          )
          .optional(),
      })
      .describe(
        "Settings of an agent runtime, the kind of a runtime without a `function` block: it drives model tool calls from the prompt body.",
      )
      .optional(),
    function: z
      .strictObject({
        handler: z
          .string()
          .min(1)
          .describe(
            `Path of the handler module, relative to this manifest. The module default-exports the handler function. Defaults to \`${DEFAULT_FUNCTION_HANDLER}\` next to the manifest when that file exists.`,
          )
          .optional(),
        model: z
          .string()
          .meta({
            description:
              "Model slot the handler's gateway calls route through. Declared so a detached job's credential readiness check judges the same slot the call resolves.",
            examples: ["memory"],
          })
          .optional(),
        timeoutMs: z
          .number()
          .int()
          .positive()
          .describe("Time limit of the handler in ms.")
          .optional(),
        tools: toolsConfigSchema
          .describe("Tools the handler may call through `ctx.tools.call`.")
          .optional(),
      })
      .describe(
        "Makes this a function runtime, which runs a JavaScript handler instead of a model. `function: {}` takes every default. Not allowed with `agent`.",
      )
      .optional(),
    guard: z
      .string()
      .describe(
        "Path of the guard module. It runs before the runtime and can skip it.",
      )
      .optional(),
    effects: effectsDeclSchema
      .describe(
        "Declared read and write sets, used to detect parallel hazards.",
      )
      .optional(),
    permissions: permissionsDeclSchema
      .describe("Declared permission upper bounds.")
      .optional(),
  })
  .superRefine((value, ctx) => {
    // The `function` block makes a function runtime; every other runtime is
    // an agent.
    const runtimeType = value.function ? "function" : "agent";
    if (value.function && value.agent)
      ctx.addIssue({
        code: "custom",
        path: ["agent"],
        message:
          "A runtime with a function block runs a handler and cannot declare agent; remove one of the two",
      });
    if (value.io?.concealed && value.io.visibility === "story")
      ctx.addIssue({
        code: "custom",
        path: ["io", "concealed"],
        message:
          "A runtime with io.visibility: story writes the text the player reads and cannot be io.concealed; conceal a system runtime instead",
      });
    if (value.agent?.finishWith !== undefined && value.agent.completion)
      ctx.addIssue({
        code: "custom",
        path: ["agent", "finishWith"],
        message:
          "agent.finishWith is the short form of agent.completion; write one of the two",
      });
    const detached = value.schedule?.detached;
    const inputs = Object.entries(value.io?.inputs ?? {});
    for (const issue of runtimeRuleIssues(
      {
        runtimeType,
        handler: value.function
          ? (value.function.handler ?? DEFAULT_FUNCTION_HANDLER)
          : undefined,
        stage: value.schedule?.stage,
        trigger: value.schedule?.trigger,
        every: value.schedule?.every,
        needs: value.schedule?.needs,
        after: value.schedule?.after,
        subagentOnly: value.schedule?.subagentOnly,
        guard: value.guard,
        ...(detached ? { detached: detached === true ? {} : detached } : {}),
        background: value.schedule?.background,
        builtinTools: (value.function ?? value.agent)?.tools?.builtin,
        pluginTools: (value.function ?? value.agent)?.tools?.plugin,
        serviceImports: value.agent?.tools?.services?.map((entry) => ({
          contract: typeof entry === "string" ? entry : entry.contract,
          name: serviceImportName(entry),
          explicit: typeof entry !== "string" && entry.as !== undefined,
        })),
        completingTools: value.agent?.completion?.afterTools,
        finishWith: value.agent?.finishWith,
        visibility: value.io?.visibility,
        output: value.io?.output,
        requireExplicitCompletion:
          value.agent?.completion?.require === "explicit",
        ...(value.agent ? { loop: authoredLoopView(value.agent.loop) } : {}),
        turnInputs: inputs
          .filter(
            ([, binding]) =>
              !("kernel" in binding.from) && binding.scope !== "committed",
          )
          .map(([name]) => name),
        contractInputs: inputs.flatMap(([name, binding]) =>
          "contract" in binding.from
            ? [
                {
                  name,
                  contract: binding.from.contract,
                  required: binding.required !== false,
                },
              ]
            : [],
        ),
      },
      {
        ...AUTHORING_RULE_FIELD_PATHS,
        builtinTools: [runtimeType, "tools", "builtin"],
      },
      { authoring: true },
    ))
      ctx.addIssue({
        code: "custom",
        path: [...issue.path],
        message: issue.message,
        ...(issue.disables ? { params: RUNTIME_DISABLING_ISSUE_PARAMS } : {}),
      });
    for (const [name, binding] of inputs) {
      // The kernel delivers its own inputs: a kernel input is always present
      // and never checked, so the binding options would do nothing.
      if ("kernel" in binding.from) {
        for (const field of [
          "scope",
          "select",
          "required",
          "accepts",
          "recordAs",
        ] as const)
          if (binding[field] !== undefined)
            ctx.addIssue({
              code: "custom",
              path: ["io", "inputs", name, field],
              message: `A kernel input takes only from; remove ${field}`,
            });
        continue;
      }
      if (binding.scope === "committed" && binding.select !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["io", "inputs", name, "select"],
          message:
            "Committed input cannot declare select; scope: committed reads the complete export",
        });
      if (binding.scope === "committed" && !binding.recordAs)
        ctx.addIssue({
          code: "custom",
          path: ["io", "inputs", name, "recordAs"],
          message: "Committed input requires recordAs",
        });
    }
  });
