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
      state: z.enum([
        "ready",
        "inactive",
        "approval-required",
        "entry-pending",
        "activation-error",
        "load-error",
      ]),
      active: z.boolean(),
      runtimeIds: z.array(z.string()),
      registrations: z.object({
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
