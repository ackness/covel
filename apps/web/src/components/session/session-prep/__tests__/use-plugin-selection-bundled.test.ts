import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import type { PluginPack, PluginSummary, WorldPluginPlan } from "@covel/shared";
import { usePluginSelection } from "../use-plugin-selection.js";
import * as api from "@/services/api.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@/services/api.js", () => ({
  getWorldPluginPlan: vi.fn(),
}));

// The bundled catalogue itself: synthetic plugins cannot show that a world's
// preferred tags and its default pack select the same narrative engine.
const ROOT = path.resolve(import.meta.dirname, "../../../../../../..");
const bundled = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name);
const readYaml = (...segments: string[]): Record<string, unknown> =>
  parse(readFileSync(path.join(ROOT, ...segments), "utf8"));
const list = <T = string>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const PLUGINS = bundled("plugins").map((id) => {
  const source = readFileSync(path.join(ROOT, "plugins", id, "PLUGIN.md"));
  const manifest = parse(source.toString("utf8").split(/^---$/m)[1]!);
  return {
    id,
    displayName: id,
    description: "",
    kind: manifest.kind,
    source: "builtin",
    hostState: "loaded",
    runtimeCount: 0,
    tags: list(manifest.tags),
    provides: list(manifest.provides),
    requires: list(manifest.requires),
    optional: list(manifest.optional),
    conflicts: list(manifest.conflicts),
    extensions: list(manifest.contributes?.extensions),
    eventTopics: list<{ topic: string }>(manifest.contributes?.events).map(
      (event) => event.topic,
    ),
    runtimes: [],
    tools: [],
    userSettings: [],
    languages: { text: ["en"], instructions: ["en"] },
  } as PluginSummary;
});
const BUILTIN_PACKS = list<PluginPack>(readYaml("packs", "builtin.yaml"));

/** The plan `GET /api/worlds/:id/plugin-plan` returns for a bundled world. */
function bundledPlan(worldId: string): WorldPluginPlan {
  const raw = (readYaml("worlds", worldId, "world.yaml").pluginPolicy ??
    {}) as Record<string, unknown>;
  const worldPacks = list<PluginPack>(raw.packs).map((pack) => ({
    ...pack,
    source: "world" as const,
  }));
  const packs = [
    ...worldPacks,
    ...BUILTIN_PACKS.filter(
      (pack) => !worldPacks.some((item) => item.id === pack.id),
    ),
  ];
  const policy = {
    ...(typeof raw.presetId === "string" ? { presetId: raw.presetId } : {}),
    preferredTags: list(raw.preferredTags),
    avoidedTags: list(raw.avoidedTags),
    requested: list(raw.requested),
    recommended: list(raw.recommended),
    requires: list(raw.requires),
  };
  const selectedPack = packs.find((pack) => pack.id === policy.presetId);
  const defaults = new Set([
    ...policy.requested,
    ...(selectedPack?.requested ?? []),
  ]);
  for (const plugin of PLUGINS) {
    if (policy.avoidedTags.some((tag) => plugin.tags.includes(tag))) continue;
    if (policy.preferredTags.some((tag) => plugin.tags.includes(tag)))
      defaults.add(plugin.id);
  }
  return {
    worldId,
    packs,
    policy,
    ...(selectedPack ? { selectedPackId: selectedPack.id } : {}),
    defaultPluginIds: [...defaults],
    missing: [],
  };
}

const prepareWorldForServer = async () => {};
const CASES = bundled("worlds").flatMap((worldId) => {
  const plan = bundledPlan(worldId);
  return plan.packs
    .filter((pack) => pack.id !== plan.selectedPackId)
    .map((pack) => ({ worldId, plan, pack }));
});

describe("usePluginSelection with the bundled worlds and packs", () => {
  it.each(CASES)(
    "$worldId activates every request of $pack.id after its default pack",
    async ({ worldId, plan, pack }) => {
      vi.mocked(api.getWorldPluginPlan).mockResolvedValue(plan);
      const { result } = renderHook(() =>
        usePluginSelection(worldId, PLUGINS, prepareWorldForServer),
      );
      await waitFor(() => expect(result.current.pluginPlanLoading).toBe(false));
      expect(result.current.activePluginPack?.id).toBe(plan.selectedPackId);

      act(() => result.current.applyPack(pack.id));

      expect(result.current.activePluginPack?.id).toBe(pack.id);
      expect(
        pack.requested.filter((id) => !result.current.selectedPlugins.has(id)),
      ).toEqual([]);
    },
  );
});
