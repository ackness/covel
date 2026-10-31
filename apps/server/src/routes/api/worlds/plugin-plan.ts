import { DEFAULT_LOCALE } from "@covel/shared";
import {
  inventoryWorldData,
  worldDataRequirementNotices,
  type WorldDataRequirements,
} from "../../../world-data/requirements.js";
import { resolveSessionPlugins } from "@covel/shared";
import { sessionContentLocale } from "@covel/shared";
import { Hono } from "hono";
import {
  WORLD_LOCALIZED_TEXT_KEY,
  localizedWorldText,
  pluginPitchSchema,
  resolveWorldPluginSelection,
  type PluginSummary,
  type WorldPluginPlan,
  type World,
} from "@covel/shared";
import { errorBody } from "../../../api-error.js";
import { BUILTIN_PLUGIN_PACKS } from "../../../config/plugin-packs.js";
import { buildPluginSummary } from "../../../lib/plugin-descriptor.js";
import type { WorldEnv } from "./shared.js";
import { isRecord } from "../../../lib/is-record.js";

/** Public presentation only: lore, imported records and hidden data never enter. */
export function worldPluginPlan(
  world: Pick<
    World,
    "id" | "name" | "description" | "tags" | "metadata" | "locale"
  >,
  plugins: readonly PluginSummary[],
  inventory?: WorldDataRequirements,
): WorldPluginPlan {
  const resolved = resolveWorldPluginSelection(
    world.metadata?.plugins,
    BUILTIN_PLUGIN_PACKS,
  );
  const installed = new Set(plugins.map((plugin) => plugin.id));
  const diagnostics = [...resolved.diagnostics];
  const pitch = pluginPitchSchema.safeParse(world.metadata?.pluginPitch).data;
  const localized = world.metadata?.[WORLD_LOCALIZED_TEXT_KEY];
  const texts = isRecord(localized) ? localized : {};
  const publicText = (field: "name" | "description") => {
    const translations = texts[field];
    if (!isRecord(translations)) return world[field];
    // Resolve only existing edition keys; an edited default edition takes
    // precedence over the package's earlier stored copy.
    return Object.fromEntries(
      Object.keys(translations).map((locale) => [
        locale,
        localizedWorldText(world, locale)[field] ?? "",
      ]),
    );
  };
  const keep = (ids: readonly string[], path: string, packId?: string) =>
    ids.filter((pluginId) => {
      if (installed.has(pluginId)) return true;
      if (diagnostics.length < 256)
        diagnostics.push({
          code: "missing-plugin",
          path,
          pluginId,
          ...(packId ? { packId } : {}),
        });
      return false;
    });
  const requestedPluginIds = resolved.selection.requestedPluginIds.filter(
    (id) => {
      const request = resolved.requests.find(
        (ref) => ref.pluginId === id && !ref.packId,
      );
      return keep([id], request?.path ?? "plugins").length > 0;
    },
  );
  const packs = resolved.packs.map((pack) => {
    const reference = Array.isArray(world.metadata?.plugins)
      ? world.metadata.plugins.indexOf(`pack:${pack.id}`)
      : -1;
    return {
      ...pack,
      requested: keep(
        pack.requested,
        reference >= 0 ? `plugins[${reference}]` : "packs",
        pack.id,
      ),
      ...(pack.excluded
        ? { excluded: pack.excluded.filter((id) => installed.has(id)) }
        : {}),
      ...(pack.id === resolved.selectedPackId
        ? {
            label: pitch?.label ?? publicText("name"),
            description: pitch?.description ?? publicText("description"),
            reason: pitch?.reason,
            tags: world.tags ?? [],
            source: "world" as const,
          }
        : {}),
    };
  });
  const selected = packs.find((pack) => pack.id === resolved.selectedPackId);
  const plan: WorldPluginPlan = {
    worldId: world.id,
    selection: {
      requestedPluginIds,
      requiredContracts: [
        ...new Set([
          ...resolved.selection.requiredContracts,
          ...(inventory?.requiredContracts ?? []),
        ]),
      ],
      requiredDataContracts: inventory?.requiredDataContracts ?? [],
    },
    packs,
    ...(selected ? { selectedPackId: selected.id } : {}),
    defaultPluginIds: [
      ...new Set(
        resolved.requests
          .filter((ref) => installed.has(ref.pluginId))
          .map((ref) => ref.pluginId),
      ),
    ],
    diagnostics,
  };
  const resolution = resolveSessionPlugins({
    requested: plan.defaultPluginIds,
    requiredContracts: plan.selection.requiredContracts,
    requiredDataContracts: plan.selection.requiredDataContracts,
    excluded: selected?.excluded,
    plugins: plugins
      .filter((p) => p.hostState !== "error")
      .map((p) => ({
        ...p,
        authorized:
          p.source === "builtin" ||
          p.executionMode === "declarative" ||
          p.trust?.autoApproved === true,
      })),
  });
  return {
    ...plan,
    dataNotices: inventory
      ? worldDataRequirementNotices(inventory, resolution.unmetData)
      : [],
  };
}

export const worldPluginPlanRoutes = new Hono<WorldEnv>();
worldPluginPlanRoutes.get("/:id/plugin-plan", async (c) => {
  const world = await c.get("store").getWorld(c.req.param("id"));
  if (!world)
    return c.json(
      errorBody("World not found", { code: "world_not_found" }),
      404,
    );
  const plugins = [...c.get("pluginRegistry").getAll().values()].map((entry) =>
    buildPluginSummary(
      entry,
      c.get("isPluginEntryPublished"),
      c.get("trustedSources"),
    ),
  );
  const inventory = await inventoryWorldData({
    world,
    worldId: world.id,
    worldsDirs: c.get("worldsDirs"),
    covelHome: c.get("covelHome"),
    registry: c.get("pluginRegistry"),
    locale: sessionContentLocale(world, world.locale ?? DEFAULT_LOCALE).locale,
  });
  return c.json(worldPluginPlan(world, plugins, inventory));
});
