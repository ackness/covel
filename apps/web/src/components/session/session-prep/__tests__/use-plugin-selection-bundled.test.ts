import { existsSync, readdirSync, readFileSync } from "node:fs";
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
// `plus` and its default pack leave one narrative engine after a pack switch.
const ROOT = path.resolve(import.meta.dirname, "../../../../../../..");
const bundled = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name);
const readYaml = (...segments: string[]): Record<string, unknown> =>
  parse(readFileSync(path.join(ROOT, ...segments), "utf8"));
const list = <T = string>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const frontmatter = (...segments: string[]) =>
  parse(
    readFileSync(path.join(ROOT, ...segments), "utf8").split(/^---$/m)[1]!,
  ) ?? {};
const contractOf = (entry: unknown) =>
  typeof entry === "string" ? entry : (entry as { contract: string }).contract;

const PLUGINS = bundled("plugins").map((id) => {
  const manifest = frontmatter("plugins", id, "PLUGIN.md");
  // As the loader works them out: a package provides what it writes, then
  // each runtime's output contract.
  const runtimeDir = path.join(ROOT, "plugins", id, "runtimes");
  const runtimes = [
    manifest.runtime,
    ...(manifest.runtime || !existsSync(runtimeDir)
      ? []
      : readdirSync(runtimeDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) =>
            frontmatter("plugins", id, "runtimes", entry.name, "RUNTIME.md"),
          )),
  ].filter(Boolean);
  const provides: unknown[] = list(manifest.provides);
  for (const runtime of runtimes) {
    const contract = runtime.io?.output?.contract;
    if (contract && !provides.map(contractOf).includes(contract))
      provides.push(contract);
  }
  return {
    id,
    displayName: id,
    description: "",
    kind: manifest.kind ?? "plugin",
    source: "builtin",
    hostState: "loaded",
    runtimeCount: 0,
    tags: list(manifest.tags),
    provides,
    requires: list(manifest.requires),
    optional: [],
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
  const named = list(raw.packs);
  const offered = named.length
    ? BUILTIN_PACKS.filter((pack) => named.includes(pack.id))
    : BUILTIN_PACKS;
  const presetPack = BUILTIN_PACKS.find((pack) => pack.id === raw.preset);
  const packs = presetPack
    ? [
        { ...presetPack, source: "world" as const },
        ...offered.filter((pack) => pack.id !== presetPack.id),
      ]
    : offered;
  const policy = {
    ...(presetPack ? { preset: presetPack.id } : {}),
    plus: list(raw.plus),
    requires: list(raw.requires),
  };
  return {
    worldId,
    packs,
    policy,
    ...(presetPack ? { selectedPackId: presetPack.id } : {}),
    defaultPluginIds: [
      ...new Set([...(presetPack?.requested ?? []), ...policy.plus]),
    ],
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
      expect(
        (pack.excluded ?? []).filter((id) =>
          result.current.selectedPlugins.has(id),
        ),
      ).toEqual([]);
    },
  );
});
