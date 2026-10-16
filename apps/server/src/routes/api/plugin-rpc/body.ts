import type { PluginRpcRequest } from "@covel/shared";
import { z } from "zod";

export type PluginRpcBodyValidation =
  | { readonly ok: true; readonly body: PluginRpcRequest }
  | {
      readonly ok: false;
      readonly error: string;
      readonly status: 400;
    };

const selector = z
  .string({ error: "must be a string" })
  .min(1, "must be a non-empty string");
const jsonObject = z.record(z.string(), z.unknown(), {
  error: "must be a JSON object",
});

const pluginRpcBodySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("action"),
    pluginId: selector,
    action: selector,
    payload: z.unknown().optional(),
  }),
  z.strictObject({
    kind: z.literal("runtime"),
    pluginId: selector,
    runtimeId: selector,
    payload: z.unknown().optional(),
    expectsBackgroundFollower: z.boolean().optional(),
    retryFromTurnId: selector.optional(),
  }),
  z
    .strictObject({
      kind: z.literal("command"),
      commandId: selector,
      input: selector.max(10_000).optional(),
      args: jsonObject
        .refine(
          (args) => JSON.stringify(args).length <= 10_000,
          "must be at most 10000 JSON characters",
        )
        .optional(),
    })
    .refine(
      (body) => (body.input !== undefined) !== (body.args !== undefined),
      "command dispatch requires exactly one of input or args",
    ),
  z.strictObject({
    kind: z.literal("event"),
    pluginId: selector,
    topic: selector.max(128),
    payload: jsonObject.optional(),
  }),
]);

export function validatePluginRpcBody(raw: unknown): PluginRpcBodyValidation {
  const parsed = pluginRpcBodySchema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .map((issue) => {
        if (issue.code === "unrecognized_keys")
          return `Unknown field(s): ${issue.keys.join(", ")}`;
        if (issue.code === "invalid_union")
          return "kind must be one of action, runtime, command, or event";
        if (issue.code === "invalid_type" && issue.path.length === 0)
          return "body must be a JSON object";
        return issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message;
      })
      .join("; ");
    return { ok: false, error, status: 400 };
  }
  const body = parsed.data;
  if (body.kind === "command") {
    const { kind, commandId, input, args } = body;
    if (input !== undefined)
      return { ok: true, body: { kind, commandId, input } };
    // The schema's XOR refinement requires args when input is absent.
    return { ok: true, body: { kind, commandId, args: args! } };
  }
  return { ok: true, body };
}
