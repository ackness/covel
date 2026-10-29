import path from "node:path";
import { expect, it } from "vitest";
import { runValidateManifest } from "../scripts/run-validate-manifest.js";
import {
  discoverPlugins,
  loadPluginDefinition,
  loadPluginUiSpecs,
} from "../src/index.js";

const fixture = path.resolve(
  import.meta.dirname,
  "../../../tests/third-party/session-view-probe",
);
it("statically validates and loads the read-only session view fixture", async () => {
  let stderr = "";
  const status = await runValidateManifest([fixture], {
    stdout: { write: () => {} },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
  });
  expect(stderr).toBe("");
  expect(status).toBe(0);
  const discovery = (await discoverPlugins(path.dirname(fixture))).find(
    (entry) => entry.id === "session-view-probe",
  );
  expect(discovery).toBeDefined();
  const { packageManifest } = await loadPluginDefinition(discovery!);
  const loaded = await loadPluginUiSpecs(
    fixture,
    discovery!.id,
    packageManifest.manifest.ui,
  );
  expect(loaded.diagnostics).toEqual([]);
  expect(loaded.slots.view?.map((spec) => spec.id)).toEqual(["story", "notes"]);
  expect(loaded.slots.view?.[0]).toMatchObject({
    bridge: "session",
    webview: { html: expect.stringContaining("covel.subscribe") },
  });
});
