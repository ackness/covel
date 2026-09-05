import { Hono } from "hono";
import type {
  PluginPack,
  PluginSummary,
  ResolvedWorldPluginPolicy,
  WorldPluginPlan,
} from "@covel/shared";
import { errorBody } from "../../../api-error.js";
import { BUILTIN_PLUGIN_PACKS } from "../../../config/plugin-packs.js";
import { buildPluginSummary } from "../../../lib/plugin-descriptor.js";
import { resolveSessionPlugins } from "../session/plugins.js";
import { isRecord, type WorldEnv } from "./shared.js";

export const worldPluginPlanRoutes = new Hono<WorldEnv>();

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
    : [];
}

function i18nText(
  value: unknown,
): string | Readonly<Record<string, string>> | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function worldPack(value: unknown): PluginPack | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id) {
    return undefined;
  }
  const label = i18nText(value.label) ?? value.id;
  const description = i18nText(value.description);
  const reason = i18nText(value.reason);
  return {
    id: value.id,
    label,
    ...(description ? { description } : {}),
    pluginIds: stringArray(value.plugins ?? value.pluginIds),
    optionalPluginIds: stringArray(
      value.optionalPlugins ?? value.optionalPluginIds,
    ),
    excludedPluginIds: stringArray(
      value.excludedPlugins ?? value.excludedPluginIds,
    ),
    tags: stringArray(value.tags),
    ...(reason ? { reason } : {}),
    source: "world",
  };
}

function resolvePolicy(
  metadata: Readonly<Record<string, unknown>> | undefined,
): {
  policy: ResolvedWorldPluginPolicy;
  packs: PluginPack[];
} {
  const raw = isRecord(metadata?.pluginPolicy) ? metadata.pluginPolicy : {};
  const selectionIds = (
    key: "requiredPlugins" | "recommendedPlugins" | "excludedPlugins",
  ): string[] => [
    ...new Set([...stringArray(metadata?.[key]), ...stringArray(raw[key])]),
  ];
  const worldPacks = Array.isArray(raw.packs)
    ? raw.packs
        .map(worldPack)
        .filter((pack): pack is PluginPack => Boolean(pack))
    : [];
  const worldPackIds = new Set(worldPacks.map((pack) => pack.id));
  return {
    policy: {
      ...(typeof raw.preset === "string" ? { presetId: raw.preset } : {}),
      preferredTags: stringArray(raw.preferTags),
      avoidedTags: stringArray(raw.avoidTags),
      requiredCapabilities: stringArray(raw.requireCapabilities),
      requiredPluginIds: selectionIds("requiredPlugins"),
      recommendedPluginIds: selectionIds("recommendedPlugins"),
      excludedPluginIds: selectionIds("excludedPlugins"),
    },
    packs: [
      ...worldPacks,
      ...BUILTIN_PLUGIN_PACKS.filter((pack) => !worldPackIds.has(pack.id)),
    ],
  };
}

function defaultPluginIds(
  plugins: readonly PluginSummary[],
  policy: ResolvedWorldPluginPolicy,
  selectedPack: PluginPack | undefined,
): string[] {
  const required = new Set(policy.requiredPluginIds);
  const recommended = new Set(policy.recommendedPluginIds);
  const excluded = new Set(policy.excludedPluginIds);
  for (const id of selectedPack?.pluginIds ?? []) required.add(id);
  for (const id of selectedPack?.optionalPluginIds ?? []) recommended.add(id);
  for (const id of selectedPack?.excludedPluginIds ?? []) excluded.add(id);

  for (const plugin of plugins) {
    if (policy.preferredTags.some((tag) => plugin.tags.includes(tag))) {
      recommended.add(plugin.id);
    }
    if (policy.avoidedTags.some((tag) => plugin.tags.includes(tag))) {
      excluded.add(plugin.id);
    }
    if (
      policy.requiredCapabilities.some((capability) =>
        plugin.capabilities.includes(capability),
      )
    ) {
      recommended.add(plugin.id);
    }
  }

  const hasPolicy =
    required.size > 0 ||
    recommended.size > 0 ||
    excluded.size > 0 ||
    policy.preferredTags.length > 0 ||
    policy.avoidedTags.length > 0 ||
    policy.requiredCapabilities.length > 0 ||
    selectedPack !== undefined;

  return plugins
    .filter((plugin) => plugin.status !== "error")
    .filter((plugin) => {
      const locked =
        plugin.pluginType === "core-plugin" && plugin.source === "builtin";
      if (required.has(plugin.id)) return true;
      if (excluded.has(plugin.id)) return false;
      if (locked) return true;
      return hasPolicy ? recommended.has(plugin.id) : true;
    })
    .map((plugin) => plugin.id);
}

worldPluginPlanRoutes.get("/:id/plugin-plan", async (c) => {
  const worldId = c.req.param("id");
  const world = await c.get("store").getWorld(worldId);
  if (!world) {
    return c.json(
      errorBody("World not found", { code: "world_not_found" }),
      404,
    );
  }
  const plugins = [...c.get("pluginRegistry").getAll().values()].map(
    buildPluginSummary,
  );
  const { policy, packs } = resolvePolicy(world.metadata);
  const selectedPack = policy.presetId
    ? packs.find((pack) => pack.id === policy.presetId)
    : undefined;
  const plan: WorldPluginPlan = {
    worldId,
    packs,
    policy,
    ...(selectedPack ? { selectedPackId: selectedPack.id } : {}),
    defaultPluginIds: resolveSessionPlugins(
      defaultPluginIds(plugins, policy, selectedPack),
      c.get("pluginRegistry"),
    ),
  };
  return c.json(plan);
});
