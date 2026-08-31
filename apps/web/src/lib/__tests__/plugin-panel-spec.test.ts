import { describe, expect, it } from "vitest";
import {
  pluginPanelViewToSpec,
  rewriteComponentToType,
  specUsesComponent,
} from "../plugin-panel-spec.js";

describe("plugin-panel spec helpers", () => {
  it("rewrites component keys recursively without touching non-object children", () => {
    expect(
      rewriteComponentToType({
        component: "Stack",
        props: { gap: 2 },
        children: [{ component: "Text", props: { text: "Hello" } }, "literal"],
      }),
    ).toEqual({
      type: "Stack",
      props: { gap: 2 },
      children: [{ type: "Text", props: { text: "Hello" } }, "literal"],
    });
  });

  it("rewrites components in multiple named slots and preserves unknown fields", () => {
    expect(
      rewriteComponentToType({
        component: "Card",
        metadata: { source: "plugin" },
        slots: {
          header: [
            { component: "Text", props: { text: "Title" }, priority: 1 },
          ],
          footer: [{ component: "Button", props: { label: "Save" } }],
          unsupported: "leave-as-is",
        },
      }),
    ).toEqual({
      type: "Card",
      metadata: { source: "plugin" },
      slots: {
        header: [{ type: "Text", props: { text: "Title" }, priority: 1 }],
        footer: [{ type: "Button", props: { label: "Save" } }],
        unsupported: "leave-as-is",
      },
    });
  });

  it("rewrites components recursively through nested named slots", () => {
    expect(
      rewriteComponentToType({
        component: "Shell",
        slots: {
          content: [
            {
              component: "Card",
              slots: {
                header: [{ component: "Text" }],
                content: [
                  {
                    component: "Stack",
                    children: [{ component: "Badge" }],
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toEqual({
      type: "Shell",
      slots: {
        content: [
          {
            type: "Card",
            slots: {
              header: [{ type: "Text" }],
              content: [
                {
                  type: "Stack",
                  children: [{ type: "Badge" }],
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("detects components in both source and json-render forms", () => {
    expect(
      specUsesComponent(
        {
          component: "Stack",
          children: [{ type: "ImageGallery" }],
        },
        "ImageGallery",
      ),
    ).toBe(true);
    expect(
      specUsesComponent(
        {
          component: "Card",
          slots: { content: [{ component: "ImageGallery" }] },
        },
        "ImageGallery",
      ),
    ).toBe(true);
    expect(specUsesComponent({ component: "Text" }, "ImageJobs")).toBe(false);
  });

  it("converts plugin panel views to flat json-render specs", () => {
    const spec = pluginPanelViewToSpec({
      component: "Stack",
      children: [{ component: "Text", props: { text: "Hello" } }],
    });

    expect(spec).not.toBeNull();
    expect(Object.keys(spec ?? {})).toContain("root");
  });

  it("flattens named slots and preserves nested repeat item paths", () => {
    const spec = pluginPanelViewToSpec({
      component: "Stack",
      repeat: { statePath: "/groups", key: "id" },
      slots: {
        header: [{ component: "Text", props: { text: "Groups" } }],
        content: [
          {
            component: "Card",
            repeat: { statePath: { $item: "items" }, key: "id" },
            slots: {
              content: [
                { component: "Text", props: { text: { $item: "name" } } },
              ],
            },
          },
        ],
      },
    });

    expect(spec).not.toBeNull();
    const root = spec?.elements[spec.root];
    expect(root?.repeat).toEqual({ statePath: "/groups", key: "id" });
    expect(root?.slots).toEqual({
      header: [expect.any(String)],
      content: [expect.any(String)],
    });

    const contentKey = root?.slots?.content?.[0];
    expect(contentKey).toBeDefined();
    const content = contentKey ? spec?.elements[contentKey] : undefined;
    expect(content?.type).toBe("Card");
    expect(content?.repeat).toEqual({
      statePath: { $item: "items" },
      key: "id",
    });
    expect(content?.slots).toEqual({ content: [expect.any(String)] });
  });

  it("returns null for non-object views", () => {
    expect(pluginPanelViewToSpec(null)).toBeNull();
    expect(pluginPanelViewToSpec("Stack")).toBeNull();
  });
});
