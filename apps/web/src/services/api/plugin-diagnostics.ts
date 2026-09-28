import type { PluginDiagnosticsSnapshot } from "@covel/shared";
import { z } from "zod";
import { request } from "./request.js";

const snapshotSchema = z.object({
  sessionId: z.string(),
  capturedAt: z.string(),
  plugins: z.array(
    z.object({
      pluginId: z.string(),
      source: z.enum(["builtin", "community"]),
      hostState: z.enum(["discovered", "installed", "loaded", "error"]),
      sessionState: z.enum([
        "active",
        "inactive",
        "approval-required",
        "rejected",
      ]),
      serverCodeApproved: z.boolean(),
      autoAdded: z.boolean().optional(),
      approvalRequired: z.boolean().optional(),
      error: z.string().optional(),
      registrationError: z
        .object({
          code: z.literal("plugin_registration_invalid"),
          registration: z.string(),
        })
        .optional(),
      rejection: z
        .object({
          pluginId: z.string(),
          code: z.enum([
            "invalid-conflict",
            "unknown-plugin",
            "approval-required",
            "excluded",
            "missing-provider",
            "ambiguous-provider",
            "conflict",
            "single-provider-conflict",
            "default-replaced",
          ]),
          reason: z.string(),
          candidates: z.array(z.string()).optional(),
          path: z.array(z.union([z.string(), z.number()])).optional(),
        })
        .optional(),
      active: z.boolean(),
      runtimeIds: z.array(z.string()),
      registrations: z.object({
        extensions: z
          .array(
            z.object({
              point: z.string(),
              id: z.string(),
              slot: z.string().optional(),
              order: z.number().optional(),
            }),
          )
          .optional(),
        tools: z.array(z.string()),
        hooks: z.array(z.object({ id: z.string(), event: z.string() })),
        actions: z.array(z.string()),
        services: z.array(z.object({ name: z.string(), contract: z.string() })),
      }),
      commands: z.array(
        z.object({
          name: z.string(),
          action: z.string(),
          registered: z.boolean(),
        }),
      ),
    }),
  ),
  calls: z.array(
    z.object({
      extension: z
        .object({
          point: z.string(),
          id: z.string(),
          slot: z.string().optional(),
        })
        .optional(),
      callId: z.string(),
      parentCallId: z.string().optional(),
      turnId: z.string().optional(),
      runtimeId: z.string().optional(),
      callerPluginId: z.string(),
      providerPluginId: z.string(),
      name: z.string(),
      contract: z.string(),
      completedAt: z.string(),
      durationMs: z.number(),
      outcome: z.enum(["success", "timeout", "cancelled", "error"]),
      errorCode: z.string().optional(),
    }),
  ),
  extensionCalls: z.array(
    z.object({
      point: z.string(),
      providerPluginId: z.string(),
      total: z.number().int().nonnegative(),
      success: z.number().int().nonnegative(),
      error: z.number().int().nonnegative(),
      timeout: z.number().int().nonnegative(),
      cancelled: z.number().int().nonnegative(),
    }),
  ),
  history: z.object({ scope: z.literal("process"), limit: z.number() }),
}) satisfies z.ZodType<PluginDiagnosticsSnapshot>;

export function getPluginDiagnostics(
  sessionId: string,
  pluginId?: string,
  signal?: AbortSignal,
): Promise<PluginDiagnosticsSnapshot> {
  const query = pluginId ? `?pluginId=${encodeURIComponent(pluginId)}` : "";
  return request<PluginDiagnosticsSnapshot>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugin-diagnostics${query}`,
    { schema: snapshotSchema, signal, silentErrors: true, retry: false },
  );
}
