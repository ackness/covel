// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorldRecord } from "@/services/api.js";
import { useGameViewMode } from "../game-view/use-game-view-mode.js";

type World = Pick<WorldRecord, "metadata"> | null;
const stageWorld: World = { metadata: { defaultViewMode: "stage" } };

describe("game view mode", () => {
  it("opens in the world's default view", () => {
    const { result } = renderHook(() => useGameViewMode(stageWorld));
    expect(result.current[0]).toBe("stage");
  });

  it("applies the default of a world that arrives after the view mounts", () => {
    const { result, rerender } = renderHook(
      ({ world }: { world: World }) => useGameViewMode(world),
      { initialProps: { world: null as World } },
    );
    expect(result.current[0]).toBe("parsed");
    rerender({ world: stageWorld });
    expect(result.current[0]).toBe("stage");
  });

  it("keeps the view the player picked", () => {
    const { result, rerender } = renderHook(
      ({ world }: { world: World }) => useGameViewMode(world),
      { initialProps: { world: null as World } },
    );
    act(() => result.current[1]("raw"));
    rerender({ world: stageWorld });
    expect(result.current[0]).toBe("raw");

    act(() => result.current[1]("parsed"));
    rerender({
      world: { metadata: { defaultViewMode: "stage", source: "x" } },
    });
    expect(result.current[0]).toBe("parsed");
  });
});

const entry: import("../game-view/use-plugin-views.js").PluginViewEntry = {
  mode: "plugin:p:v",
  pluginId: "p",
  viewId: "v",
  label: "View",
  pluginName: "Plugin",
  spec: { id: "v", label: "View", webview: { html: "<p>view</p>" } },
};
it("waits for the plugin list, preserves the chosen view and recovers from errors", () => {
  const world: World = { metadata: { defaultViewMode: entry.mode } };
  const { result, rerender } = renderHook(
    ({ status }: { status: "loading" | "ready" | "error" }) =>
      useGameViewMode(world, {
        status,
        views: status === "error" ? [] : [entry],
      }),
    { initialProps: { status: "loading" as "loading" | "ready" | "error" } },
  );
  expect(result.current[0]).toBe("parsed");
  rerender({ status: "ready" });
  expect(result.current[0]).toBe(entry.mode);
  rerender({ status: "error" });
  expect(result.current[0]).toBe("parsed");
  expect(result.current[2].fellBack).toBe(true);
  rerender({ status: "ready" });
  expect(result.current[0]).toBe(entry.mode);
  act(() => result.current[1]("parsed"));
  rerender({ status: "ready" });
  expect(result.current[0]).toBe("parsed");
});
it("falls back to stage for a missing selection and ignores unknown choices", () => {
  const { result, rerender } = renderHook(
    ({ entries }) =>
      useGameViewMode(stageWorld, { status: "ready", views: entries }),
    { initialProps: { entries: [entry] } },
  );
  act(() => result.current[1]("plugin:unknown:view"));
  expect(result.current[0]).toBe("stage");
  act(() => result.current[1](entry.mode));
  expect(result.current[0]).toBe(entry.mode);
  rerender({ entries: [] });
  expect(result.current[0]).toBe("stage");
  expect(result.current[2].fellBack).toBe(true);
});
it("uses parsed for a missing world default and holds unconsented default views on the host", () => {
  const world: World = { metadata: { defaultViewMode: entry.mode } };
  const missing = renderHook(() =>
    useGameViewMode(world, { views: [], status: "ready" }),
  );
  expect(missing.result.current[0]).toBe("parsed");
  expect(missing.result.current[2].fellBack).toBe(true);
  const gated = renderHook(
    ({ allowed }) =>
      useGameViewMode(
        world,
        { views: [entry], status: "ready" },
        () => allowed,
      ),
    { initialProps: { allowed: false } },
  );
  expect(gated.result.current[0]).toBe("parsed");
  expect(gated.result.current[2].consentView).toBe(entry);
  gated.rerender({ allowed: true });
  expect(gated.result.current[0]).toBe(entry.mode);
});
