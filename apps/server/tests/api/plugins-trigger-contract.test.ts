import { describe, expect, it } from "vitest";
import {
  apiListResponseSchema,
  pluginSummarySchema,
  runtimeAuthoringManifestSchema,
} from "@covel/shared";
import { buildPluginSummary } from "../../src/lib/plugin-descriptor.js";

describe("plugin trigger discovery contract", () => {
  it.each(["auto", "manual"] as const)(
    "preserves an authored %s trigger with an empty optional topic",
    (type) => {
      const description = "Trigger contract fixture";
      const name = "trigger-fixture";
      const { schedule } = runtimeAuthoringManifestSchema.parse({
        description,
        schedule: {
          trigger: { type, topic: "" },
          ...(type === "auto" ? { stage: "pre-turn" } : {}),
        },
      });
      const authored = {
        name,
        trigger: {
          ...schedule?.trigger,
          type: schedule?.trigger?.type ?? type,
        },
        stage: schedule?.stage,
      };
      const summary = buildPluginSummary({
        id: authored.name,
        source: "builtin",
        status: "registered",
        summary: {
          id: authored.name,
          name: "Trigger fixture",
          description,
          kind: "plugin",
          runtimeCount: 1,
        },
        manifests: [
          {
            runtime: {},
            manifest: { ...authored, pluginId: authored.name, description },
            promptTemplate: "",
            rawFrontmatter: {},
          },
        ],
        loadedRuntimes: new Map(),
      });

      const wire: unknown = JSON.parse(JSON.stringify({ items: [summary] }));
      const parsed = apiListResponseSchema(pluginSummarySchema).parse(wire);

      expect(parsed.items[0]?.runtimes[0]?.trigger).toEqual({
        type,
        topic: "",
      });
      expect(parsed.items[0]?.runtimes[0]?.stage).toBe(
        type === "auto" ? "pre-turn" : undefined,
      );
    },
  );
});
