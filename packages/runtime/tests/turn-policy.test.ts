import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { policies, directorPolicy } from "./_helpers/orchestration-fixture.js";
import { restartSessionRandom } from "../src/function-runtime/plugin-random.js";
import type { PluginServiceGateway } from "@covel/plugin-handlers-utils";
import {
  TURN_POLICY_CONTRACT,
  turnPolicyInputSchema,
  turnPolicyOutputSchema,
} from "@covel/shared";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { DelegationBudget } from "../src/orchestration/delegation-budget.js";
import {
  policyModelRequest,
  policyModelResult,
} from "../src/orchestration/policy-tools.js";

const request = {
  actions: [],
  present: [
    { characterId: "a", name: "Mara" },
    { characterId: "b", name: "Ivo" },
  ],
  recentSegments: [],
};
const plan = {
  actors: [{ characterId: "a" }, { characterId: "b" }],
  order: "parallel",
  narrator: "after",
  yieldHint: "user",
} as const;
afterEach(() => {
  vi.unstubAllEnvs();
  restartSessionRandom("s");
});
function registry(paused: string[] = []) {
  return new PluginServiceRegistry({
    list: async () =>
      ["caller", "provider"].filter((id) => !paused.includes(id)),
    paused: async () => paused,
    ensure: async (_session, id) => {
      if (paused.includes(id)) throw new Error("paused");
    },
  });
}
function register(
  services: PluginServiceRegistry,
  name: string,
  modelFacing = true,
) {
  services.register("provider", {
    name,
    contract: TURN_POLICY_CONTRACT,
    modelFacing,
    description: name,
    input: turnPolicyInputSchema,
    output: turnPolicyOutputSchema,
    handler: () => turnPolicyOutputSchema.parse(plan),
  });
}
function caller(delegation = new DelegationBudget({ sessionId: "s" })) {
  return {
    sessionId: "s",
    pluginId: "caller",
    signal: new AbortController().signal,
    delegation,
  };
}
describe("turn policy selection", () => {
  it("uses exact service identity and keeps discovery unfiltered", async () => {
    const services = registry();
    register(services, "first");
    register(services, "second");
    await expect(
      services
        .createClient(caller())
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).rejects.toMatchObject({ code: "unavailable" });
    const selected = caller(
      new DelegationBudget({
        sessionId: "s",
        settings: { turnPolicy: { pluginId: "provider", name: "second" } },
      }),
    );
    expect(
      await services.resolveImport(selected, TURN_POLICY_CONTRACT),
    ).toMatchObject({ status: "ready", name: "second" });
    expect(
      await services.createClient(selected).discover(TURN_POLICY_CONTRACT),
    ).toHaveLength(2);
    expect(
      await services
        .createClient(selected)
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).toEqual(plan);
  });
  it("does not replace a selected code-only or paused provider", async () => {
    const services = registry();
    register(services, "hidden", false);
    register(services, "visible");
    const selected = caller(
      new DelegationBudget({
        sessionId: "s",
        settings: { turnPolicy: { pluginId: "provider", name: "hidden" } },
      }),
    );
    expect(
      await services.resolveImport(selected, TURN_POLICY_CONTRACT),
    ).toMatchObject({ status: "not-model-facing" });
    const paused = registry(["provider"]);
    register(paused, "hidden", false);
    await expect(
      paused
        .createClient(selected)
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("bounds both explicit and contract-only calls without reserving", async () => {
    const services = registry();
    register(services, "plan");
    const scope = caller(
      new DelegationBudget({
        sessionId: "s",
        settings: { maxActors: 1, maxSubagentCalls: 1 },
      }),
    );
    const client = services.createClient(scope);
    for (const target of [
      { contract: TURN_POLICY_CONTRACT },
      { contract: TURN_POLICY_CONTRACT, pluginId: "provider", name: "plan" },
    ]) {
      expect(
        await client.call({
          ...target,
          input: {
            ...request,
            limits: { maxActors: 16, maxSubagentCalls: 64 },
          },
        }),
      ).toEqual({ ...plan, actors: [{ characterId: "a" }] });
    }
    expect(scope.delegation.snapshot().calls).toBe(0);
  });
  it("rejects invalid plans even through permissive provider parsers", async () => {
    const services = registry();
    services.register("provider", {
      name: "bad",
      contract: TURN_POLICY_CONTRACT,
      input: { parse: (value) => value },
      output: { parse: (value) => value },
      handler: () => ({ ...plan, actors: [{ characterId: "secret" }] }),
    });
    await expect(
      services
        .createClient(caller())
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).rejects.toThrow(/output failed validation/);
  });
  it("adapts names and refuses semantic IDs before invoking a provider", () => {
    const world = {
      characterSchema: null,
      characters: [
        {
          id: "semantic-id",
          name: "Mara",
          aliases: ["Captain"],
          type: "npc",
          sessionId: "s",
          version: 1,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
      dimensions: {},
      seats: [],
    };
    const input = policyModelRequest(
      { present: ["Captain"], recentSegments: [] },
      world,
      [],
    );
    expect(input.present).toEqual([
      { characterId: "semantic-id", name: "Mara" },
    ]);
    expect(() =>
      policyModelRequest(
        { present: ["semantic-id"], recentSegments: [] },
        world,
        [],
      ),
    ).toThrow(/No character/);
    const model = policyModelResult(
      { ...plan, actors: [{ characterId: "semantic-id" }] },
      input.present,
    );
    expect(JSON.stringify(model)).not.toContain("semantic-id");
    expect(model.actors).toEqual([{ character: "Mara" }]);
  });
  it("keeps the frozen exact choice in nested calls and registration snapshots", async () => {
    const services = registry();
    register(services, "first");
    register(services, "second");
    services.register("provider", {
      name: "bridge",
      contract: "bridge@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: async (_input, ctx) =>
        ctx.services.call({ contract: TURN_POLICY_CONTRACT, input: request }),
    });
    const settings = { turnPolicy: { pluginId: "provider", name: "second" } };
    const scope = caller(new DelegationBudget({ sessionId: "s", settings }));
    settings.turnPolicy.name = "missing";
    await services.withSnapshot(async () => {
      services.replacePlugin("provider", () =>
        register(services, "replacement"),
      );
      expect(
        await services.createClient(scope).call({
          pluginId: "provider",
          name: "bridge",
          contract: "bridge@1",
          input: {},
        }),
      ).toEqual(plan);
    });
    await expect(
      services
        .createClient(scope)
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(
      await services
        .createClient(caller())
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).toEqual(plan);
  });
  it("counts paused providers across packages and rechecks authorization after advertisement", async () => {
    let revoked = false;
    const services = new PluginServiceRegistry({
      list: async () => ["caller", "provider"],
      paused: async () => ["alternate"],
      ensure: async (_session, id) => {
        if (revoked && id === "provider") throw new Error("Revoked");
      },
    });
    register(services, "first");
    services.register("alternate", { ...policies[0]!, name: "other" });
    expect(
      await services.resolveImport(caller(), TURN_POLICY_CONTRACT),
    ).toMatchObject({ status: "ambiguous" });
    const scope = caller(
      new DelegationBudget({
        sessionId: "s",
        settings: { turnPolicy: { pluginId: "provider", name: "first" } },
      }),
    );
    expect(
      await services.resolveImport(scope, TURN_POLICY_CONTRACT),
    ).toMatchObject({ status: "ready", pluginId: "provider" });
    revoked = true;
    await expect(
      services
        .createClient(scope)
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).rejects.toThrow("Revoked");
  });
  it("keeps read-service random streams seeded and provider scoped", async () => {
    vi.stubEnv("COVEL_RANDOM_SEED", "policy-seed");
    const services = new PluginServiceRegistry({
      list: async () => ["caller", "provider", "other"],
      ensure: async () => {},
    });
    services.register("provider", policies[1]!);
    services.register("other", policies[1]!);
    const client = services.createClient(caller());
    const draw = (pluginId: string) =>
      client.call({
        pluginId,
        name: "draw",
        contract: TURN_POLICY_CONTRACT,
        input: request,
      });
    const first = [];
    for (let i = 0; i < 12; i++) first.push(await draw("provider"));
    restartSessionRandom("s");
    const interleaved = [];
    for (let i = 0; i < 12; i++) {
      await draw("other");
      interleaved.push(await draw("provider"));
    }
    expect(interleaved).toEqual(first);
    expect(new Set(first.map((value) => JSON.stringify(value))).size).toBe(2);
  });
  it("lets a director use a code-lent gateway but handles absent tool gateways", async () => {
    const services = registry();
    services.register("provider", directorPolicy);
    await expect(
      services
        .createClient(caller())
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).rejects.toMatchObject({ code: "unavailable" });
    const gateway: PluginServiceGateway = {
      resolveSlot: () => null,
      generateText: async () => {
        throw new Error("No model request expected");
      },
      generateObject: async () => {
        throw new Error("No model request expected");
      },
    };
    expect(
      await services
        .createClient({ ...caller(), gateway })
        .call({ contract: TURN_POLICY_CONTRACT, input: request }),
    ).toMatchObject({ actors: [{ characterId: "a" }] });
  });
});
