import type { Hono, Context } from "hono";
import {
  TURN_POLICY_CONTRACT,
  normalizeOrchestrationSettings,
  orchestrationSettingsPatchSchema,
  orchestrationSettingsSchema,
  resolveI18nText,
  serviceContributionContract,
  type OrchestrationResponse,
} from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import { errorBody, readJsonBody } from "../../api-error.js";
import { resolveSessionParam } from "./session/session-guard.js";
import { withLockedSessionMutation } from "./session/locked-mutation.js";
import {
  authorizedSessionPluginIds,
  runnablePluginIds,
} from "./session/plugins.js";
import type { SessionRouteEnv } from "./session/route-env.js";

function view(c: Context, session: SessionRecord): OrchestrationResponse {
  const registry = c.get("pluginRegistry");
  const admitted = new Set(
    authorizedSessionPluginIds(registry, c.get("rpcApprovalGate"), session),
  );
  const active = new Set(runnablePluginIds(session.activePlugins, registry));
  const settings = normalizeOrchestrationSettings(
    session.metadata?.orchestration,
  );
  const policies: OrchestrationResponse["policies"] = [];
  for (const entry of registry.getAll().values()) {
    if (!admitted.has(entry.id) || !active.has(entry.id)) continue;
    if (
      !entry.packageManifest?.plugin.contributes?.services?.some(
        (declaration) =>
          serviceContributionContract(declaration) === TURN_POLICY_CONTRACT,
      )
    )
      continue;
    // Registration metadata is already loaded by the approved entry lifecycle.
    // Enumeration must not execute an entry or a service to discover its name.
    for (const service of c.get("pluginServices")?.list() ?? []) {
      if (
        service.pluginId !== entry.id ||
        service.contract !== TURN_POLICY_CONTRACT
      )
        continue;
      const name = service.name;
      policies.push({
        pluginId: entry.id,
        name,
        label: `${resolveI18nText(entry.summary.displayName, session.locale) ?? entry.summary.name} / ${service.description ?? name}`,
        status: c.get("pluginFaults")?.isLatched(session.id, entry.id)
          ? "paused"
          : "available",
      });
    }
  }
  const selected =
    settings.turnPolicy &&
    policies.find(
      (policy) =>
        policy.pluginId === settings.turnPolicy?.pluginId &&
        policy.name === settings.turnPolicy.name,
    );
  const status = settings.turnPolicy
    ? selected?.status === "available"
      ? "selected"
      : selected?.status === "paused"
        ? "paused"
        : "missing"
    : policies.length > 1
      ? "ambiguous"
      : policies[0]?.status === "paused"
        ? "paused"
        : policies.length === 1
          ? "unique"
          : "missing";
  if (settings.turnPolicy && !selected)
    policies.push({
      ...settings.turnPolicy,
      label: settings.turnPolicy.name,
      status: "unavailable",
    });
  return { settings, policies, status };
}

export function registerOrchestrationRoutes(
  routes: Hono<SessionRouteEnv>,
): void {
  routes.get("/:id/orchestration", async (c) => {
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    return c.json(view(c, guard.session));
  });
  routes.patch("/:id/orchestration", async (c) => {
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const parsed = await readJsonBody<unknown>(c);
    if (parsed instanceof Response) return parsed;
    const patch = orchestrationSettingsPatchSchema.safeParse(parsed.body);
    if (!patch.success)
      return c.json(
        errorBody("Invalid orchestration settings", { code: "invalid_body" }),
        400,
      );
    const store = c.get("store");
    return withLockedSessionMutation({
      c,
      store,
      sessionLock: c.get("sessionLock"),
      sessionId: guard.session.id,
      expectedSession: guard.session,
      allowedStatuses: ["active", "paused"],
      mutate: async (session) => {
        const current = orchestrationSettingsSchema.parse(
          session.metadata?.orchestration ?? {},
        );
        const selection = patch.data.turnPolicy;
        if (
          selection &&
          !(
            current.turnPolicy?.pluginId === selection.pluginId &&
            current.turnPolicy.name === selection.name
          ) &&
          !view(c, session).policies.some(
            (policy) =>
              policy.pluginId === selection.pluginId &&
              policy.name === selection.name &&
              policy.status !== "unavailable",
          )
        )
          return c.json(
            errorBody("Unknown policy provider", { code: "invalid_body" }),
            400,
          );
        const orchestration = { ...current, ...patch.data };
        if (orchestration.turnPolicy === null) delete orchestration.turnPolicy;
        const metadata = { ...session.metadata, orchestration };
        await store.updateSession(session.id, {
          metadata,
          updatedAt: new Date().toISOString(),
        });
        return c.json(view(c, { ...session, metadata }));
      },
    });
  });
}
