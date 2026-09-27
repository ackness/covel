import { describe, expect, it } from "vitest";
import { validateUiBindings } from "../src/ui-spec.js";
describe("plugin UI binding ownership", () => {
  it("permits own actions and unqualified own data namespaces", () => {
    expect(() =>
      validateUiBindings(
        {
          dataSource: { namespace: "records" },
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
});
