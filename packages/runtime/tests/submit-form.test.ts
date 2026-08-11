/**
 * submit-form framework default handler — direct unit coverage (Epic A).
 *
 * Pins the locale-aware narrative filling (the confirmation 确认/取消 and the
 * fallback prefixes were previously hardcoded Chinese), the zh-CN byte-compat
 * default, batch + persistence, validation errors, and the InteractionType
 * alignment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import type { InteractionPayload, InteractionType } from "@covel/shared";
import {
  submitFormHandler,
  RpcValidationError,
  VALID_TYPES,
} from "../src/rpc-defaults/submit-form.js";
import type { RpcHandlerContext } from "../src/rpc/rpc-registry.js";

const SESSION = "sess-1";
const TURN = "turn-1";

function makeCtx(store: DataStore, locale?: string): RpcHandlerContext {
  return {
    sessionId: SESSION,
    pluginId: "framework",
    store,
    ...(locale ? { locale } : {}),
  };
}

async function seedTemplate(
  store: DataStore,
  interactionId: string,
  content: string,
): Promise<void> {
  await store.appendTurnMessage({
    id: crypto.randomUUID(),
    sessionId: SESSION,
    turnId: TURN,
    sourceType: "runtime",
    role: "assistant",
    name: "tpl",
    content,
    order: 700,
    pendingInput: { formId: interactionId },
    createdAt: new Date().toISOString(),
  });
}

async function seedInteraction(
  store: DataStore,
  interaction: InteractionPayload,
  content = "",
): Promise<void> {
  await store.appendTurnMessage({
    id: crypto.randomUUID(),
    sessionId: SESSION,
    turnId: TURN,
    sourceType: "runtime",
    role: "assistant",
    name: "interaction-template",
    content,
    order: 700,
    pendingInput: [interaction],
    createdAt: new Date().toISOString(),
  });
}

async function submitOne(
  store: DataStore,
  sub: {
    interactionId: string;
    type: InteractionType;
    values: Record<string, unknown>;
  },
  locale?: string,
): Promise<string> {
  const result = (await submitFormHandler(
    { turnId: TURN, submissions: [sub] },
    makeCtx(store, locale),
  )) as { results: Array<{ filledNarrative: string }> };
  return result.results[0]!.filledNarrative;
}

describe("submitFormHandler (Epic A)", () => {
  let store: DataStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  // ── Template filling ────────────────────────────────────────────
  it("fills a form template with submitted values", async () => {
    await seedTemplate(store, "form-1", "Player name is {{name}}");
    const out = await submitOne(store, {
      interactionId: "form-1",
      type: "form",
      values: { name: "Aria" },
    });
    expect(out).toBe("Player name is Aria");
  });

  it("fills a choice template using selectedLabel, falling back to selectedId", async () => {
    await seedInteraction(store, {
      interactionId: "ch-1",
      type: "choice",
      prompt: "Choose",
      choices: [{ id: "a", label: "Attack" }],
      narrativeTemplate: "You chose {{selectedLabel}}",
    });
    expect(
      await submitOne(store, {
        interactionId: "ch-1",
        type: "choice",
        values: { selectedId: "a", selectedLabel: "Attack" },
      }),
    ).toBe("You chose Attack");

    await seedInteraction(store, {
      interactionId: "ch-2",
      type: "choice",
      prompt: "Choose",
      choices: [{ id: "flee", label: "flee" }],
      narrativeTemplate: "You chose {{selectedLabel}}",
    });
    expect(
      await submitOne(store, {
        interactionId: "ch-2",
        type: "choice",
        values: { selectedId: "flee" },
      }),
    ).toBe("You chose flee");
  });

  // ── i18n confirmation (the core fix) ────────────────────────────
  it("fills confirmation {{confirmed}} with 确认 for zh-CN", async () => {
    await seedInteraction(store, {
      interactionId: "cf-1",
      type: "confirmation",
      prompt: "Proceed?",
      narrativeTemplate: "Result: {{confirmed}}",
    });
    expect(
      await submitOne(
        store,
        {
          interactionId: "cf-1",
          type: "confirmation",
          values: { confirmed: true },
        },
        "zh-CN",
      ),
    ).toBe("Result: 确认");
  });

  it("fills confirmation {{confirmed}} with Confirm for en-US (regression for hardcoded 确认/取消)", async () => {
    await seedInteraction(store, {
      interactionId: "cf-2",
      type: "confirmation",
      prompt: "Proceed?",
      narrativeTemplate: "Result: {{confirmed}}",
    });
    expect(
      await submitOne(
        store,
        {
          interactionId: "cf-2",
          type: "confirmation",
          values: { confirmed: true },
        },
        "en-US",
      ),
    ).toBe("Result: Confirm");
  });

  it("fills cancelled confirmation with Cancel for en-US", async () => {
    await seedInteraction(store, {
      interactionId: "cf-3",
      type: "confirmation",
      prompt: "Proceed?",
      narrativeTemplate: "Result: {{confirmed}}",
    });
    expect(
      await submitOne(
        store,
        {
          interactionId: "cf-3",
          type: "confirmation",
          values: { confirmed: false },
        },
        "en-US",
      ),
    ).toBe("Result: Cancel");
  });

  it("defaults to zh-CN confirmation labels when locale is undefined (back-compat)", async () => {
    await seedInteraction(store, {
      interactionId: "cf-4",
      type: "confirmation",
      prompt: "Proceed?",
      narrativeTemplate: "Result: {{confirmed}}",
    });
    expect(
      await submitOne(store, {
        interactionId: "cf-4",
        type: "confirmation",
        values: { confirmed: false },
      }),
    ).toBe("Result: 取消");
  });

  it("falls back to zh-CN labels for an unsupported locale (no undefined deref)", async () => {
    await seedInteraction(store, {
      interactionId: "cf-5",
      type: "confirmation",
      prompt: "Proceed?",
      narrativeTemplate: "Result: {{confirmed}}",
    });
    expect(
      await submitOne(
        store,
        {
          interactionId: "cf-5",
          type: "confirmation",
          values: { confirmed: true },
        },
        "fr-FR",
      ),
    ).toBe("Result: 确认");
  });

  // ── fallbackNarrative (no matching template) ────────────────────
  it("localizes the fallback form prefix (zh-CN byte-compat vs en-US)", async () => {
    await seedTemplate(store, "x-zh", "");
    expect(
      await submitOne(
        store,
        { interactionId: "x-zh", type: "form", values: { k: "v" } },
        "zh-CN",
      ),
    ).toBe("[玩家输入] k: v");
    await seedTemplate(store, "x-en", "");
    expect(
      await submitOne(
        store,
        { interactionId: "x-en", type: "form", values: { k: "v" } },
        "en-US",
      ),
    ).toBe("[Player input] k: v");
  });

  it("localizes the fallback confirmation prefix per locale", async () => {
    await seedInteraction(store, {
      interactionId: "confirm-zh",
      type: "confirmation",
      prompt: "Proceed?",
    });
    expect(
      await submitOne(
        store,
        {
          interactionId: "confirm-zh",
          type: "confirmation",
          values: { confirmed: true },
        },
        "zh-CN",
      ),
    ).toBe("[玩家确认] Proceed?");
    await seedInteraction(store, {
      interactionId: "confirm-en",
      type: "confirmation",
      prompt: "Proceed?",
    });
    expect(
      await submitOne(
        store,
        {
          interactionId: "confirm-en",
          type: "confirmation",
          values: { confirmed: false },
        },
        "en-US",
      ),
    ).toBe("[Player cancelled] Proceed?");
  });

  it("byte-compat: undefined locale matches pre-i18n zh-CN output for all three types", async () => {
    await seedTemplate(store, "x-form", "");
    expect(
      await submitOne(store, {
        interactionId: "x-form",
        type: "form",
        values: { a: 1 },
      }),
    ).toBe("[玩家输入] a: 1");
    await seedInteraction(store, {
      interactionId: "x-choice",
      type: "choice",
      prompt: "Choose",
      choices: [{ id: "s", label: "S" }],
    });
    expect(
      await submitOne(store, {
        interactionId: "x-choice",
        type: "choice",
        values: { selectedId: "s", selectedLabel: "S" },
      }),
    ).toBe("[玩家选择] S");
    await seedInteraction(store, {
      interactionId: "x-confirm",
      type: "confirmation",
      prompt: "P",
    });
    expect(
      await submitOne(store, {
        interactionId: "x-confirm",
        type: "confirmation",
        values: { confirmed: true },
      }),
    ).toBe("[玩家确认] P");
  });

  // ── batch + persistence ─────────────────────────────────────────
  it("processes a batch and returns one result per submission in order", async () => {
    await seedTemplate(store, "b1", "");
    await seedInteraction(store, {
      interactionId: "b2",
      type: "choice",
      prompt: "Choose",
      choices: [{ id: "x", label: "X" }],
    });
    const result = (await submitFormHandler(
      {
        turnId: TURN,
        submissions: [
          { interactionId: "b1", type: "form", values: { a: 1 } },
          { interactionId: "b2", type: "choice", values: { selectedId: "x" } },
        ],
      },
      makeCtx(store),
    )) as { results: Array<{ interactionId: string }> };
    expect(result.results.map((r) => r.interactionId)).toEqual(["b1", "b2"]);
  });

  it("persists one player input per submission", async () => {
    await seedTemplate(store, "p1", "");
    await seedTemplate(store, "p2", "");
    await submitFormHandler(
      {
        turnId: TURN,
        submissions: [
          { interactionId: "p1", type: "form", values: { a: 1 } },
          { interactionId: "p2", type: "form", values: { b: 2 } },
        ],
      },
      makeCtx(store),
    );
    const inputs = await store.listPlayerInputs(SESSION);
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.formId).sort()).toEqual(["p1", "p2"]);
  });

  it("leaves an unknown {{placeholder}} replaced with empty string", async () => {
    await seedTemplate(store, "tpl-x", "Hi {{name}} {{missing}}");
    expect(
      await submitOne(store, {
        interactionId: "tpl-x",
        type: "form",
        values: { name: "Bo" },
      }),
    ).toBe("Hi Bo ");
  });

  // ── validation errors ───────────────────────────────────────────
  it("throws when payload is not an object", async () => {
    await expect(submitFormHandler(null, makeCtx(store))).rejects.toThrow(
      RpcValidationError,
    );
  });

  it("throws when turnId is missing", async () => {
    await expect(
      submitFormHandler({ submissions: [] }, makeCtx(store)),
    ).rejects.toThrow(RpcValidationError);
  });

  it("throws when submissions[] is empty", async () => {
    await expect(
      submitFormHandler({ turnId: TURN, submissions: [] }, makeCtx(store)),
    ).rejects.toThrow(RpcValidationError);
  });

  it("throws when submissions is not an array", async () => {
    await expect(
      submitFormHandler(
        { turnId: TURN, submissions: { interactionId: "x" } },
        makeCtx(store),
      ),
    ).rejects.toThrow(RpcValidationError);
  });

  it("throws when a submission is not an object", async () => {
    await expect(
      submitFormHandler({ turnId: TURN, submissions: [null] }, makeCtx(store)),
    ).rejects.toThrow(RpcValidationError);
  });

  it("throws when a submission interactionId is missing", async () => {
    await expect(
      submitFormHandler(
        { turnId: TURN, submissions: [{ type: "form", values: {} }] },
        makeCtx(store),
      ),
    ).rejects.toThrow(RpcValidationError);
  });

  it("throws for an invalid submission type", async () => {
    await expect(
      submitFormHandler(
        {
          turnId: TURN,
          submissions: [{ interactionId: "x", type: "bogus", values: {} }],
        },
        makeCtx(store),
      ),
    ).rejects.toThrow(RpcValidationError);
  });

  it("throws when submission.values is an array", async () => {
    await expect(
      submitFormHandler(
        {
          turnId: TURN,
          submissions: [{ interactionId: "x", type: "form", values: [] }],
        },
        makeCtx(store),
      ),
    ).rejects.toThrow(RpcValidationError);
  });

  it("rejects an interaction that was never committed and persists nothing", async () => {
    await expect(
      submitOne(store, {
        interactionId: "forged-form",
        type: "form",
        values: { name: "Mallory" },
      }),
    ).rejects.toThrow(/committed interaction/i);
    expect(await store.listPlayerInputs(SESSION)).toEqual([]);
  });

  it("requires the submitted type to match the committed interaction", async () => {
    await seedInteraction(store, {
      interactionId: "choose-path",
      type: "choice",
      prompt: "Where?",
      choices: [{ id: "north", label: "North" }],
    });
    await expect(
      submitOne(store, {
        interactionId: "choose-path",
        type: "form",
        values: { selectedId: "north" },
      }),
    ).rejects.toThrow(/type.*choice/i);
  });

  it("validates required fields, field types, select options, and unknown keys", async () => {
    await seedInteraction(store, {
      interactionId: "profile",
      type: "form",
      title: "Profile",
      submitLabel: "Continue",
      fields: [
        { type: "text", name: "name", label: "Name", required: true },
        { type: "number", name: "age", label: "Age" },
        {
          type: "select",
          name: "origin",
          label: "Origin",
          options: ["forest", { value: "city", label: "The city" }],
        },
      ],
    });

    await expect(
      submitOne(store, {
        interactionId: "profile",
        type: "form",
        values: { age: "old" },
      }),
    ).rejects.toThrow(/required.*name/i);
    await expect(
      submitOne(store, {
        interactionId: "profile",
        type: "form",
        values: { name: "Aria", age: "old" },
      }),
    ).rejects.toThrow(/age.*number/i);
    await expect(
      submitOne(store, {
        interactionId: "profile",
        type: "form",
        values: { name: "Aria", origin: "moon" },
      }),
    ).rejects.toThrow(/origin.*option/i);
    await expect(
      submitOne(store, {
        interactionId: "profile",
        type: "form",
        values: { name: "Aria", admin: true },
      }),
    ).rejects.toThrow(/unknown field.*admin/i);
  });

  it("canonicalizes choice labels from the committed option", async () => {
    await seedInteraction(store, {
      interactionId: "choose-path",
      type: "choice",
      prompt: "Where?",
      narrativeTemplate: "You chose {{selectedLabel}}",
      choices: [{ id: "north", label: "North road" }],
    });
    expect(
      await submitOne(store, {
        interactionId: "choose-path",
        type: "choice",
        values: { selectedId: "north", selectedLabel: "Injected label" },
      }),
    ).toBe("You chose North road");
    expect((await store.listPlayerInputs(SESSION))[0]?.values).toEqual({
      selectedId: "north",
      selectedLabel: "North road",
    });
  });

  it("replays an identical submission idempotently and rejects conflicting values", async () => {
    await seedInteraction(store, {
      interactionId: "name-form",
      type: "form",
      title: "Name",
      submitLabel: "Continue",
      fields: [{ type: "text", name: "name", label: "Name", required: true }],
      narrativeTemplate: "Hello {{name}}",
    });
    const payload = {
      turnId: TURN,
      submissions: [
        {
          interactionId: "name-form",
          type: "form" as const,
          values: { name: "Aria" },
        },
      ],
    };
    const first = (await submitFormHandler(payload, makeCtx(store))) as {
      results: Array<{ submissionId: string }>;
    };
    const replay = (await submitFormHandler(payload, makeCtx(store))) as {
      results: Array<{ submissionId: string }>;
    };
    expect(replay.results[0]?.submissionId).toBe(
      first.results[0]?.submissionId,
    );
    expect(await store.listPlayerInputs(SESSION)).toHaveLength(1);

    await expect(
      submitOne(store, {
        interactionId: "name-form",
        type: "form",
        values: { name: "Different" },
      }),
    ).rejects.toThrow(/already submitted/i);
  });

  it("validates the whole batch before writing any player input", async () => {
    await seedInteraction(store, {
      interactionId: "valid-form",
      type: "form",
      title: "Name",
      submitLabel: "Continue",
      fields: [{ type: "text", name: "name", label: "Name", required: true }],
    });
    await expect(
      submitFormHandler(
        {
          turnId: TURN,
          submissions: [
            {
              interactionId: "valid-form",
              type: "form",
              values: { name: "Aria" },
            },
            {
              interactionId: "forged-form",
              type: "form",
              values: { name: "Mallory" },
            },
          ],
        },
        makeCtx(store),
      ),
    ).rejects.toThrow(/committed interaction/i);
    expect(await store.listPlayerInputs(SESSION)).toEqual([]);
  });

  // ── InteractionType alignment (critique: 3 drift points) ────────
  it("VALID_TYPES is exhaustively aligned with the InteractionType union", () => {
    // Compile-time: this object must enumerate every InteractionType member or
    // it fails to type-check — pins the union to exactly these three. Submission
    // .type is also `InteractionType`, so the inline literal can no longer drift.
    const everyType: Record<InteractionType, true> = {
      form: true,
      choice: true,
      confirmation: true,
    };
    // Runtime: the VALID_TYPES Set matches that exhaustive key set.
    expect([...VALID_TYPES].sort()).toEqual(Object.keys(everyType).sort());
  });
});
