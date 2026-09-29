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
    requested: stringArray(value.requested),
    recommended: stringArray(value.recommended),
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
  const worldPacks = Array.isArray(raw.packs)
    ? raw.packs
        .map(worldPack)
        .filter((pack): pack is PluginPack => Boolean(pack))
    : [];
  const worldPackIds = new Set(worldPacks.map((pack) => pack.id));
  return {
    policy: {
      ...(typeof raw.presetId === "string" ? { presetId: raw.presetId } : {}),
      preferredTags: stringArray(raw.preferredTags),
      avoidedTags: stringArray(raw.avoidedTags),
      requested: stringArray(raw.requested),
      recommended: stringArray(raw.recommended),
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
  const requested = new Set([
    ...policy.requested,
    ...(selectedPack?.requested ?? []),
  ]);
  for (const plugin of plugins) {
    if (
      plugin.hostState === "error" ||
      policy.avoidedTags.some((tag) => plugin.tags.includes(tag))
    )
      continue;
    if (policy.preferredTags.some((tag) => plugin.tags.includes(tag)))
      requested.add(plugin.id);
  }
  return [...requested];
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
  const plugins = [...c.get("pluginRegistry").getAll().values()].map((entry) =>
    buildPluginSummary(entry, c.get("isPluginEntryPublished")),
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
    defaultPluginIds: defaultPluginIds(plugins, policy, selectedPack),
  };
  return c.json(plan);
});
