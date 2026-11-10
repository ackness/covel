import { describe, expect, it } from "vitest";
import {
  disabledDependents,
  resolveConfirmedSessionPlugins,
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
  it("names the missing contract and lists the dependents the player meant to have", () => {
    const plugins = [
      p("opening", { kind: "core", provides: ["opening@1"] }),
      p("creator", { kind: "core", requires: ["opening@1"] }),
      p("helper", { provides: ["helper@1"] }),
      p("asked", { requires: ["absent@1"] }),
      p("stray", { requires: ["absent@1"] }),
    ];
    const plan = resolveSessionPlugins({
      requested: ["asked"],
      excluded: ["opening"],
      plugins,
    });
    expect(plan.active).toEqual([]);
    expect(plan.rejected).toContainEqual(
      expect.objectContaining({
        pluginId: "creator",
        code: "missing-provider",
        contract: "opening@1",
      }),
    );
    // A core plugin and a requested one stay confirmed; a plugin nobody
    // asked for does not join.
    expect(
      disabledDependents(plan, { requested: ["asked"], plugins }).map(
        (item) => [item.pluginId, item.contract],
      ),
    ).toEqual([
      ["asked", "absent@1"],
      ["creator", "opening@1"],
    ]);
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
        p("a", { extensions: [{ point: "history.compact@2", id: "compact" }] }),
        p("b", { extensions: [{ point: "history.compact@2", id: "compact" }] }),
      ],
    });
    expect(plan.active).toEqual(["b"]);
    expect(plan.rejected[0]?.code).toBe("single-provider-conflict");
  });
  it("admits one story provider per session without a written conflict", () => {
    const plan = resolveSessionPlugins({
      requested: ["chat", "probe"],
      plugins: [
        p("chat", { provides: ["narrative-engine@2"] }),
        p("probe", { provides: ["narrative-engine@2"] }),
      ],
    });
    expect(plan.active).toEqual(["chat"]);
    expect(plan.rejected).toEqual([
      {
        pluginId: "probe",
        code: "single-provider-conflict",
        reason:
          "narrative-engine@2 admits one provider per session and chat already provides it",
        candidates: ["chat"],
      },
    ]);
  });
  it("lets a requested story provider replace the default one", () => {
    const plan = resolveSessionPlugins({
      requested: ["chat"],
      plugins: [
        p("narrator", {
          kind: "core",
          provides: [{ contract: "narrative-engine@2", default: true }],
        }),
        p("chat", { provides: ["narrative-engine@2"] }),
      ],
    });
    expect(plan.active).toEqual(["chat"]);
  });
  it.each([
    [
      "conflicts with an accepted package",
      p("chat", {
        provides: ["narrative-engine@2"],
        eventTopics: ["mood.set"],
      }),
      "event-topic-conflict",
    ],
    [
      "loses the provider it requires",
      p("chat", { provides: ["narrative-engine@2"], requires: ["memory@1"] }),
      "missing-provider",
    ],
  ])(
    "keeps the default story provider when its replacement %s",
    (_name, chat, code) => {
      const plan = resolveSessionPlugins({
        requested: ["mood", "chat"],
        plugins: [
          p("narrator", {
            kind: "core",
            provides: [{ contract: "narrative-engine@2", default: true }],
          }),
          p("mood", { eventTopics: ["mood.set"] }),
          // Joins as chat's dependency, then loses its topic to mood.
          p("memory", { provides: ["memory@1"], eventTopics: ["mood.set"] }),
          chat,
        ],
      });
      expect(plan.active).toEqual(["mood", "narrator"]);
      expect(plan.rejected.find((entry) => entry.pluginId === "chat")).toEqual(
        expect.objectContaining({ code }),
      );
      expect(plan.rejected.some((entry) => entry.pluginId === "narrator")).toBe(
        false,
      );
    },
  );
  it("ignores a written conflict on a single-provider framework contract", () => {
    const plan = resolveSessionPlugins({
      requested: ["reader", "narrator"],
      plugins: [
        p("reader", { conflicts: ["narrative-engine@2"] }),
        p("narrator", { provides: ["narrative-engine@2"] }),
      ],
    });
    expect(plan.active).toEqual(["reader", "narrator"]);
    expect(plan.rejected).toEqual([]);
  });
  it.each([
    ["story-memory", "fallback-story", "replacement-memory"],
    ["fallback-story", "story-memory", "replacement-memory"],
    ["replacement-memory", "fallback-story", "story-memory"],
  ])("settles overlapping default replacements in order %j", (...requested) => {
    const plugins = [
      p("story-memory", {
        provides: [
          "narrative-engine@2",
          { contract: "memory@1", default: true },
        ],
      }),
      p("fallback-story", {
        provides: [{ contract: "narrative-engine@2", default: true }],
        eventTopics: ["mood.set"],
      }),
      p("replacement-memory", {
        provides: ["memory@1"],
        requires: ["narrative-engine@2"],
        eventTopics: ["mood.set"],
      }),
      p("reader", { requires: ["memory@1"] }),
    ];
    for (const fixed of [false, true]) {
      const plan = resolveSessionPlugins({
        requested: [...requested, "reader"],
        plugins,
        fixed,
        requiredContracts: ["narrative-engine@2"],
      });
      expect(plan.active).toEqual(["story-memory", "reader"]);
      expect(plan.unmet).toEqual([]);
      expect(plan.rejected).toEqual([
        expect.objectContaining({
          pluginId: "replacement-memory",
          code: "missing-provider",
          contract: "narrative-engine@2",
        }),
        expect.objectContaining({
          pluginId: "fallback-story",
          code: "default-replaced",
        }),
      ]);
    }
  });
  it("settles packages that each replace a default contract of the other", () => {
    const plan = resolveSessionPlugins({
      requested: ["story-memory", "memory-story"],
      plugins: [
        p("story-memory", {
          provides: [
            "narrative-engine@2",
            { contract: "memory@1", default: true },
          ],
        }),
        p("memory-story", {
          provides: [
            "memory@1",
            { contract: "narrative-engine@2", default: true },
          ],
        }),
      ],
    });
    expect(plan.active).toEqual(["story-memory"]);
    expect(plan.rejected[0]).toMatchObject({
      pluginId: "memory-story",
      code: "default-replaced",
    });
  });
  it.each([false, true])(
    "restores consumers before pruning after a failed default replacement (fixed: %s)",
    (fixed) => {
      for (const requested of [
        ["default-story", "replacement-story", "reader", "dependent"],
        ["reader", "dependent", "replacement-story", "default-story"],
      ]) {
        const plan = resolveSessionPlugins({
          requested,
          fixed,
          plugins: [
            p("default-story", {
              provides: [
                { contract: "narrative-engine@2", default: true },
                "memory@1",
              ],
            }),
            p("replacement-story", {
              provides: ["narrative-engine@2"],
              requires: ["memory@1"],
            }),
            p("reader", { provides: ["reader@1"], requires: ["memory@1"] }),
            p("dependent", { requires: ["reader@1"] }),
          ],
        });
        expect([...plan.active].sort()).toEqual([
          "default-story",
          "dependent",
          "reader",
        ]);
        expect(plan.rejected).toEqual([
          expect.objectContaining({ pluginId: "replacement-story" }),
        ]);
      }
    },
  );
  it.each([false, true])(
    "restores consumers when a replacement loses a transitive requirement (fixed: %s)",
    (fixed) => {
      const plan = resolveSessionPlugins({
        requested: ["reader", "default-story", "replacement-story", "bridge"],
        fixed,
        plugins: [
          p("default-story", {
            provides: [
              { contract: "narrative-engine@2", default: true },
              "memory@1",
              "base@1",
            ],
          }),
          p("replacement-story", {
            provides: ["narrative-engine@2"],
            requires: ["bridge@1"],
          }),
          p("bridge", { provides: ["bridge@1"], requires: ["base@1"] }),
          p("reader", { requires: ["memory@1"] }),
        ],
      });
      expect(plan.active).toEqual(["reader", "default-story", "bridge"]);
      expect(plan.rejected).toEqual([
        expect.objectContaining({ pluginId: "replacement-story" }),
      ]);
    },
  );
  it.each(["narrative-engine@2", "story@1"])(
    "settles a replacement chain before removing the default %s provider",
    (contract) => {
      const plan = resolveSessionPlugins({
        requested: ["default-story", "story-memory", "memory-art", "art"],
        plugins: [
          p("default-story", { provides: [{ contract, default: true }] }),
          p("story-memory", {
            provides: [contract, { contract: "memory@1", default: true }],
          }),
          p("memory-art", {
            provides: ["memory@1", { contract: "art@1", default: true }],
          }),
          p("art", { provides: ["art@1"] }),
        ],
      });
      expect(plan.active).toEqual(["story-memory", "art"]);
      expect(plan.rejected).toEqual([
        expect.objectContaining({
          pluginId: "memory-art",
          code: "default-replaced",
        }),
        expect.objectContaining({
          pluginId: "default-story",
          code: "default-replaced",
        }),
      ]);
    },
  );
  it("keeps one declarer of an event topic and names both plugins", () => {
    const plugins = [
      p("stage", { eventTopics: ["scene.set", "stage.direction"] }),
      p("theatre", { eventTopics: ["scene.set"] }),
      p("music", { eventTopics: ["music.cue"] }),
    ];
    const plan = resolveSessionPlugins({
      requested: ["theatre", "stage", "music"],
      plugins,
    });
    expect(plan.active).toEqual(["theatre", "music"]);
    expect(plan.rejected).toEqual([
      {
        pluginId: "stage",
        code: "event-topic-conflict",
        reason:
          'Event topic "scene.set" is declared by both theatre and stage; a session can have one of them',
        candidates: ["theatre"],
      },
    ]);
    // Both stay installable: the collision exists only inside one session.
    expect(
      resolveSessionPlugins({ requested: ["stage", "music"], plugins })
        .rejected,
    ).toEqual([]);
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
  // A contract a package reads without requiring it activates no provider.
  it("activates only what a package requires", () =>
    expect(
      resolveSessionPlugins({
        requested: ["a"],
        plugins: [p("a"), p("b", { provides: ["b@1"] })],
      }).active,
    ).toEqual(["a"]));
});

describe("world-required contracts", () => {
  const dice = p("dice", { provides: ["check@1"], requires: ["rng@1"] });
  const rng = p("rng", { provides: ["rng@1"] });

  it("adds the only provider with its dependencies and keeps it after pruning", () => {
    const plan = resolveSessionPlugins({
      requested: [],
      requiredContracts: ["check@1"],
      plugins: [dice, rng, p("unrelated")],
    });
    expect(plan.active).toEqual(["dice", "rng"]);
    expect(plan.autoAdded).toEqual(["dice", "rng"]);
    expect(plan.unmet).toEqual([]);
  });

  it("lets a requested provider settle an otherwise ambiguous requirement", () => {
    const plugins = [
      p("d20", { provides: ["check@1"] }),
      p("d100", { provides: ["check@1"] }),
    ];
    expect(
      resolveSessionPlugins({
        requested: [],
        requiredContracts: ["check@1"],
        plugins,
      }).unmet,
    ).toEqual([
      {
        contract: "check@1",
        code: "ambiguous-provider",
        candidates: ["d20", "d100"],
      },
    ]);
    const chosen = resolveSessionPlugins({
      requested: ["d100"],
      requiredContracts: ["check@1"],
      plugins,
    });
    expect(chosen.active).toEqual(["d100"]);
    expect(chosen.unmet).toEqual([]);
  });

  it("separates a missing provider from one the player turned off", () => {
    expect(
      resolveSessionPlugins({
        requested: [],
        requiredContracts: ["check@1"],
        plugins: [rng],
      }).unmet,
    ).toEqual([{ contract: "check@1", code: "missing-provider" }]);

    const excluded = resolveSessionPlugins({
      requested: [],
      excluded: ["dice"],
      requiredContracts: ["check@1"],
      plugins: [dice, rng],
    });
    expect(excluded.active).toEqual([]);
    expect(excluded.unmet).toEqual([
      { contract: "check@1", code: "excluded", candidates: ["dice"] },
    ]);
  });

  it("never activates unapproved community code for the world", () => {
    const plan = resolveSessionPlugins({
      requested: [],
      requiredContracts: ["check@1"],
      plugins: [
        p("community-dice", {
          provides: ["check@1"],
          source: "community",
          authorized: false,
        }),
      ],
    });
    expect(plan.active).toEqual([]);
    expect(plan.unmet).toEqual([
      {
        contract: "check@1",
        code: "approval-required",
        candidates: ["community-dice"],
      },
    ]);
  });

  it("reports a provider that its own dependency dropped", () => {
    const plan = resolveSessionPlugins({
      requested: [],
      requiredContracts: ["check@1"],
      plugins: [dice],
    });
    expect(plan.active).toEqual([]);
    expect(plan.unmet).toEqual([
      { contract: "check@1", code: "missing-provider", candidates: ["dice"] },
    ]);
  });
});

describe("confirmed session plugin set", () => {
  it("keeps the confirmed set and adds no newly installed core package", () => {
    const plan = resolveConfirmedSessionPlugins({
      confirmed: ["narrator", "dice"],
      plugins: [
        p("narrator", { kind: "core", provides: ["narrative-engine@2"] }),
        p("dice"),
        p("new-core", { kind: "core" }),
      ],
    });
    expect(plan.active).toEqual(["narrator", "dice"]);
    expect(plan.autoAdded).toEqual([]);
    expect(plan.rejected).toEqual([]);
  });

  it("reports a member that is no longer installed and keeps the rest", () => {
    const plan = resolveConfirmedSessionPlugins({
      confirmed: ["narrator", "gone"],
      plugins: [p("narrator")],
    });
    expect(plan.active).toEqual(["narrator"]);
    expect(plan.rejected).toEqual([
      expect.objectContaining({ pluginId: "gone", code: "unknown-plugin" }),
    ]);
  });

  it("drops a member whose installed version needs a provider outside the set, without adding one", () => {
    const plan = resolveConfirmedSessionPlugins({
      confirmed: ["consumer"],
      plugins: [
        p("consumer", { requires: ["clock@1"] }),
        p("clock", { provides: ["clock@1"] }),
      ],
    });
    expect(plan.active).toEqual([]);
    expect(plan.rejected).toEqual([
      expect.objectContaining({
        pluginId: "consumer",
        code: "missing-provider",
      }),
    ]);
  });

  it("applies the installed versions' conflicts to the confirmed set", () => {
    const plan = resolveConfirmedSessionPlugins({
      confirmed: ["first", "second"],
      plugins: [
        p("first", { provides: ["engine@1"] }),
        p("second", { conflicts: ["engine@1"] }),
      ],
    });
    expect(plan.active).toEqual(["first"]);
    expect(plan.rejected).toEqual([
      expect.objectContaining({ pluginId: "second", code: "conflict" }),
    ]);
  });

  it("leaves approval to the trust gate", () => {
    const plan = resolveConfirmedSessionPlugins({
      confirmed: ["community"],
      plugins: [p("community", { source: "community" })],
    });
    expect(plan.active).toEqual(["community"]);
  });
});
