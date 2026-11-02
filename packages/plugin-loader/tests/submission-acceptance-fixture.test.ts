import path from "node:path";
import { expect, it } from "vitest";
import { resolveAgentOutput } from "@covel/shared/plugin-runtime";
import {
  discoverPluginAt,
  loadPluginDefinition,
  loadRuntime,
  validatePluginPackage,
} from "../src/index.js";

it("loads the acceptance fixture with host prose and character-child contracts", async () => {
  const root = path.resolve(
    import.meta.dirname,
    "../../../tests/third-party/submission-review-probe",
  );
  const report = await validatePluginPackage(root);
  expect(report.ok, JSON.stringify(report.issues)).toBe(true);
  const discovery = (await discoverPluginAt(root))!;
  const definition = await loadPluginDefinition(discovery);
  const prose = await loadRuntime(
    discovery,
    "submission-review-probe/prose",
    "en",
    definition,
  );
  expect(resolveAgentOutput(prose)).toMatchObject({
    toolName: "submit-output",
    schemaSource: "host-story",
    schema: { required: ["narrativeOutput"] },
  });
  expect(prose.manifest.trigger).toEqual({ type: "manual" });
  const actor = await loadRuntime(
    discovery,
    "submission-review-probe/actor",
    "en",
    definition,
  );
  expect(actor.manifest.subagentOnly).toBe(true);
  expect(actor.manifest.outputContract).toBe("character-actor@1");
  expect(resolveAgentOutput(actor).schemaSource).toBe("loaded");
  const parent = await loadRuntime(
    discovery,
    "submission-review-probe/delegate",
    "en",
    definition,
  );
  expect(parent.manifest.tools?.builtin).toEqual([
    "list-characters",
    "delegate",
  ]);
  expect(resolveAgentOutput(parent).schemaSource).toBe("host-system");
});
