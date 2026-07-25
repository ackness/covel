/**
 * Robustness of the json-render path against plugin-authored specs.
 *
 * The server validates only the spec envelope (`view: z.record(z.unknown())`),
 * so everything inside `view` reaches the catalog renderers unvalidated, and
 * plugin UI specs are not gated by the server-code approval flow. A typo by a
 * third-party plugin author must degrade to a broken tile, never a crash that
 * unwinds to the app root.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import { covelRegistry } from "../catalog.js";
import { resolveI18n, resolveIcon } from "../catalog/helpers.js";
import { PluginSurfaceBoundary } from "@/components/error-boundary.js";

afterEach(cleanup);

function renderSpec(view: Record<string, unknown>): void {
  render(
    <JSONUIProvider registry={covelRegistry} initialState={{}} handlers={{}}>
      <Renderer spec={nestedToFlat(view as never)} registry={covelRegistry} />
    </JSONUIProvider>,
  );
}

describe("component registry lookup", () => {
  // json-render resolves components as `registry[type]`. On a plain object
  // literal that walks the prototype chain, so `"constructor"` resolved to
  // `Object` and `"toString"` to a function — silently bypassing the
  // unknown-component fallback (which warns and renders null). Measured: this
  // did not throw, it just rendered the wrong thing quietly. A null prototype
  // sends those names down the intended fallback path.
  it("does not resolve inherited Object.prototype members as components", () => {
    expect(Object.getPrototypeOf(covelRegistry)).toBeNull();
    expect(covelRegistry["constructor" as string]).toBeUndefined();
    expect(covelRegistry["toString" as string]).toBeUndefined();
  });

  it("renders a spec naming a prototype member without throwing", () => {
    expect(() => renderSpec({ type: "constructor" })).not.toThrow();
  });
});

describe("catalog prop guards", () => {
  it("resolveI18n never returns a non-string for a nested locale record", () => {
    expect(resolveI18n({ "zh-CN": { nested: "boom" } })).toBe("");
    expect(resolveI18n({ "zh-CN": { nested: "x" }, "en-US": "ok" })).toBe("ok");
  });

  it("resolveIcon tolerates a non-string name", () => {
    expect(resolveIcon({} as unknown as string)).toBeNull();
    expect(resolveIcon(42 as unknown as string)).toBeNull();
  });

  it("TagList survives a non-array `tags`", () => {
    expect(() =>
      renderSpec({ type: "TagList", props: { tags: "not-an-array" } }),
    ).not.toThrow();
  });

  it("TagList drops object entries instead of rendering them as children", () => {
    expect(() =>
      renderSpec({ type: "TagList", props: { tags: [{ a: 1 }, "kept"] } }),
    ).not.toThrow();
    expect(screen.getByText("kept")).toBeTruthy();
  });

  it("Tabs and Select survive non-array option props", () => {
    expect(() =>
      renderSpec({ type: "Tabs", props: { tabs: { nope: true } } }),
    ).not.toThrow();
    expect(() =>
      renderSpec({ type: "Select", props: { options: 7 } }),
    ).not.toThrow();
  });
});

describe("PluginSurfaceBoundary", () => {
  function Boom(): never {
    throw new Error("renderer exploded");
  }

  it("contains a renderer throw instead of letting it unwind", () => {
    // React logs the caught error; keep the test output readable.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        render(
          <PluginSurfaceBoundary surfaceLabel="npc-graph">
            <Boom />
          </PluginSurfaceBoundary>,
        ),
      ).not.toThrow();
      expect(screen.getByText(/npc-graph/)).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <PluginSurfaceBoundary>
        <span>panel content</span>
      </PluginSurfaceBoundary>,
    );
    expect(screen.getByText("panel content")).toBeTruthy();
  });
});
