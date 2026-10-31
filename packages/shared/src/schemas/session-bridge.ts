import { z } from "zod";

/** Additional browser grants; bridge: session itself requests the read grant. */
export const sessionBridgeCapabilitySchema = z.enum([
  "submitAction",
  "submitInteraction",
  "invokeRuntime",
  "abortExecution",
  "openPanel",
]);
export type SessionBridgeCapability = z.infer<
  typeof sessionBridgeCapabilitySchema
>;
export type SessionBridgeGrant = "session" | SessionBridgeCapability;
export const SESSION_BRIDGE_MAX_REQUEST_BYTES = 128 * 1024;
export const SESSION_BRIDGE_REQUEST_BUDGET = 4096;

const json: z.ZodType<import("../types/runtime-scheduling.js").JsonValue> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(json),
      z.record(z.string(), json),
    ]),
  );
const values = z.record(z.string().min(1).max(128), json);
export const sessionBridgeRequests = {
  submitAction: z.strictObject({
    kind: z.string().min(1).max(160),
    text: z.string().max(32000).optional(),
    fields: values.optional(),
    seatId: z.string().min(1).max(128).optional(),
  }),
  submitInteraction: z.strictObject({
    handle: z.string().min(1).max(128),
    values,
  }),
  invokeRuntime: z.strictObject({
    runtimeId: z.string().min(1).max(160),
    payload: json.optional(),
  }),
  abortExecution: z.strictObject({}),
  openPanel: z.strictObject({ panelId: z.string().min(1).max(128) }),
} as const;

/** No arbitrary response strings or execution data can cross this boundary. */
export const sessionBridgeOutcomeSchema = z.strictObject({
  status: z.enum(["accepted", "committed", "rejected", "unavailable"]),
  code: z
    .enum([
      "invalid-request",
      "permission-denied",
      "busy",
      "stale",
      "already-answered",
      "field-invalid",
      "runtime-refused",
      "failed",
    ])
    .optional(),
  issues: z
    .array(
      z.strictObject({
        field: z.string().max(128).optional(),
        code: z.literal("invalid"),
      }),
    )
    .max(32)
    .optional(),
});
export type SessionBridgeOutcome = z.infer<typeof sessionBridgeOutcomeSchema>;
