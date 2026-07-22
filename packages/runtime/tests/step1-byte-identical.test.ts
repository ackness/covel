/**
 * Step 1A byte-identical guard.
 *
 * The compat-period switch to reading `getRuntimeSpec(manifest).legacyOrder`
 * instead of `manifest.priority` must not change any scheduling or ordering
 * outcome. Each test re-derives the pre-switch behavior straight from
 * `manifest.priority` as an oracle and asserts the switched code produces an
 * identical result — over the real bundled plugin set for the scheduler, and
 * over a mixed-priority fixture (ties + omitted priority) for the fan-out and
 * prompt-contribution sort keys.
 */

import { describe, expect, it } from "vitest";
import path from "node:path";
import type { RuntimeManifest } from "@covel/shared";
import { getRuntimeSpec } from "@covel/shared";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";
import { scheduleByPriority } from "../src/schedule/scheduler.js";
import type { ScheduledGroup } from "../src/types.js";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

/** Narrator band priority — the compat default for a priority-less runtime. */
const NARRATOR_PRIORITY = 500;

async function loadAllManifests(): Promise<readonly RuntimeManifest[]> {
  const discoveries = await discoverPlugins(PLUGINS_DIR);
  const manifests: RuntimeManifest[] = [];
  for (const discovery of discoveries) {
    const plugins = await loadPluginManifest(discovery);
    manifests.push(...plugins.map((plugin) => plugin.manifest));
  }
  return manifests;
}

// ── Oracle: the pre-switch priority scheduler, reading manifest.priority. ────
function oracleIsInBand(
  priority: number | undefined,
  turnNumber: number,
): priority is number {
  if (priority === undefined) return false;
  if (turnNumber === 0) return priority >= 0 && priority <= 99;
  return priority >= 100 && priority <= 1000;
}

function oracleScheduleByPriority(
  runtimes: readonly RuntimeManifest[],
  turnNumber: number,
): readonly ScheduledGroup[] {
  const grouped = new Map<number, RuntimeManifest[]>();
  for (const rt of runtimes) {
    if (!oracleIsInBand(rt.priority, turnNumber)) continue;
    const existing = grouped.get(rt.priority);
    if (existing) existing.push(rt);
    else grouped.set(rt.priority, [rt]);
  }
  return [...grouped.keys()]
    .sort((a, b) => a - b)
    .map((priority) => ({ priority, runtimes: grouped.get(priority)! }));
}

function structOf(
  groups: readonly ScheduledGroup[],
): readonly { priority: number; names: readonly string[] }[] {
  return groups.map((g) => ({
    priority: g.priority,
    names: g.runtimes.map((r) => r.name),
  }));
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
    fixtureManifest("e", 600), // tie with "a" — stable-sort order must hold
    fixtureManifest("f", undefined), // tie with "b"
    fixtureManifest("g", 900),
  ];
}

describe("step 1A byte-identical (legacyOrder ≡ manifest.priority)", () => {
  it("scheduleByPriority matches the pre-switch algorithm at turn 0 and turn 1", async () => {
    const manifests = await loadAllManifests();
    for (const turn of [0, 1]) {
      expect(
        structOf(scheduleByPriority(manifests, turn)),
        `turn ${turn} grouping`,
      ).toEqual(structOf(oracleScheduleByPriority(manifests, turn)));
    }
  });

  it("event fan-out ordering is identical (legacyOrder ?? 500 ≡ priority ?? 500)", () => {
    const manifests = orderingFixture();
    const switched = [...manifests]
      .sort(
        (a, b) =>
          (getRuntimeSpec(a).legacyOrder ?? NARRATOR_PRIORITY) -
          (getRuntimeSpec(b).legacyOrder ?? NARRATOR_PRIORITY),
      )
      .map((m) => m.name);
    const oracle = [...manifests]
      .sort(
        (a, b) =>
          (a.priority ?? NARRATOR_PRIORITY) - (b.priority ?? NARRATOR_PRIORITY),
      )
      .map((m) => m.name);
    expect(switched).toEqual(oracle);
  });

  it("prompt contribution ordering is identical (legacyOrder ?? Infinity ≡ priority ?? Infinity)", () => {
    const manifests = orderingFixture();
    const switched = [...manifests]
      .sort(
        (a, b) =>
          (getRuntimeSpec(a).legacyOrder ?? Infinity) -
          (getRuntimeSpec(b).legacyOrder ?? Infinity),
      )
      .map((m) => m.name);
    const oracle = [...manifests]
      .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
      .map((m) => m.name);
    expect(switched).toEqual(oracle);
  });
});
