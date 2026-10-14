import { describe, expect, it } from "vitest";
import { pluginUiSpecIssues } from "../src/schemas/ui-spec.js";

const paths = (spec: unknown) =>
  pluginUiSpecIssues(spec, "owner").map((issue) => issue.path);

describe("plugin UI spec rules", () => {
  it("accepts registered components, named slots, and nested repeats", () => {
    expect(
      pluginUiSpecIssues(
        {
          id: "nested-list",
          view: {
            component: "Stack",
            repeat: { statePath: "/groups", key: "id" },
            slots: {
              content: [
                {
                  component: "Card",
                  repeat: { statePath: { $item: "items" }, key: "id" },
                  children: [
                    {
                      component: "Button",
                      on: {
                        click: {
                          action: "invokeCommand",
                          params: { args: { sides: { $item: "sides" } } },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          },
        },
        "owner",
      ),
    ).toEqual([]);
  });

  it("rejects unknown components with a nested path", () => {
    expect(
      paths({
        view: {
          component: "Stack",
          slots: { footer: [{ component: "ArbitraryPluginWidget" }] },
        },
      }),
    ).toContain("view.slots.footer[0].component");
  });

  it("rejects malformed graph-bearing fields", () => {
    expect(
      paths({
        view: {
          component: "Stack",
          children: "not-an-array",
          repeat: { statePath: { $state: "/items" } },
        },
      }),
    ).toEqual(
      expect.arrayContaining(["view.children", "view.repeat.statePath"]),
    );
  });

  it("requires exactly one of view and webview", () => {
    expect(paths({ id: "empty" })).toEqual(["view"]);
    expect(
      paths({ view: { component: "Text" }, webview: { entry: "./a.html" } }),
    ).toEqual(["webview"]);
  });

  it("permits own bindings and explicit own namespaces", () => {
    expect(
      pluginUiSpecIssues(
        {
          dataSource: {
            namespace: "records",
            bindings: { nodes: "characters", edges: "relationships-v2" },
          },
          view: {
            component: "Text",
            props: { action: { pluginId: "owner", runtimeId: "owner/run" } },
          },
        },
        "owner",
      ),
    ).toEqual([]);
  });

  it.each(["pluginId", "sourcePlugin", "sourcePluginId"])(
    "rejects foreign and dynamic %s bindings anywhere in the spec",
    (key) => {
      for (const value of ["other", { $state: "/target" }])
        expect(
          paths({
            view: {
              component: "Stack",
              children: [{ component: "Text", props: { [key]: value } }],
            },
          }),
        ).toEqual([`view.children[0].props.${key}`]);
    },
  );

  it.each([
    { nodes: { $state: "/target" } },
    { nodes: "other/records" },
    { "../other": "records" },
    { nodes: "" },
  ])("rejects dynamic or qualified namespace bindings: %j", (bindings) => {
    expect(
      paths({ dataSource: { bindings }, view: { component: "Text" } })[0],
    ).toMatch(/^dataSource\.bindings/);
  });

  it("rejects an item field written as a state path", () => {
    expect(
      pluginUiSpecIssues(
        { view: { component: "Text", props: { content: { $item: "/name" } } } },
        "owner",
      ),
    ).toEqual([
      expect.objectContaining({
        path: "view.props.content.$item",
        message: expect.stringContaining(
          'write the item\'s field name ("name")',
        ),
      }),
    ]);
  });
});
