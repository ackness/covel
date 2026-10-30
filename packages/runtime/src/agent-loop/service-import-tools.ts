/**
 * Imported services as agent tools: the tool an agent's
 * `agent.tools.services` import becomes when its provider resolves, and the
 * stand-in that answers a call to one that did not.
 */

import { ToolError } from "@covel/shared";
import { tool, z, type ToolModule } from "@covel/tools";
import {
  tagServiceFailure,
  type ServiceImportResolution,
} from "../plugin-services.js";

/** How long an imported tool waits for its provider. */
export const SERVICE_IMPORT_TIMEOUT_MS = 15_000;

/** Read services are side-effect free: safe to repeat and to run together. */
const IMPORTED_TOOL_ANNOTATIONS = Object.freeze({
  readOnly: true,
  stagesWrites: false,
  idempotent: true,
  concurrencySafe: true,
});

type Ready = Extract<ServiceImportResolution, { status: "ready" }>;
export type AbsentImport = Exclude<
  ServiceImportResolution,
  { status: "ready" }
>;

/** Model-facing text: tool and contract only, never a plugin ID. */
export function absentImportMessage(
  name: string,
  contract: string,
  reason: AbsentImport["status"],
): string {
  const why = {
    missing: `no active provider offers ${contract}`,
    ambiguous: "more than one plugin provides it",
    paused: "its provider is paused after repeated errors",
    "not-model-facing": "its provider does not offer it to models",
  }[reason];
  return `The tool "${name}" is unavailable in this session: ${why}.`;
}

type SafeParser = {
  safeParse(value: unknown):
    | { success: true }
    | {
        success: false;
        error: { issues: readonly Record<string, unknown>[] };
      };
};

function hasSafeParse(input: unknown): input is SafeParser {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { safeParse?: unknown }).safeParse === "function"
  );
}

/**
 * Checks arguments against the provider's input without keeping its parsed
 * output: the value passes through unchanged and each problem is reported as
 * the provider's own issue. `tool()` can then name the bad fields and repair
 * JSON-text arguments, while only the registry's parse produces what the
 * handler receives, so a transform is never applied to its own output. The
 * provider's input is not exported to JSON Schema again either: the import
 * carries the schema fixed at registration, which may be an explicit one
 * for an input Zod cannot export.
 */
function argumentCheck(input: SafeParser): z.ZodType {
  return z.any().superRefine((value, ctx) => {
    const result = input.safeParse(value);
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({ ...issue } as Parameters<typeof ctx.addIssue>[0]);
  });
}

/**
 * The tool of a resolved import. A Zod input gets the usual argument checks
 * (named fields, JSON-text repair); an input without `safeParse` leaves the
 * checking to the provider, whose rejection answers `invalid-input`. Either
 * way the provider receives the arguments the model sent, or their repair.
 */
export function importedServiceTool(name: string, target: Ready): ToolModule {
  const execute = async (
    args: unknown,
    context: Parameters<ToolModule["execute"]>[1],
  ): Promise<unknown> => {
    if (!context.services)
      throw tagServiceFailure(
        new ToolError(
          "unavailable",
          absentImportMessage(name, target.contract, "missing"),
        ),
        {
          callerPluginId: context.pluginId,
          providerPluginId: target.pluginId,
          errorCode: "unavailable",
        },
      );
    return context.services.call(
      {
        pluginId: target.pluginId,
        name: target.name,
        contract: target.contract,
        input: args,
      },
      { timeoutMs: SERVICE_IMPORT_TIMEOUT_MS },
    );
  };
  if (hasSafeParse(target.input))
    return {
      ...tool({
        name,
        description: target.description,
        parameters: argumentCheck(target.input),
        annotations: IMPORTED_TOOL_ANNOTATIONS,
        execute,
      }),
      jsonSchema: target.jsonSchema,
    };
  return {
    _type: "covel-tool",
    name,
    description: target.description,
    parametersSchema: z.unknown(),
    jsonSchema: target.jsonSchema,
    annotations: IMPORTED_TOOL_ANNOTATIONS,
    execute,
  };
}

/**
 * Answers a call to an import that did not resolve: not advertised, but
 * still authorized, so a resumed transcript or a guessed call gets an
 * answer it can act on. Tagged like a provider failure: the call is refused,
 * not counted against the caller.
 */
export function absentImportTool(
  name: string,
  contract: string,
  absent: AbsentImport,
): ToolModule {
  const message = absentImportMessage(name, contract, absent.status);
  return {
    _type: "covel-tool",
    name,
    description: message,
    parametersSchema: z.unknown(),
    jsonSchema: { type: "object" },
    annotations: IMPORTED_TOOL_ANNOTATIONS,
    async execute(_args, context) {
      throw tagServiceFailure(
        new ToolError("unavailable", message, {
          hint: "Continue without this tool.",
        }),
        {
          callerPluginId: context.pluginId,
          providerPluginId:
            absent.status === "paused" ? absent.pluginId : "<unavailable>",
          errorCode: "unavailable",
        },
      );
    },
  };
}
