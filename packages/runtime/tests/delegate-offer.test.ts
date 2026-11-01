import { describe, expect, it } from "vitest";
import type { LLMToolDefinition, RuntimeManifest } from "@covel/shared";
import { validateOutput } from "@covel/tools";
import {
  fixture,
  fn,
  story,
  tell,
  input,
} from "./_helpers/world-read-fixture.js";
import { submitted } from "./_helpers/agent-loop-fixture.js";
import { createSubagentRunner } from "../src/agent-loop/subagent-runner.js";
import { withSubagentDelegate } from "../src/agent-loop/subagent-delegate.js";
import { createExecutionContext } from "../src/turn-executor/execution-context.js";
import { executeToolSearch } from "../src/agent-loop/tool-search.js";

const names = ["delegate", "delegate-batch"] as const;
const parent = fn("parent", {
  runtimeType: "agent",
  tools: { builtin: [...names] },
});
const worker = (id: string, extra: Partial<RuntimeManifest> = {}) =>
  fn(
    "worker",
    {
      runtimeType: "agent",
      subagentOnly: true,
      stage: undefined,
      trigger: { type: "manual" },
      outputContract: `test.${id}@1`,
      ...extra,
    },
    id,
  );
const providers = [worker("first"), worker("second")];
const request = (target: object) => ({ target, brief: "Answer briefly" });
const parameters = (name: string, target: object) =>
  name === "delegate" ? request(target) : { requests: [request(target)] };

describe("delegation tool offers", () => {
  it.each(names.flatMap((name) => [0, 1, 2].map((count) => ({ name, count }))))(
    "offers $name with $count reachable contracts",
    async ({ name, count }) => {
      let offered: readonly LLMToolDefinition[] = [];
      const f = await fixture({
        deps: {
          llm: {
            generate: async (r) => {
              offered = r.tools ?? [];
              return submitted("Done");
            },
          },
        },
      });
      const result = await f.execute(
        [story, parent, ...providers.slice(0, count)],
        { [story.name]: tell },
      );
      expect(result.resultOf(parent).status).toBe("success");
      const definition = offered.find((t) => t.name === name);
      if (count === 0) {
        expect(definition).toBeUndefined();
        return;
      }
      expect(definition).toBeDefined();
      for (const [index, provider] of providers.entries()) {
        expect(
          validateOutput(
            parameters(name, { contract: provider.outputContract }),
            definition!.parameters,
          ).valid,
        ).toBe(index < count);
        expect(
          validateOutput(
            parameters(name, { runtimeId: provider.name }),
            definition!.parameters,
          ).valid,
        ).toBe(false);
      }
      expect(
        validateOutput(
          parameters(name, { contract: "test.missing@1" }),
          definition!.parameters,
        ).valid,
      ).toBe(false);
    },
  );

  it.each(names)("search offers %s only for eligible targets", async (name) => {
    const local = worker(parent.pluginId, { outputContract: undefined });
    const ambiguous = worker("ambiguous");
    const paused = worker("paused");
    const f = await fixture();
    const runner = createSubagentRunner({
      activeRuntimes: [
        local,
        providers[0]!,
        ambiguous,
        worker("duplicate", { outputContract: ambiguous.outputContract }),
        worker("mixed"),
        worker("function", { runtimeType: "function" }),
        worker("scheduled", { subagentOnly: undefined }),
        worker("presentation", { presentation: { budget: {} } }),
      ],
      pausedRuntimes: [
        paused,
        worker("paused-duplicate", { outputContract: "test.mixed@1" }),
      ],
    });
    const executor = withSubagentDelegate(f.baseDeps.toolExecutor!, runner, {
      caller: { pluginId: parent.pluginId, runtimeId: parent.name, depth: 0 },
      input,
      deps: f.baseDeps,
      executionContext: createExecutionContext(input),
    });
    const search = executeToolSearch({
      argumentsJson: JSON.stringify({ query: "sub-agent", limit: 2 }),
      deferredNames: new Set(names),
      activeNames: new Set(),
      toolExecutor: executor,
      context: { ...input, pluginId: parent.pluginId, runtimeId: parent.name },
    });
    const definition = search.activated.find((t) => t.name === name);
    expect(definition).toBeDefined();
    for (const target of [
      { runtimeId: local.name },
      { contract: providers[0]!.outputContract },
    ])
      expect(
        validateOutput(parameters(name, target), definition!.parameters).valid,
      ).toBe(true);
    for (const contract of [
      "ambiguous",
      "mixed",
      "paused",
      "function",
      "scheduled",
      "presentation",
      "missing",
    ])
      expect(
        validateOutput(
          parameters(name, { contract: `test.${contract}@1` }),
          definition!.parameters,
        ).valid,
      ).toBe(false);
  });

  it("keeps unavailable delegation tools out of deferred search", async () => {
    const f = await fixture();
    const executor = withSubagentDelegate(
      f.baseDeps.toolExecutor!,
      createSubagentRunner({ activeRuntimes: [] }),
      {
        caller: { pluginId: parent.pluginId, runtimeId: parent.name, depth: 0 },
        input,
        deps: f.baseDeps,
        executionContext: createExecutionContext(input),
      },
    );
    expect(
      executeToolSearch({
        argumentsJson: JSON.stringify({ query: "sub-agent", limit: 2 }),
        deferredNames: new Set(names),
        activeNames: new Set(),
        toolExecutor: executor,
        context: {
          ...input,
          pluginId: parent.pluginId,
          runtimeId: parent.name,
        },
      }).activated,
    ).toEqual([]);
  });

  it.each(names)(
    "keeps %s not-found safe after an offered provider disappears",
    async (name) => {
      const activeRuntimes = [providers[0]!];
      const f = await fixture();
      const executor = withSubagentDelegate(
        f.baseDeps.toolExecutor!,
        createSubagentRunner({ activeRuntimes }),
        {
          caller: {
            pluginId: parent.pluginId,
            runtimeId: parent.name,
            depth: 0,
          },
          input,
          deps: f.baseDeps,
          executionContext: createExecutionContext(input),
        },
      );
      const context = {
        ...input,
        pluginId: parent.pluginId,
        runtimeId: parent.name,
        authorizedToolNames: new Set(names),
      };
      expect(executor.getToolInfo(name, context)).toBeDefined();
      activeRuntimes.length = 0;
      const result = await executor.execute(
        {
          name,
          toolCallId: "gone",
          arguments: JSON.stringify(
            parameters(name, { contract: "test.first@1" }),
          ),
        },
        context,
      );
      expect(JSON.parse(result.result)).toMatchObject(
        name === "delegate"
          ? { error: { code: "not-found" } }
          : {
              data: { results: [{ ok: false, error: { code: "not-found" } }] },
            },
      );
    },
  );
});
