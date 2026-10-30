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

function isZodLike(input: unknown): input is z.ZodType {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { safeParse?: unknown }).safeParse === "function" &&
    typeof (input as { toJSONSchema?: unknown }).toJSONSchema === "function"
  );
}

/**
 * The tool of a resolved import. A Zod input gets the usual argument checks
 * (named fields, JSON-text repair); an explicit `inputSchema` leaves the
 * checking to the provider, whose rejection answers `invalid-input`.
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
  if (isZodLike(target.input))
    return {
      ...tool({
        name,
        description: target.description,
        parameters: target.input,
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
