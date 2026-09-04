import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Deterministic, no-LLM API coverage of the framework `submit-form` default
 * over a real server bootstrap: exercises the session.locale → handler
 * localization chain and batch / validation paths end-to-end. Complements the
 * in-process plugin-rpc.test.ts (mock setup) with true server wiring. Seeds a
 * committed interaction through the memory backend's public browser-checkpoint
 * API, while omitting narrative templates so the handler takes its deterministic
 * fallbackNarrative path (no LLM).
 */

test.describe.configure({ mode: "serial" });

interface CreatedSession {
  id: string;
  worldId: string;
  locale: string;
  status: string;
  phase: string;
  completedPlayerTurns: number;
  setupRuntimes: Record<string, unknown>;
  activePlugins: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

async function createSession(
  request: APIRequestContext,
  locale: string,
): Promise<CreatedSession> {
  const res = await request.post("/api/sessions", {
    // mistport's worldData targets living-world-rules, so it must be active.
    data: {
      worldId: "mistport",
      locale,
      plugins: [
        "pregame",
        "world-init",
        "char-creator",
        "narrator",
        "guide",
        "codex",
        "npc-graph",
        "living-world-rules",
        "character-blueprint",
      ],
    },
  });
  const responseBody = await res.text();
  expect(
    res.ok(),
    `create session failed: ${res.status()} ${responseBody}`,
  ).toBeTruthy();
  return JSON.parse(responseBody) as CreatedSession;
}

async function seedCommittedInteractions(
  request: APIRequestContext,
  session: CreatedSession,
  interactions: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const committedAt = new Date().toISOString();
  const res = await request.put(
    `/api/sessions/${session.id}/browser-checkpoint`,
    {
      data: {
        checkpoint: {
          schemaVersion: 2,
          sessionId: session.id,
          profile: "browser-private",
          revision: 1,
          actionId: `seed-interactions-${session.id}`,
          committedAt,
          session,
          world: null,
          messages: [],
          turnMessages: [
            {
              id: `interaction-fixture-${session.id}`,
              sessionId: session.id,
              turnId: "turn-1",
              sourceType: "runtime",
              sourcePluginId: "framework",
              sourceRuntimeId: "e2e-interaction-fixture",
              role: "assistant",
              name: "e2e-interaction-fixture",
              content: "",
              pendingInput: interactions,
              order: 0,
              createdAt: committedAt,
            },
          ],
          turnResults: [],
          runtimeResults: [],
          toolCalls: [],
          runtimeOutputs: [],
          interactions: [],
          events: [],
          traceEvents: [],
          characters: [],
          pluginData: [],
          workingMemory: [],
          lorebookEntries: [],
          sessionSummaries: [],
          playerInputs: [],
          suspensions: [],
          snapshots: [],
          worldDataLedger: [],
          logicalTurnLedger: [],
          setupAttempts: [],
          jobStatus: [],
          runtimeExports: [],
        },
      },
    },
  );
  const responseBody = await res.text();
  expect(
    res.ok(),
    `seed interactions failed: ${res.status()} ${responseBody}`,
  ).toBeTruthy();
}

function submitForm(
  request: APIRequestContext,
  sessionId: string,
  submissions: ReadonlyArray<Record<string, unknown>>,
) {
  return request.post(`/api/sessions/${sessionId}/plugin-rpc`, {
    data: {
      kind: "action",
      pluginId: "framework",
      action: "submit-form",
      payload: { turnId: "turn-1", submissions },
    },
  });
}

test.describe("Interaction submit-form (API-level, deterministic)", () => {
  test("choice fallback narrative carries the localized zh-CN prefix", async ({
    request,
  }) => {
    const session = await createSession(request, "zh-CN");
    await seedCommittedInteractions(request, session, [
      {
        interactionId: "no-tpl",
        type: "choice",
        prompt: "Choose an action",
        choices: [{ id: "a", label: "Attack" }],
      },
    ]);
    const res = await submitForm(request, session.id, [
      {
        interactionId: "no-tpl",
        type: "choice",
        values: { selectedId: "a" },
      },
    ]);
    const responseBody = await res.text();
    expect(
      res.ok(),
      `submit form failed: ${res.status()} ${responseBody}`,
    ).toBeTruthy();
    const body = JSON.parse(responseBody) as {
      result: { results: Array<{ filledNarrative: string }> };
    };
    expect(body.result.results[0]!.filledNarrative).toBe("[玩家选择] Attack");
  });

  test("confirmation localizes via the en-US session.locale chain", async ({
    request,
  }) => {
    const session = await createSession(request, "en-US");
    await seedCommittedInteractions(request, session, [
      {
        interactionId: "no-tpl",
        type: "confirmation",
        prompt: "Proceed?",
      },
    ]);
    const res = await submitForm(request, session.id, [
      {
        interactionId: "no-tpl",
        type: "confirmation",
        values: { confirmed: true },
      },
    ]);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      result: { results: Array<{ filledNarrative: string }> };
    };
    expect(body.result.results[0]!.filledNarrative).toBe(
      "[Player confirmed] Proceed?",
    );
  });

  test("batch of multiple submissions returns one result each, in order", async ({
    request,
  }) => {
    const session = await createSession(request, "zh-CN");
    await seedCommittedInteractions(request, session, [
      {
        interactionId: "b1",
        type: "form",
        fields: [{ type: "number", name: "a", label: "A" }],
      },
      {
        interactionId: "b2",
        type: "choice",
        prompt: "Choose",
        choices: [{ id: "x", label: "X" }],
      },
    ]);
    const res = await submitForm(request, session.id, [
      { interactionId: "b1", type: "form", values: { a: 1 } },
      { interactionId: "b2", type: "choice", values: { selectedId: "x" } },
    ]);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      result: { results: Array<{ interactionId: string }> };
    };
    expect(body.result.results.map((r) => r.interactionId)).toEqual([
      "b1",
      "b2",
    ]);
  });

  test("missing turnId is rejected with 400", async ({ request }) => {
    const session = await createSession(request, "zh-CN");
    const res = await request.post(`/api/sessions/${session.id}/plugin-rpc`, {
      data: {
        kind: "action",
        pluginId: "framework",
        action: "submit-form",
        payload: { submissions: [] },
      },
    });
    expect(res.status()).toBe(400);
  });

  test("invalid submission type is rejected with 400", async ({ request }) => {
    const session = await createSession(request, "zh-CN");
    const res = await submitForm(request, session.id, [
      { interactionId: "x", type: "bogus", values: {} },
    ]);
    expect(res.status()).toBe(400);
  });
});
