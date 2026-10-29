import { describe, expect, it } from "vitest";
import {
  pluginUiSpecIssues,
  pluginUiSpecSchema,
} from "../src/schemas/ui-spec.js";

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

  it("validates explicit navigation destinations independently of icons", () => {
    const view = { component: "Text" };
    expect(
      paths({ id: "gallery", navTarget: "images", icon: "book-open", view }),
    ).toEqual([]);
    expect(paths({ navTarget: "unknown", view })).toEqual(["navTarget"]);
  });
});

describe("row template and value-label contracts", () => {
  const view = (itemTemplate: unknown) => ({
    component: "FilterContainer",
    props: {
      items: { $state: "/entries" },
      itemTemplate,
    },
  });

  it("accepts a template with nested slots, row expressions, actions and label maps", () => {
    const spec = {
      view: view({
        component: "Card",
        slots: {
          header: [
            {
              component: "Badge",
              props: {
                label: {
                  $map: { $item: "status" },
                  labels: { active: "Active", pluginId: "Label" },
                  fallback: { $item: "status" },
                },
              },
            },
          ],
        },
        children: [
          {
            component: "Button",
            on: {
              click: { action: "invokeRuntime", params: { pluginId: "owner" } },
            },
          },
        ],
      }),
    };
    expect(pluginUiSpecSchema.safeParse(spec).success).toBe(true);
    expect(paths(spec)).toEqual([]);
  });

  it.each([
    [{ component: "UnknownWidget" }, "view.props.itemTemplate.component"],
    [
      {
        component: "Stack",
        slots: { header: [{ component: "UnknownWidget" }] },
      },
      "view.props.itemTemplate.slots.header[0].component",
    ],
    [
      {
        component: "Text",
        props: { content: { $map: "active", labels: ["Active"] } },
      },
      "view.props.itemTemplate.props.content.labels",
    ],
    [
      {
        component: "Text",
        props: { content: { $map: "active", labels: { active: 3 } } },
      },
      "view.props.itemTemplate.props.content.labels.active",
    ],
    [
      { component: "Text", props: { content: { $item: "/title" } } },
      "view.props.itemTemplate.props.content.$item",
    ],
  ])(
    "rejects malformed template %j in both schema and shared validation",
    (template, at) => {
      const spec = { view: view(template) };
      expect(pluginUiSpecSchema.safeParse(spec).success).toBe(false);
      expect(paths(spec)).toContain(at);
    },
  );

  it("rejects foreign bindings inside templates", () => {
    expect(
      paths({
        view: view({
          component: "Button",
          on: {
            click: { action: "invokeRuntime", params: { pluginId: "other" } },
          },
        }),
      }),
    ).toContain("view.props.itemTemplate.on.click.params.pluginId");
  });

  it("requires a template and state-backed items, and rejects removed item props", () => {
    for (const props of [
      { items: { $state: "/entries" } },
      { items: [], itemTemplate: { component: "Text" } },
      {
        items: { $state: "/entries" },
        itemTemplate: { component: "Text" },
        itemComponent: "Text",
        itemPropMap: {},
        itemLiteralProps: {},
      },
    ])
      expect(
        paths({ view: { component: "FilterContainer", props } }).length,
      ).toBeGreaterThan(0);
  });
});

describe("full-column view placement", () => {
  const valid = {
    id: "reader",
    label: "Reader",
    webview: { entry: "./reader.html" },
    bridge: "session",
  };
  it("accepts a session bridge webview", () => {
    expect(pluginUiSpecIssues(valid, "owner", "view")).toEqual([]);
  });
  it.each(["id", "label"])("requires %s", (field) => {
    const spec: Record<string, unknown> = { ...valid };
    delete spec[field];
    expect(pluginUiSpecIssues(spec, "owner", "view")).toContainEqual(
      expect.objectContaining({
        path: field,
        message: expect.stringContaining("contributes.ui.view"),
      }),
    );
  });
  it.each(["1reader", "Reader", "a".repeat(65)])("rejects view id %s", (id) => {
    expect(
      pluginUiSpecIssues({ ...valid, id }, "owner", "view").map(
        (issue) => issue.path,
      ),
    ).toContain("id");
  });
  it.each([
    "surfaces",
    "group",
    "groupLabel",
    "groupOrder",
    "shortLabel",
    "navTarget",
  ])("rejects routing field %s", (field) => {
    expect(
      pluginUiSpecIssues(
        {
          ...valid,
          [field]:
            field === "surfaces"
              ? ["panel"]
              : field === "groupOrder"
                ? 1
                : field === "navTarget"
                  ? "images"
                  : "x",
        },
        "owner",
        "view",
      ),
    ).toContainEqual({ path: field, message: "not valid in a view" });
  });
  it("restricts the bridge to a webview in the view placement", () => {
    expect(
      pluginUiSpecIssues(
        {
          id: "reader",
          label: "Reader",
          view: { component: "Text" },
          bridge: "session",
        },
        "owner",
        "view",
      ),
    ).toContainEqual(
      expect.objectContaining({
        path: "bridge",
        message: expect.stringContaining("webview"),
      }),
    );
    expect(pluginUiSpecIssues(valid, "owner", "right")).toContainEqual({
      path: "bridge",
      message: "bridge is only valid in contributes.ui.view",
    });
    expect(
      pluginUiSpecIssues({ view: { component: "Text" } }, "owner"),
    ).toEqual([]);
  });
});
