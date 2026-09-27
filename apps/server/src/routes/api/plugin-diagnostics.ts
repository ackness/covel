import { Hono } from "hono";
import { z } from "zod";
import {
  pluginRuntimeManifests,
  type PluginRegistry,
} from "@covel/plugin-loader";
import {
  RpcValidationError,
  type HookPipeline,
  type PluginRpcRegistry,
  type PluginServiceCallEvent,
  type PluginServiceRegistry,
} from "@covel/runtime";
import {
  isDefaultLocale,
  type PluginDiagnostic,
  type PluginDiagnosticsSnapshot,
  type PluginServiceCallDiagnostic,
} from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import type { ToolRegistry } from "@covel/tools";
import { errorBody } from "../../api-error.js";
import { rateLimiter } from "../../middleware/rate-limit.js";
import {
  resolveSessionParam,
  sessionIncarnationIdentity,
} from "./session/session-guard.js";
import { mergePluginCommands } from "./session/commands.js";

const CALL_WINDOW = 100;
const TOTAL_CALL_LIMIT = 500;
const FIELD_LIMIT = 256;
const TRUNCATION_MARKER = "...[truncated]";

/** Bound retained public metadata, including malformed caller-supplied names. */
function boundedField(value: string): string {
  return value.length <= FIELD_LIMIT
    ? value
    : `${value.slice(0, FIELD_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** Bounded across all sessions; private incarnation tags never leave the host. */
export class RecentPluginServiceCalls {
  private readonly entries: Array<{
    sessionId: string;
    scope: string;
    value: PluginServiceCallDiagnostic;
  }> = [];

  record(event: PluginServiceCallEvent): void {
    if (!event.diagnosticScope) return;
    this.entries.push({
      sessionId: event.sessionId,
      scope: event.diagnosticScope,
      value: {
        callId: boundedField(event.callId),
        ...(event.parentCallId
          ? { parentCallId: boundedField(event.parentCallId) }
          : {}),
        ...(event.turnId ? { turnId: boundedField(event.turnId) } : {}),
        ...(event.runtimeId
          ? { runtimeId: boundedField(event.runtimeId) }
          : {}),
        callerPluginId: boundedField(event.callerPluginId),
        providerPluginId: boundedField(event.providerPluginId),
        name: boundedField(event.name),
        contract: boundedField(event.contract),
        durationMs: event.durationMs,
        completedAt: new Date().toISOString(),
        outcome: event.outcome,
        ...(event.errorCode
          ? { errorCode: boundedField(event.errorCode) }
          : {}),
      },
    });
    if (this.entries.length > TOTAL_CALL_LIMIT) this.entries.shift();
  }

  list(
    session: SessionRecord,
    pluginId?: string,
  ): PluginServiceCallDiagnostic[] {
    const scope = sessionIncarnationIdentity(session);
    return this.entries
      .filter(
        (entry) => entry.sessionId === session.id && entry.scope === scope,
      )
      .filter(
        ({ value }) =>
          !pluginId ||
          value.callerPluginId === pluginId ||
          value.providerPluginId === pluginId,
      )
      .slice(-CALL_WINDOW)
      .reverse()
      .map(({ value }) => ({ ...value }));
  }
}

interface PluginDiagnosticsDeps {
  readonly registry: PluginRegistry;
  readonly tools: ToolRegistry;
  readonly hooks: HookPipeline;
  readonly rpc: PluginRpcRegistry;
  readonly services: PluginServiceRegistry;
  readonly calls: RecentPluginServiceCalls;
  readonly hasPendingEntry: (pluginId: string) => boolean;
  readonly isServerCodeApproved: (
    session: SessionRecord,
    pluginId: string,
  ) => boolean;
}

const querySchema = z
  .object({
    pluginId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][\w.-]*$/)
      .optional(),
  })
  .strict();

/** Read registry snapshots only: inspecting a plugin must never activate it. */
export function createPluginDiagnostics(deps: PluginDiagnosticsDeps) {
  const snapshot = (
    session: SessionRecord,
    pluginId?: string,
  ): PluginDiagnosticsSnapshot => {
    const active = new Set(session.activePlugins);
    const hooks = deps.hooks.list();
    const actions = deps.rpc.list();
    const services = deps.services.list();
    const plugins = [...deps.registry.getAll().values()]
      .filter((entry) => !pluginId || entry.id === pluginId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((entry): PluginDiagnostic => {
        const source = entry.source ?? "community";
        const approved =
          source === "builtin" || deps.isServerCodeApproved(session, entry.id);
        const available =
          active.has(entry.id) &&
          approved &&
          entry.status !== "error" &&
          !entry.error;
        const ownActions = available
          ? actions
              .filter((action) => action.pluginId === entry.id)
              .map(({ action }) => action)
              .sort()
          : [];
        return {
          pluginId: entry.id,
          source,
          active: active.has(entry.id),
          state:
            entry.status === "error"
              ? "load-error"
              : !active.has(entry.id)
                ? "inactive"
                : !approved
                  ? "approval-required"
                  : entry.error
                    ? "activation-error"
                    : deps.hasPendingEntry(entry.id)
                      ? "entry-pending"
                      : "ready",
          runtimeIds: pluginRuntimeManifests(entry).map(
            ({ manifest }) => manifest.name,
          ),
          registrations: {
            tools: available
              ? [...(deps.tools.pluginTools.get(entry.id)?.keys() ?? [])].sort()
              : [],
            hooks: available
              ? hooks
                  .filter((hook) => hook.pluginId === entry.id)
                  .map(({ id, event }) => ({ id, event }))
              : [],
            actions: ownActions,
            services: available
              ? services
                  .filter((service) => service.pluginId === entry.id)
                  .map(({ name, contract }) => ({ name, contract }))
              : [],
          },
          commands:
            entry.status === "error"
              ? []
              : mergePluginCommands(entry).map(({ name, action }) => ({
                  name,
                  action,
                  registered: ownActions.includes(action),
                })),
        };
      });
    return {
      sessionId: session.id,
      capturedAt: new Date().toISOString(),
      plugins,
      calls: deps.calls.list(session, pluginId),
      history: { scope: "process", limit: CALL_WINDOW },
    };
  };

  deps.rpc.registerFrameworkDefault(
    "slash-plugins",
    async (_payload, context) => {
      if (context.command?.commandId !== "framework:plugins")
        throw new RpcValidationError(
          "Use the /plugins command to open plugin diagnostics",
        );
      const pluginId = context.command.args.pluginId;
      if (
        pluginId !== undefined &&
        (typeof pluginId !== "string" || !deps.registry.get(pluginId))
      )
        throw new RpcValidationError("Unknown plugin");
      return {
        ok: true,
        message: isDefaultLocale(context.locale)
          ? "打开插件注册与服务调用诊断。"
          : "Open plugin registrations and service call diagnostics.",
        clientAction: {
          type: "open-plugin-diagnostics",
          ...(pluginId ? { pluginId } : {}),
        },
      };
    },
    {
      description:
        "Inspect plugin registrations without activating plugin code",
    },
  );

  const routes = new Hono();
  routes.get(
    "/:id/plugin-diagnostics",
    rateLimiter({ max: 120 }),
    async (c) => {
      const guard = await resolveSessionParam(c);
      if (!guard.ok) return guard.response;
      // The shared owner guard also accepts credentials in the query string.
      const { session_token: _sessionToken, ...query } = c.req.query();
      const parsed = querySchema.safeParse(query);
      if (!parsed.success)
        return c.json(errorBody("Invalid plugin diagnostics query"), 400);
      const { pluginId } = parsed.data;
      if (pluginId && !deps.registry.get(pluginId))
        return c.json(errorBody("Unknown plugin"), 404);
      c.header("Cache-Control", "no-store");
      return c.json(snapshot(guard.session, pluginId));
    },
  );
  return { routes, snapshot };
}
