import type {
  PluginManifest,
  RuntimeAuthoringManifest,
  RuntimeManifest,
} from "@covel/shared";
import type { ParsedRuntimeMd } from "../src/types.js";
import { describe, expect, it } from "vitest";
import { compileRuntimeManifest } from "../src/compile-manifest.js";
import { packageTags } from "../src/package-defaults.js";

const plugin: PluginManifest = {
  id: "probe",
  kind: "plugin",
  description: "Probe",
};

describe("schedule.subagentOnly", () => {
  it("compiles to subagentOnly with an implied manual trigger", () => {
    const manifest = compileRuntimeManifest(
      plugin,
      {
        schedule: { subagentOnly: true },
        io: { output: { contract: "test-actor@1" } },
      },
      "probe/guard",
    );
    expect(manifest).toMatchObject({
      subagentOnly: true,
      trigger: { type: "manual" },
      outputContract: "test-actor@1",
      runtimeType: "agent",
    });
    expect(manifest.stage).toBeUndefined();
  });

  it("leaves the flag out when it is false", () => {
    const manifest = compileRuntimeManifest(
      plugin,
      { schedule: { stage: "post-turn", subagentOnly: false } },
      "probe/notes",
    );
    expect(manifest).not.toHaveProperty("subagentOnly");
    expect(manifest.trigger).toBeUndefined();
  });

  it("derives no ui:manual-action from a sub-agent-only runtime", () => {
    const parsed = (
      runtime: RuntimeAuthoringManifest,
      id: string,
    ): ParsedRuntimeMd => {
      const manifest: RuntimeManifest = compileRuntimeManifest(
        plugin,
        runtime,
        id,
      );
      return { promptTemplate: "", rawFrontmatter: {}, runtime, manifest };
    };
    const guard = parsed({ schedule: { subagentOnly: true } }, "probe/guard");
    const manual = parsed(
      { schedule: { trigger: { type: "manual" } } },
      "probe/manual",
    );
    expect(packageTags(plugin, [guard])).not.toContain("ui:manual-action");
    expect(packageTags(plugin, [manual])).toContain("ui:manual-action");
  });
});
