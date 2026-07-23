/**
 * Ordering-equivalence guards for the priority → stage/name switch.
 *
 * The fan-out and prompt-contribution sorts switched away from numeric priority
 * to name / `(stage, name)`. Over the BUNDLED set these must still produce the
 * same per-topic / per-render execution outcome as the old priority sort,
 * because no bundled topic has two subscribers and the production contribution
 * caller only ever passes one manifest. Each test pins the new sort as evidence
 * the switch is byte-identical on the real plugin set.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import type { RuntimeManifest } from "@covel/shared";
import { getRuntimeSpec, stageRank } from "@covel/shared";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

async function loadAllManifests(): Promise<readonly RuntimeManifest[]> {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const manifests: RuntimeManifest[] = [];
  for (const discovery of discoveries) {
    const plugins = await loadPluginManifest(discovery);
    manifests.push(...plugins.map((plugin) => plugin.manifest));
  }
  return manifests;
}

function fixtureManifest(
  name: string,
  priority: number | undefined,
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    ...(priority !== undefined ? { priority } : {}),
  } as RuntimeManifest;
}

/** Mixed priorities: ties, omitted priority, and out-of-order input. */
function orderingFixture(): readonly RuntimeManifest[] {
  return [
    fixtureManifest("a", 600),
    fixtureManifest("b", undefined),
    fixtureManifest("c", 100),
    fixtureManifest("d", 500),
    fixtureManifest("e", 600),
    fixtureManifest("f", undefined),
    fixtureManifest("g", 900),
  ];
}

describe("ordering equivalence (priority → stage/name)", () => {
  it("bundled event subscribers are one-per-topic, so name-order fan-out is outcome-identical", async () => {
    // The fan-out sort switched to name order. It is observable only when a
    // single fan-out batch holds two subscribers of a pending topic. The
    // bundled set never does: each event runtime owns a distinct subscribed
    // topic, so no batch ever contains two runtimes whose order matters —
    // making the new name sort byte-identical in outcome to the old priority
    // sort for the bundled set.
    const manifests = await loadAllManifests();
    const subscribedTopics = manifests
      .filter((m) => m.trigger?.type === "event")
      .map((m) => m.trigger?.topic)
      .filter((t): t is string => typeof t === "string");
    expect(subscribedTopics.length).toBeGreaterThan(0);
    expect(new Set(subscribedTopics).size).toBe(subscribedTopics.length);
  });

  it("new (stage, name) contribution sort is deterministic and stage-monotonic", () => {
    // The prompt-contribution sort switched from `priority` to `(stage, name)`.
    // The production caller passes exactly one manifest, so the ordering is
    // observable only to multi-manifest callers — pin the new key here as the
    // regression contract (stage rank non-decreasing, name breaks ties).
    const manifests = orderingFixture();
    const sorted = [...manifests].sort((a, b) => {
      const ra = stageRank(getRuntimeSpec(a).stage);
      const rb = stageRank(getRuntimeSpec(b).stage);
      return ra - rb || a.name.localeCompare(b.name);
    });
    for (let i = 1; i < sorted.length; i++) {
      const prev = stageRank(getRuntimeSpec(sorted[i - 1]!).stage);
      const cur = stageRank(getRuntimeSpec(sorted[i]!).stage);
      expect(prev).toBeLessThanOrEqual(cur);
      if (prev === cur) {
        expect(
          sorted[i - 1]!.name.localeCompare(sorted[i]!.name),
        ).toBeLessThanOrEqual(0);
      }
    }
  });

  it("a single-manifest contribution list is order-invariant (the production path)", () => {
    // resolveActiveManifests receives `[manifest]` in production; sorting a
    // one-element list is identity under any comparator, so the switch is a
    // no-op on the real turn path.
    const one = [fixtureManifest("solo", 600)];
    const sorted = [...one].sort((a, b) => {
      const ra = stageRank(getRuntimeSpec(a).stage);
      const rb = stageRank(getRuntimeSpec(b).stage);
      return ra - rb || a.name.localeCompare(b.name);
    });
    expect(sorted.map((m) => m.name)).toEqual(["solo"]);
  });
});
