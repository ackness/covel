import { describe, expect, it } from "vitest";
import {
  revealPolicySchema,
  revealPropsSchema,
} from "../src/schemas/catalog.js";
import { pluginUiSpecIssues } from "../src/schemas/ui-spec.js";

describe("declarative reveal policy", () => {
  it("shares defaults and bounded timing between groups and story metadata", () => {
    expect(revealPolicySchema.parse({})).toEqual({
      mode: "instant",
      intervalMs: 120,
    });
    expect(
      revealPropsSchema.parse({ revealKey: "local-group", mode: "segments" }),
    ).toEqual({ revealKey: "local-group", mode: "segments", intervalMs: 120 });
    for (const policy of [
      { mode: "typewriter" },
      { intervalMs: -1 },
      { intervalMs: 501 },
      { intervalMs: 1.5 },
      { mode: "segments", onComplete: "run" },
    ])
      expect(revealPolicySchema.safeParse(policy).success).toBe(false);
  });
  it("requires a local group identity and keeps Reveal itself display-only", () => {
    for (const spelling of ["component", "type"]) {
      const group = {
        [spelling]: "Reveal",
        props: { revealKey: { $state: "/edition" }, mode: "segments" },
        children: [{ component: "Text", props: { content: "Full text" } }],
      };
      expect(
        pluginUiSpecIssues({ view: group }, "arbitrary-owner", "right"),
      ).toEqual([]);
      expect(
        pluginUiSpecIssues(
          { view: { ...group, props: { mode: "segments" } } },
          "arbitrary-owner",
          "right",
        ).some((issue) => issue.path.includes("revealKey")),
      ).toBe(true);
      expect(
        pluginUiSpecIssues(
          { view: { ...group, on: { press: { action: "invokeRuntime" } } } },
          "arbitrary-owner",
          "right",
        ).some((issue) => issue.path === "view.on"),
      ).toBe(true);
    }
  });
  it("allows segment metadata without widening the template action boundary", () => {
    const spec = {
      match: { kind: "dialogue" },
      reveal: { mode: "segments" },
      view: {
        component: "Reveal",
        props: { revealKey: "speaker-line" },
        children: [
          {
            component: "Prose",
            props: { content: { $state: "/segment/text" } },
          },
        ],
      },
    };
    expect(pluginUiSpecIssues(spec, "arbitrary-owner", "segment")).toEqual([]);
    expect(
      pluginUiSpecIssues(
        { ...spec, reveal: { mode: "segments", intervalMs: 501 } },
        "arbitrary-owner",
        "segment",
      ).some((issue) => issue.path === "reveal.intervalMs"),
    ).toBe(true);
    expect(
      pluginUiSpecIssues(
        {
          ...spec,
          view: {
            ...spec.view,
            children: [{ component: "Button", props: { label: "Run" } }],
          },
        },
        "arbitrary-owner",
        "segment",
      ).some((issue) => issue.path.includes("children[0].component")),
    ).toBe(true);
  });
});
