/**
 * `schedule.subagentOnly` (authored) and `subagentOnly` (IR): a sub-agent
 * provider is an agent runtime that is never scheduled. Each rule is
 * reported under the path its format writes.
 */
import { describe, expect, it } from "vitest";
import { runtimeManifestInputSchema } from "../src/schemas/plugin.js";
import { runtimeAuthoringManifestSchema } from "../src/schemas/runtime-manifest.js";

function authored(extra: Record<string, unknown> = {}) {
  const { schedule, ...rest } = extra as {
    schedule?: Record<string, unknown>;
  };
  return {
    description: "Gate guard",
    schedule: { subagentOnly: true, ...schedule },
    io: { output: { contract: "test-actor@1" } },
    ...rest,
  };
}

function compiled(extra: Record<string, unknown> = {}) {
  return {
    name: "probe/guard",
    description: "Gate guard",
    runtimeType: "agent",
    outputKind: "system",
    subagentOnly: true,
    trigger: { type: "manual" },
    outputContract: "test-actor@1",
    ...extra,
  };
}

function authoredIssues(value: unknown) {
  const result = runtimeAuthoringManifestSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
}

function compiledIssues(value: unknown) {
  const result = runtimeManifestInputSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => [issue.path.join("."), issue.message]);
}

describe("subagentOnly", () => {
  it("accepts an agent provider without a trigger or with trigger manual", () => {
    expect(authoredIssues(authored())).toEqual([]);
    expect(
      authoredIssues(authored({ schedule: { trigger: { type: "manual" } } })),
    ).toEqual([]);
    expect(compiledIssues(compiled())).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "a function runtime",
      { function: { handler: "./handler.js" } },
      "schedule.subagentOnly",
    ],
    ["a story", { io: { visibility: "story" } }, "io.visibility"],
    ["a stage", { schedule: { stage: "narrative" } }, "schedule.stage"],
    ["needs", { schedule: { needs: ["probe/other"] } }, "schedule.needs"],
    ["after", { schedule: { after: ["probe/other"] } }, "schedule.after"],
    [
      "an auto trigger",
      { schedule: { trigger: { type: "auto" } } },
      "schedule.trigger.type",
    ],
    [
      "an event trigger",
      { schedule: { trigger: { type: "event", topic: "x" } } },
      "schedule.trigger.type",
    ],
    ["background", { schedule: { background: true } }, "schedule.background"],
    [
      "recordAs",
      {
        io: {
          output: {
            contract: "test-actor@1",
            schema: "./out.json",
            recordAs: "line",
          },
        },
      },
      "io.output.recordAs",
    ],
    ["a guard", { guard: "./guard.js" }, "guard"],
  ])("rejects %s on the authored schema", (_name, extra, path) => {
    const issues = authoredIssues(authored(extra));
    expect(issues.map(([at]) => at)).toContain(path);
    expect(issues.find(([at]) => at === path)?.[1]).toContain(
      "sub-agent-only runtime",
    );
  });

  it.each<[string, Record<string, unknown>, string]>([
    [
      "a function runtime",
      { runtimeType: "function", handler: "./h.js" },
      "subagentOnly",
    ],
    ["a story", { outputKind: "story" }, "outputKind"],
    ["a stage", { stage: "narrative" }, "stage"],
    ["needs", { needs: ["probe/other"] }, "needs"],
    ["after", { after: ["probe/other"] }, "after"],
    ["an auto trigger", { trigger: { type: "auto" } }, "trigger.type"],
    ["background", { execution: "background" }, "execution"],
    [
      "recordAs",
      { output: { schema: "./out.json", recordAs: "line" } },
      "output.recordAs",
    ],
    ["a guard", { guard: "./guard.js" }, "guard"],
  ])("rejects %s on the IR", (_name, extra, path) => {
    const issues = compiledIssues(compiled(extra));
    expect(issues.map(([at]) => at)).toContain(path);
  });

  it("keeps the IR flag to true only", () => {
    expect(compiledIssues(compiled({ subagentOnly: false }))).not.toEqual([]);
  });
});
