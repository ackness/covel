import { z } from "zod";
import {
  triggerConfigSchema,
  stageSchema,
  turnCompletionConfigSchema,
  toolsConfigSchema,
  effectsDeclSchema,
  permissionsDeclSchema,
  pluginDataInjectDeclSchema,
  runtimeManifestInputSchema,
} from "./plugin-schemas.js";

export const contractIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/);
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
  "Contract ID. It must be listed in the package's `requires` or `optional`.",
);
const cardinalitySchema = z
  .enum(["one", "all"])
  .describe("`one` takes a single provider; `all` takes every provider.");
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
const afterSchema = z.union([z.string().min(1), runtimeSourceSchema]);
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
    type: z
      .enum(["agent", "function"])
      .describe(
        "`agent` drives model tool calls from the prompt body. `function` runs a JavaScript handler.",
      ),
    description: textSchema
      .describe("What the runtime does. Plain string or a locale map.")
      .optional(),
    schedule: z
      .strictObject({
        stage: stageSchema
          .describe(
            "Stage the runtime runs in. Required for `auto` and `scheduled` triggers. Order: `setup`, `pre-turn`, `narrative`, `post-turn`, `audit`.",
          )
          .optional(),
        trigger: triggerConfigSchema
          .describe("When the runtime is activated.")
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
        completion: turnCompletionConfigSchema
          .describe("Whether the turn waits for this runtime.")
          .optional(),
        manual: z
          .strictObject({
            execution: z
              .enum(["sync", "background"])
              .describe(
                "`sync` awaits the result. `background` queues a durable job and returns its ID.",
              ),
          })
          .describe("Execution mode for `manual` and `event` activation.")
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
                "Producer of the value: a runtime in this package, a contract, or a kernel input.",
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
                  "`true` stops this runtime when the upstream value is missing or failed.",
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
                "Contract this runtime's output publishes. It must be listed in the package's `provides`.",
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
          .enum(["story", "plugin", "system"])
          .describe(
            "Output kind the kernel dispatches on: `story` for the main narrative provider, `plugin` for plugin output, `system` for system output.",
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
            description: "Model slot the agent uses.",
            examples: ["plugin"],
          })
          .optional(),
        llm: runtimeManifestInputSchema.shape.llm,
        history: runtimeManifestInputSchema.shape.history,
        tools: toolsConfigSchema
          .describe("Tools the agent's model may call.")
          .optional(),
        advertiseEvents: z
          .boolean()
          .describe(
            "`true` lists the session's event directory in the prompt so the model knows which topics it may emit.",
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
                "Time limit of the runtime in ms. The time a streamed model call spends writing does not count.",
              )
              .optional(),
            callTimeoutMs: z
              .number()
              .int()
              .positive()
              .describe(
                "Time limit of one model call that is not streamed, in ms.",
              )
              .optional(),
            firstTokenTimeoutMs: z
              .number()
              .int()
              .positive()
              .describe(
                "Time limit for the first streamed token in ms. Defaults to 120000.",
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
                "Retries on a transient model failure. Defaults to 1; `0` disables retry.",
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
            completion: z
              .strictObject({
                require: z
                  .enum(["explicit", "tool-use"])
                  .describe(
                    '`explicit` needs a completing tool or `runtime-done`. `tool-use` needs a valid business tool call, so "no change" is also submitted through the tool.',
                  )
                  .optional(),
                afterTools: z
                  .array(z.string())
                  .describe(
                    "The runtime completes after a successful call to one of these tools.",
                  )
                  .optional(),
              })
              .describe("How the agent loop ends.")
              .optional(),
          })
          .describe("Limits and completion rules of the agent loop.")
          .optional(),
      })
      .describe(
        "Settings of an `agent` runtime. Not allowed on a `function` runtime.",
      )
      .optional(),
    function: z
      .strictObject({
        handler: z
          .string()
          .min(1)
          .describe(
            "Path of the handler module. The module default-exports the handler function.",
          ),
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
        "Settings of a `function` runtime. Required when `type` is `function`.",
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
    if (value.type === "function" && (!value.function || value.agent))
      ctx.addIssue({
        code: "custom",
        path: ["function"],
        message:
          "Function runtime requires function.handler and cannot declare agent",
      });
    if (value.type === "agent" && value.function)
      ctx.addIssue({
        code: "custom",
        path: ["function"],
        message: "Agent runtime cannot declare function",
      });
    if (value.io?.concealed && value.io.visibility === "story")
      ctx.addIssue({
        code: "custom",
        path: ["io", "concealed"],
        message:
          "A runtime with io.visibility: story writes the text the player reads and cannot be io.concealed; conceal a plugin or system runtime instead",
      });
    for (const [name, binding] of Object.entries(value.io?.inputs ?? {})) {
      if (binding.scope === "committed" && binding.select !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["io", "inputs", name, "select"],
          message:
            "Committed input cannot declare select; scope: committed reads the complete export",
        });
      if (
        binding.scope === "committed" &&
        (!binding.recordAs || "kernel" in binding.from)
      )
        ctx.addIssue({
          code: "custom",
          path: ["io", "inputs", name],
          message: "Committed input requires a runtime source and recordAs",
        });
    }
  });
