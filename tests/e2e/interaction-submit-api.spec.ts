import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Deterministic, no-LLM API coverage of the framework `submit-form` default
 * over a real server bootstrap: exercises the session.locale → handler
 * localization chain and batch / validation paths end-to-end. Complements the
 * in-process plugin-rpc.test.ts (mock setup) with true server wiring. Uses an
 * unknown interactionId so the handler takes the deterministic fallbackNarrative
 * path (no template seeding, no LLM).
 */

test.describe.configure({ mode: "serial" });

async function createSession(
  request: APIRequestContext,
  locale: string,
): Promise<string> {
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
        "player-identity",
        "living-world-rules",
        "character-blueprint",
      ],
    },
  });
  expect(res.ok(), `create session failed: ${res.status()}`).toBeTruthy();
  const body = (await res.json()) as { id: string };
  return body.id;
}

function submitForm(
  request: APIRequestContext,
  sessionId: string,
  submissions: ReadonlyArray<Record<string, unknown>>,
) {
  return request.post(`/api/sessions/${sessionId}/plugin-rpc`, {
    data: {
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
    const id = await createSession(request, "zh-CN");
    const res = await submitForm(request, id, [
      {
        interactionId: "no-tpl",
        type: "choice",
        values: { selectedId: "a", selectedLabel: "Attack" },
      },
    ]);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      result: { results: Array<{ filledNarrative: string }> };
    };
    expect(body.result.results[0]!.filledNarrative).toBe("[玩家选择] Attack");
  });

  test("confirmation localizes via the en-US session.locale chain", async ({
    request,
  }) => {
    const id = await createSession(request, "en-US");
    const res = await submitForm(request, id, [
      {
        interactionId: "no-tpl",
        type: "confirmation",
        values: { confirmed: true, prompt: "Proceed?" },
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
    const id = await createSession(request, "zh-CN");
    const res = await submitForm(request, id, [
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
    const id = await createSession(request, "zh-CN");
    const res = await request.post(`/api/sessions/${id}/plugin-rpc`, {
      data: {
        pluginId: "framework",
        action: "submit-form",
        payload: { submissions: [] },
      },
    });
    expect(res.status()).toBe(400);
  });

  test("invalid submission type is rejected with 400", async ({ request }) => {
    const id = await createSession(request, "zh-CN");
    const res = await submitForm(request, id, [
      { interactionId: "x", type: "bogus", values: {} },
    ]);
    expect(res.status()).toBe(400);
  });
});
