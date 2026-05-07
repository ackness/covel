import { describe, expect, it } from "vitest";
import { getPendingProposals } from "@covel/tools";
import handler from "../handler.js";

function ctx(manualPayload) {
  return {
    sessionId: "sess-rules",
    turnId: "turn-rules",
    pluginId: "living-world-rules",
    runtimeId: "living-world-rules",
    playerMessage: "",
    store: {},
    completedResults: new Map(),
    config: {},
    manualPayload,
  };
}

describe("living-world-rules handler", () => {
  it("saves a constant rule and emits lorebook.upsert", async () => {
    const result = await handler(
      ctx({
        rule: {
          schemaVersion: 1,
          id: "rain-market",
          title: "Rain Market",
          content: "雨市里没人会直接说出真实姓名。",
          kind: "constant",
          category: "world",
          coordinate: { position: "before_plugin" },
          budgetClass: "sticky",
        },
      }),
    );

    expect(result).toEqual({
      saved: true,
      ruleId: "rain-market",
      lorebookEntryId: "lwr-rain-market",
    });

    const proposals = getPendingProposals(result);
    expect(proposals.map((proposal) => proposal.type)).toEqual([
      "plugin.data",
      "lorebook.upsert",
    ]);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      payload: {
        namespace: "rules",
        key: "rain-market",
        value: {
          lorebookEntryId: "lwr-rain-market",
          rule: {
            id: "rain-market",
            content: "雨市里没人会直接说出真实姓名。",
            kind: "constant",
            coordinate: { position: "before_plugin" },
          },
        },
      },
    });
    expect(proposals[1]).toMatchObject({
      type: "lorebook.upsert",
      payload: {
        entries: [
          {
            id: "lwr-rain-market",
            content: "雨市里没人会直接说出真实姓名。",
            strategy: "constant",
            position: "before_plugin",
            insertionOrder: 500,
            enabled: true,
            keys: [],
            extra: {
              kind: "constant",
              title: "Rain Market",
              category: "world",
              coordinate: { position: "before_plugin" },
              budgetClass: "sticky",
              sourceRuleId: "rain-market",
            },
          },
        ],
      },
    });
  });

  it("maps triggered rules to selective lorebook entries", async () => {
    const result = await handler(
      ctx({
        ruleJson: JSON.stringify({
          schemaVersion: 1,
          id: "sealed-door",
          content: "封印门只回应血脉、月光和旧誓。",
          kind: "triggered",
          keys: ["封印门", "月光"],
          coordinate: { position: "at_depth", depth: 2 },
          insertionOrder: 20,
        }),
      }),
    );

    const proposals = getPendingProposals(result);
    expect(proposals[1]).toMatchObject({
      type: "lorebook.upsert",
      payload: {
        entries: [
          {
            id: "lwr-sealed-door",
            strategy: "selective",
            position: "at_depth",
            insertionOrder: 20,
            keys: ["封印门", "月光"],
            extra: {
              kind: "triggered",
              coordinate: { position: "at_depth", depth: 2 },
            },
          },
        ],
      },
    });
  });

  it("accepts structured rule form payloads", async () => {
    const result = await handler(
      ctx({
        ruleForm: {
          id: "club-room",
          title: "活动室门禁",
          content: "文艺部活动室在放学后只允许社员进入。",
          kind: "triggered",
          category: "scene",
          keysText: "文艺部, 活动室",
          position: "before_plugin",
          budgetClass: "sticky",
          insertionOrder: "80",
        },
      }),
    );

    expect(result).toEqual({
      saved: true,
      ruleId: "club-room",
      lorebookEntryId: "lwr-club-room",
    });
    const proposals = getPendingProposals(result);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      payload: {
        namespace: "rules",
        key: "club-room",
        value: {
          rule: {
            schemaVersion: 1,
            id: "club-room",
            title: "活动室门禁",
            content: "文艺部活动室在放学后只允许社员进入。",
            kind: "triggered",
            category: "scene",
            keys: ["文艺部", "活动室"],
            coordinate: { position: "before_plugin" },
            budgetClass: "sticky",
            insertionOrder: 80,
          },
        },
      },
    });
    expect(proposals[1]).toMatchObject({
      type: "lorebook.upsert",
      payload: {
        entries: [
          {
            id: "lwr-club-room",
            strategy: "selective",
            position: "before_plugin",
            insertionOrder: 80,
            enabled: true,
            keys: ["文艺部", "活动室"],
          },
        ],
      },
    });
  });

  it("can save structured rule form payloads as disabled", async () => {
    const result = await handler(
      ctx({
        enabled: false,
        ruleForm: {
          id: "old-rule",
          content: "旧规则暂时停用。",
        },
      }),
    );

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value.rule.enabled).toBe(false);
    expect(proposals[1].payload.entries[0].enabled).toBe(false);
  });

  it("generates short rule ids when structured forms leave id blank", async () => {
    const result = await handler(
      ctx({
        ruleForm: {
          title: "Club Room Rule",
          content: "文艺部活动室只允许社员进入。",
        },
      }),
    );

    expect(result).toEqual({
      saved: true,
      ruleId: "rule-club-room-rule",
      lorebookEntryId: "lwr-rule-club-room-rule",
    });
  });

  it("rejects malformed rules", async () => {
    await expect(handler(ctx({ ruleJson: "{bad json" }))).rejects.toThrow(
      "manualPayload.ruleJson must be valid JSON",
    );
    await expect(
      handler(ctx({ rule: { id: "missing-content" } })),
    ).rejects.toThrow("rule.content must be a non-empty string");
    await expect(
      handler(
        ctx({
          rule: { schemaVersion: 1, id: "../escape", content: "bad" },
        }),
      ),
    ).rejects.toThrow("rule.id must be 1-128 characters");
    await expect(
      handler(
        ctx({
          rule: {
            schemaVersion: 1,
            id: "large-rule",
            content: "x".repeat(70_000),
          },
        }),
      ),
    ).rejects.toThrow("rule is too large");
  });
});
