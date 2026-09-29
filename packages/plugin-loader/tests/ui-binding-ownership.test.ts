import { describe, expect, it } from "vitest";
import { validateUiBindings } from "../src/ui-spec.js";
describe("plugin UI binding ownership", () => {
  it("permits own actions and unqualified own data namespaces", () => {
    expect(() =>
      validateUiBindings(
        {
          dataSource: {
            namespace: "records",
            bindings: { nodes: "characters", edges: "relationships-v2" },
          },
          view: {
            props: { action: { pluginId: "owner", runtimeId: "owner/run" } },
          },
        },
        "owner",
      ),
    ).not.toThrow();
  });
  it.each(["pluginId", "sourcePlugin", "sourcePluginId"])(
    "rejects foreign and dynamic %s bindings recursively",
    (key) => {
      expect(() =>
        validateUiBindings(
          { children: [{ props: { [key]: "other" } }] },
          "owner",
        ),
      ).toThrow("owning plugin");
      expect(() =>
        validateUiBindings(
          { props: { [key]: { $state: "/target" } } },
          "owner",
        ),
      ).toThrow("owning plugin");
    },
  );
  it.each([
    { nodes: { $state: "/target" } },
    { nodes: "other/records" },
    { "../other": "records" },
    { nodes: "" },
  ])("rejects dynamic or qualified namespace bindings", (bindings) => {
    expect(() =>
      validateUiBindings({ dataSource: { bindings } }, "owner"),
    ).toThrow("explicit own namespaces");
  });
});
