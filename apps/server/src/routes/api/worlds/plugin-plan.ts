import { Hono } from "hono";
import type {
  MissingWorldPlugin,
  PluginPack,
  PluginSummary,
  ResolvedWorldPluginPolicy,
  WorldPluginPlan,
} from "@covel/shared";
import { errorBody } from "../../../api-error.js";
import { BUILTIN_PLUGIN_PACKS } from "../../../config/plugin-packs.js";
import { buildPluginSummary } from "../../../lib/plugin-descriptor.js";
import type { WorldEnv } from "./shared.js";
import { isRecord } from "../../../lib/is-record.js";

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

/** The preset pack as the world presents it: its `pitch` in place of the pack's text. */
function pitched(pack: PluginPack, pitch: unknown): PluginPack {
  if (!isRecord(pitch)) return pack;
  const label = i18nText(pitch.label);
  const description = i18nText(pitch.description);
  const reason = i18nText(pitch.reason);
  return {
    ...pack,
    ...(label ? { label } : {}),
    ...(description ? { description } : {}),
    ...(reason ? { reason } : {}),
    source: "world",
  };
}

/**
 * The world's policy and the packs its session preparation screen offers: the
 * built-in packs `packs` names, in that order, or every built-in pack. The
 * preset comes first, with the world's `pitch`.
 */
function resolvePolicy(
  metadata: Readonly<Record<string, unknown>> | undefined,
): {
  policy: ResolvedWorldPluginPolicy;
  packs: PluginPack[];
} {
  const raw = isRecord(metadata?.pluginPolicy) ? metadata.pluginPolicy : {};
  const preset =
    typeof raw.preset === "string" &&
    BUILTIN_PLUGIN_PACKS.some((pack) => pack.id === raw.preset)
      ? raw.preset
      : undefined;
  const named = stringArray(raw.packs);
  const offered =
    named.length > 0
      ? named.flatMap((id) => {
          const pack = BUILTIN_PLUGIN_PACKS.find((item) => item.id === id);
          return pack ? [pack] : [];
        })
      : [...BUILTIN_PLUGIN_PACKS];
  const presetPack = BUILTIN_PLUGIN_PACKS.find((pack) => pack.id === preset);
  return {
    policy: {
      ...(preset ? { preset } : {}),
      plus: stringArray(raw.plus),
      requires: stringArray(raw.requires),
    },
    packs: presetPack
      ? [
          pitched(presetPack, raw.pitch),
          ...offered.filter((pack) => pack.id !== presetPack.id),
        ]
      : offered,
  };
}

/**
 * Drop requested plugins the registry lacks and report them. A world package
 * may name a plugin this host has not installed; passing that ID on to session
 * creation would fail the whole request as an unknown plugin.
 */
function dropMissingRequests(
  resolved: { policy: ResolvedWorldPluginPolicy; packs: PluginPack[] },
  installed: ReadonlySet<string>,
): {
  policy: ResolvedWorldPluginPolicy;
  packs: PluginPack[];
  missing: MissingWorldPlugin[];
} {
  const missing: MissingWorldPlugin[] = [];
  const keepInstalled = (ids: readonly string[], packId?: string) =>
    ids.filter((pluginId) => {
      if (installed.has(pluginId)) return true;
      missing.push({ pluginId, ...(packId ? { packId } : {}) });
      return false;
    });
  return {
    policy: {
      ...resolved.policy,
      plus: keepInstalled(resolved.policy.plus),
    },
    packs: resolved.packs.map((pack) => ({
      ...pack,
      requested: keepInstalled(pack.requested, pack.id),
      // Turning off a plugin this host lacks changes nothing.
      ...(pack.excluded
        ? {
            excluded: pack.excluded.filter((pluginId) =>
              installed.has(pluginId),
            ),
          }
        : {}),
    })),
    missing,
  };
}

/**
 * The packs, the policy and the plugins a new session of a world starts with
 * when the player changes nothing (`defaultPluginIds`: the preset's plugins
 * and the world's `plus`), from the world's `pluginPolicy` and the plugins of
 * this host. `kind: core` plugins join at session creation.
 */
export function worldPluginPlan(
  worldId: string,
  metadata: Readonly<Record<string, unknown>> | undefined,
  plugins: readonly PluginSummary[],
): WorldPluginPlan {
  const { policy, packs, missing } = dropMissingRequests(
    resolvePolicy(metadata),
    new Set(plugins.map((plugin) => plugin.id)),
  );
  const selectedPack = policy.preset
    ? packs.find((pack) => pack.id === policy.preset)
    : undefined;
  return {
    worldId,
    packs,
    policy,
    ...(selectedPack ? { selectedPackId: selectedPack.id } : {}),
    defaultPluginIds: [
      ...new Set([...(selectedPack?.requested ?? []), ...policy.plus]),
    ],
    missing,
  };
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
  return c.json(worldPluginPlan(worldId, world.metadata, plugins));
});
