import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadRuntime,
} from "@covel/plugin-loader";
import { validateWorldIRV1 } from "../schemas/world-ir.js";

describe("world-ir plugin contract", () => {
  it("declares a typed narrative input and validated reusable output", async () => {
    const pluginsRoot = path.resolve(import.meta.dirname, "../..");
    const discovery = (await discoverPlugins(pluginsRoot)).find(
      (candidate) => candidate.id === "world-ir",
    );
    expect(discovery).toBeDefined();

    const definition = await loadPluginDefinition(discovery!);
    const [parsed] = definition.manifests;
    const { manifest: packageManifest } = definition.packageManifest;
    const loaded = await loadRuntime(discovery!, "world-ir");
    expect(parsed?.manifest.outputContract).toBe("world-ir-provider@1");
    expect(packageManifest.displayName).toEqual({
      zh: "世界事实提取",
      en: "World Fact Extraction",
    });
    expect(packageManifest.entry).toBe("./server/index.js");
    expect(parsed?.manifest.tools?.plugin).toEqual(["submit-world-facts"]);
    expect(parsed?.manifest.requireToolUse).toBe(true);
    expect(parsed?.manifest.completeAfterTools).toEqual(["submit-world-facts"]);
    expect(parsed?.manifest.maxRetries).toBe(0);
    expect(parsed?.manifest.callTimeoutMs).toBe(60_000);
    expect(parsed?.manifest.inputs?.narrative).toEqual({
      from: { capability: "narrative-engine@1", cardinality: "one" },
      select: "/narrativeOutput",
      accepts: "./schemas/narrative-output.schema.json",
      required: true,
    });
    expect(parsed?.manifest.output).toEqual({
      schema: "contract:world-ir@1",
      recordAs: "world-ir-v1",
    });
    expect(loaded?.outputSchema?.$id).toBe("contract:world-ir@1");
  });

  it("emits the same envelope accepted by the shared WorldIR validator", () => {
    expect(
      validateWorldIRV1({
        schemaVersion: 1,
        summary: "A turn summary.",
        entities: [],
        relations: [],
        events: [],
        statements: [],
      }),
    ).toEqual(
      expect.objectContaining({
        valid: true,
      }),
    );
  });
});
