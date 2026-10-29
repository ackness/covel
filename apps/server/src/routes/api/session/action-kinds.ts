/**
 * The session's action-kind catalogue:
 *
 *   GET /api/sessions/:id/action-kinds
 *
 * The base kinds plus the `contributes.actionKinds` of the session's runnable
 * plugins, and the kinds each seat may submit now. `submit_actions` checks
 * every action against this same catalogue, so the composer offers exactly
 * what the server accepts.
 */

import type { Hono } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import {
  BASE_ACTION_KINDS,
  BASE_ACTION_KIND_RULES,
  baseActionKindRoles,
  type ActionKindDescriptor,
  type BaseActionKind,
  type I18nText,
  type Seat,
  type SessionActionKindsResponse,
} from "@covel/shared";
import { rateLimiter } from "../../../middleware/rate-limit.js";
import { runnablePluginIds } from "./plugins.js";
import type { SessionRouteEnv } from "./route-env.js";
import { resolveSessionParam } from "./session-guard.js";

const BASE_KIND_LABELS: Readonly<Record<BaseActionKind, I18nText>> = {
  say: { zh: "说", en: "Say" },
  act: { zh: "行动", en: "Act" },
  narrate: { zh: "旁白", en: "Narrate" },
  direct: { zh: "导演指示", en: "Direct" },
  advance: { zh: "推进", en: "Advance" },
  command: { zh: "命令", en: "Command" },
};

const BASE_ACTION_KIND_DESCRIPTORS: readonly ActionKindDescriptor[] =
  BASE_ACTION_KINDS.map((kind) => ({
    kind,
    source: "framework" as const,
    roles: baseActionKindRoles(kind),
    ...BASE_ACTION_KIND_RULES[kind],
    display: { label: BASE_KIND_LABELS[kind] },
  }));

/**
 * The kinds a session accepts: the base kinds, then each runnable plugin's
 * declared kinds in plugin order.
 */
export function resolveSessionActionKinds(
  activePlugins: readonly string[] | undefined,
  registry: Pick<PluginRegistry, "getAll" | "get">,
): ActionKindDescriptor[] {
  const kinds = [...BASE_ACTION_KIND_DESCRIPTORS];
  for (const pluginId of runnablePluginIds(activePlugins ?? [], registry)) {
    const entry = registry.get(pluginId);
    if (!entry || entry.status === "error") continue;
    kinds.push(...(entry.packageManifest?.actionKinds ?? []));
  }
  return kinds;
}

/** The kinds `seat` may submit: none without a human controller. */
export function allowedActionKinds(
  seat: Seat,
  kinds: readonly ActionKindDescriptor[],
): string[] {
  if (seat.controller !== "human") return [];
  return kinds
    .filter((kind) => kind.roles.includes(seat.role))
    .map((kind) => kind.kind);
}

export function registerSessionActionKindRoutes(
  routes: Hono<SessionRouteEnv>,
): void {
  routes.get("/:id/action-kinds", rateLimiter({ max: 120 }), async (c) => {
    const guard = await resolveSessionParam(c);
    if (!guard.ok) return guard.response;
    const session = guard.session;
    const kinds = resolveSessionActionKinds(
      session.activePlugins,
      c.get("pluginRegistry"),
    );
    const body: SessionActionKindsResponse = {
      kinds,
      seats: session.seats.map((seat) => ({
        seatId: seat.id,
        role: seat.role,
        controller: seat.controller,
        allowed: allowedActionKinds(seat, kinds),
      })),
    };
    return c.json(body);
  });
}
