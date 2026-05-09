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

  it("returns null for non-object views", () => {
    expect(pluginPanelViewToSpec(null)).toBeNull();
    expect(pluginPanelViewToSpec("Stack")).toBeNull();
  });
});
