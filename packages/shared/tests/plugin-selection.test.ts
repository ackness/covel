import { describe, expect, it } from "vitest";
import {
  resolveSessionPlugins,
  type SessionPluginCandidate,
} from "../src/plugin-selection.js";
const p = (
  id: string,
  extra: Partial<SessionPluginCandidate> = {},
): SessionPluginCandidate => ({
  id,
  kind: "plugin",
  source: "builtin",
  authorized: true,
  ...extra,
});
describe("session plugin contract resolution", () => {
  it("adds recursive authorized requirements and terminates cycles", () => {
    const plan = resolveSessionPlugins({
      requested: ["a"],
      plugins: [
        p("a", { provides: ["a@1"], requires: ["b@1"] }),
        p("b", { provides: ["b@1"], requires: ["a@1"] }),
      ],
    });
    expect(plan.active).toEqual(["a", "b"]);
    expect(plan.autoAdded).toEqual(["b"]);
  });
  it.each([
    ["prompt.segment@1", { point: "prompt.segment@1", id: "segment" }],
    [
      "character.visual@1",
      { point: "ui.slot@1", id: "visual", slot: "character.visual@1" },
    ],
  ])(
    "resolves %s from extension implementations instead of bare provides",
    (contract, extension) => {
      const plan = resolveSessionPlugins({
        requested: ["consumer"],
        plugins: [
          p("consumer", { requires: [contract] }),
          p("claim", { provides: [contract] }),
          p("implementation", { extensions: [extension] }),
        ],
      });
      expect(plan.active).toEqual(["consumer", "implementation"]);
      expect(plan.autoAdded).toEqual(["implementation"]);
    },
  );
  it("does not treat a different UI slot as a matching implementation", () => {
    const plan = resolveSessionPlugins({
      requested: ["consumer"],
      plugins: [
        p("consumer", { requires: ["character.visual@1"] }),
        p("claim", { provides: ["character.visual@1"] }),
        p("backdrop", {
          extensions: [
            { point: "ui.slot@1", id: "backdrop", slot: "stage.backdrop@1" },
          ],
        }),
      ],
    });
    expect(plan.active).toEqual([]);
    expect(plan.rejected[0]?.code).toBe("missing-provider");
  });
  it("honors authorization and exclusions for extension dependencies", () => {
    const plugins = [
      p("consumer", { requires: ["prompt.segment@1"] }),
      p("implementation", {
        source: "community",
        authorized: false,
        extensions: [{ point: "prompt.segment@1", id: "prompt" }],
      }),
    ];
    expect(
      resolveSessionPlugins({ requested: ["consumer"], plugins }).rejected[0]
        ?.code,
    ).toBe("approval-required");
    expect(
      resolveSessionPlugins({
        requested: ["consumer"],
        excluded: ["implementation"],
        plugins,
      }).rejected[0]?.code,
    ).toBe("missing-provider");
  });
  it("allows explicitly declared dependencies on a package's own output", () => {
    expect(
      resolveSessionPlugins({
        requested: ["self"],
        plugins: [
          p("self", {
            provides: ["own@1"],
            requires: ["own@1"],
            optional: ["own@1"],
          }),
        ],
      }).active,
    ).toEqual(["self"]);
  });
  it("honors explicit exclusions including core defaults", () => {
    const plan = resolveSessionPlugins({
      requested: ["consumer"],
      excluded: ["core"],
      plugins: [
        p("core", { kind: "core", provides: ["data@1"] }),
        p("consumer", { requires: ["data@1"] }),
      ],
    });
    expect(plan.active).toEqual([]);
    expect(plan.rejected.find((r) => r.pluginId === "consumer")?.code).toBe(
      "missing-provider",
    );
  });
  it("never auto-adds unauthorized community code", () => {
    const plan = resolveSessionPlugins({
      requested: ["consumer", "foreign"],
      plugins: [
        p("consumer", { requires: ["data@1"] }),
        p("foreign", {
          source: "community",
          authorized: false,
          provides: ["data@1"],
        }),
      ],
    });
    expect(plan.active).toEqual([]);
    expect(plan.rejected.find((r) => r.pluginId === "foreign")?.code).toBe(
      "approval-required",
    );
  });
  it("selects the unique default when non-default candidates are ambiguous", () => {
    const plan = resolveSessionPlugins({
      requested: ["consumer"],
      plugins: [
        p("consumer", { requires: ["data@1"] }),
        p("one", { provides: ["data@1"] }),
        p("two", { provides: ["data@1"] }),
        p("default", { provides: [{ contract: "data@1", default: true }] }),
      ],
    });
    expect(plan.active).toEqual(["consumer", "default"]);
  });
  it("reports ambiguous candidates rather than choosing by registry order", () => {
    const plan = resolveSessionPlugins({
      requested: ["consumer"],
      plugins: [
        p("consumer", { requires: ["data@1"] }),
        p("one", { provides: ["data@1"] }),
        p("two", { provides: ["data@1"] }),
      ],
    });
    expect(plan.rejected[0]).toMatchObject({
      code: "ambiguous-provider",
      candidates: ["one", "two"],
    });
  });
  it("lets a selected non-default replace a default", () => {
    const plan = resolveSessionPlugins({
      requested: ["replacement"],
      plugins: [
        p("core", {
          kind: "core",
          provides: [{ contract: "story@1", default: true }],
        }),
        p("replacement", { provides: ["story@1"] }),
      ],
    });
    expect(plan.active).toEqual(["replacement"]);
  });
  it("keeps explicit requests over auto dependencies and prunes consumers", () => {
    const plan = resolveSessionPlugins({
      requested: ["consumer", "explicit"],
      plugins: [
        p("consumer", { requires: ["data@1"] }),
        p("dependency", { provides: ["data@1"], conflicts: ["choice@1"] }),
        p("explicit", { provides: ["choice@1"] }),
      ],
    });
    expect(plan.active).toEqual(["explicit"]);
    expect(plan.rejected.find((r) => r.pluginId === "consumer")?.code).toBe(
      "missing-provider",
    );
  });
  it("enforces single extension composition and stable requested priority", () => {
    const plan = resolveSessionPlugins({
      requested: ["b", "a"],
      plugins: [
        p("a", { extensions: [{ point: "history.compact@1", id: "compact" }] }),
        p("b", { extensions: [{ point: "history.compact@1", id: "compact" }] }),
      ],
    });
    expect(plan.active).toEqual(["b"]);
    expect(plan.rejected[0]?.code).toBe("single-provider-conflict");
  });
  it("rejects invalid kernel conflicts without suppressing collect providers", () => {
    const plan = resolveSessionPlugins({
      requested: ["invalid", "one", "two"],
      plugins: [
        p("invalid", { conflicts: ["prompt.segment@1"] }),
        p("one", { extensions: [{ point: "prompt.segment@1", id: "one" }] }),
        p("two", { extensions: [{ point: "prompt.segment@1", id: "two" }] }),
      ],
    });
    expect(plan.active).toEqual(["one", "two"]);
    expect(plan.rejected).toEqual([
      expect.objectContaining({
        pluginId: "invalid",
        code: "invalid-conflict",
        path: ["conflicts", 0],
      }),
    ]);
  });
  it("does not activate optional recommendations", () =>
    expect(
      resolveSessionPlugins({
        requested: ["a"],
        plugins: [p("a", { optional: ["b@1"] }), p("b", { provides: ["b@1"] })],
      }).active,
    ).toEqual(["a"]));
});
