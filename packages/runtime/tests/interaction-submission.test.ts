/**
 * Interaction submission — direct unit coverage (Epic A).
 *
 * Pins the locale-aware narrative filling (the confirmation 确认/取消 and the
 * fallback prefixes were previously hardcoded Chinese), the zh-CN byte-compat
 * default, batch + persistence, validation errors, and the InteractionType
 * alignment.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import type { InteractionPayload, InteractionType } from "@covel/shared";
import {
  createInteractionSubmitter,
  FormRejectedError,
  InteractionAlreadySubmittedError,
  InteractionSubmissionError,
  VALID_TYPES,
} from "../src/interaction/interaction-submission.js";
import { submitAndStore } from "./submit-and-store.js";

const SESSION = "sess-1";
const TURN = "turn-1";

function makeCtx(_store: DataStore, locale?: string) {
  return { sessionId: SESSION, ...(locale ? { locale } : {}) };
}

async function seedTemplate(
  store: DataStore,
  interactionId: string,
  content: string,
  fields: Extract<InteractionPayload, { readonly type: "form" }>["fields"],
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
    pendingInput: [
      {
        interactionId,
        type: "form",
        title: "Test form",
        fields,
        submitLabel: "Submit",
      },
    ],
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
  const result = await submitAndStore(undefined, store)(
    { turnId: TURN, submissions: [sub] },
    makeCtx(store, locale),
  );
  return result.results[0]!.filledNarrative;
}

describe("submitFormHandler (Epic A)", () => {
  let store: DataStore;

  beforeEach(() => {
    store = createMemoryStore();
  });

  // ── Template filling ────────────────────────────────────────────
  it("fills a form template with submitted values", async () => {
    await seedTemplate(store, "form-1", "Player name is {{name}}", [
      { type: "text", name: "name", label: "Name" },
    ]);
    const out = await submitOne(store, {
      interactionId: "form-1",
      type: "form",
      values: { name: "Aria" },
    });
    expect(out).toBe("Player name is Aria");
  });

  it("uses field defaults for missing and empty optional values", async () => {
    await seedInteraction(store, {
      interactionId: "defaults",
      type: "form",
      title: "Defaults",
      submitLabel: "Submit",
      fields: [
        { type: "text", name: "origin", label: "Origin", defaultValue: "home" },
        {
          type: "select",
          name: "path",
          label: "Path",
          options: [{ value: "quiet", label: "Quiet" }],
          defaultValue: "quiet",
        },
      ],
      narrativeTemplate: "{{origin}} / {{path}}",
    });
    expect(
      await submitOne(store, {
        interactionId: "defaults",
        type: "form",
        values: { origin: "", path: "" },
      }),
    ).toBe("home / quiet");
  });

  it.each([
    ["{{origin}}。", "你是验潮师学徒。", "你是验潮师学徒。"],
    ["{{origin}}。", "你是验潮师学徒", "你是验潮师学徒。"],
    ["{{origin}}.", "I wait...", "I wait..."],
    ["{{origin}}", "I wait...", "I wait..."],
  ])(
    "does not duplicate a full stop at the interpolation boundary (%s)",
    async (template, origin, expected) => {
      await seedInteraction(store, {
        interactionId: "punctuation",
        type: "form",
        title: "Punctuation",
        submitLabel: "Submit",
        fields: [
          {
            type: "text",
            name: "origin",
            label: "Origin",
            defaultValue: origin,
          },
        ],
        narrativeTemplate: template,
      });
      expect(
        await submitOne(store, {
          interactionId: "punctuation",
          type: "form",
          values: {},
        }),
      ).toBe(expected);
      expect((await store.listPlayerInputs(SESSION))[0]?.values).toEqual({
        origin,
      });
    },
  );

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

  it("falls back to English labels for an unsupported locale", async () => {
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
    ).toBe("Result: Confirm");
  });

  it("fills confirmation labels in ru-RU", async () => {
    await seedInteraction(store, {
      interactionId: "cf-ru",
      type: "confirmation",
      prompt: "Продолжить?",
      narrativeTemplate: "Результат: {{confirmed}}",
    });
    expect(
      await submitOne(
        store,
        {
          interactionId: "cf-ru",
          type: "confirmation",
          values: { confirmed: true },
        },
        "ru-RU",
      ),
    ).toBe("Результат: Подтвердить");
  });

  // ── fallbackNarrative (no matching template) ────────────────────
  it("localizes the fallback form prefix (zh-CN byte-compat vs en-US)", async () => {
    await seedTemplate(store, "x-zh", "", [
      { type: "text", name: "k", label: "K" },
    ]);
    expect(
      await submitOne(
        store,
        { interactionId: "x-zh", type: "form", values: { k: "v" } },
        "zh-CN",
      ),
    ).toBe("[玩家输入] k: v");
    await seedTemplate(store, "x-en", "", [
      { type: "text", name: "k", label: "K" },
    ]);
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
    await seedTemplate(store, "x-form", "", [
      { type: "number", name: "a", label: "A" },
    ]);
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
    await seedTemplate(store, "b1", "", [
      { type: "number", name: "a", label: "A" },
    ]);
    await seedInteraction(store, {
      interactionId: "b2",
      type: "choice",
      prompt: "Choose",
      choices: [{ id: "x", label: "X" }],
    });
    const result = await submitAndStore(undefined, store)(
      {
        turnId: TURN,
        submissions: [
          { interactionId: "b1", type: "form", values: { a: 1 } },
          { interactionId: "b2", type: "choice", values: { selectedId: "x" } },
        ],
      },
      makeCtx(store),
    );
    expect(result.results.map((r) => r.interactionId)).toEqual(["b1", "b2"]);
  });

  it("persists one player input per submission", async () => {
    await seedTemplate(store, "p1", "", [
      { type: "number", name: "a", label: "A" },
    ]);
    await seedTemplate(store, "p2", "", [
      { type: "number", name: "b", label: "B" },
    ]);
    await submitAndStore(undefined, store)(
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
    await seedTemplate(store, "tpl-x", "Hi {{name}} {{missing}}", [
      { type: "text", name: "name", label: "Name" },
    ]);
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
    await expect(
      submitAndStore(undefined, store)(null, makeCtx(store)),
    ).rejects.toThrow(InteractionSubmissionError);
  });

  it("throws when turnId is missing", async () => {
    await expect(
      submitAndStore(undefined, store)({ submissions: [] }, makeCtx(store)),
    ).rejects.toThrow(InteractionSubmissionError);
  });

  it("throws when submissions[] is empty", async () => {
    await expect(
      submitAndStore(undefined, store)(
        { turnId: TURN, submissions: [] },
        makeCtx(store),
      ),
    ).rejects.toThrow(InteractionSubmissionError);
  });

  it("throws when submissions is not an array", async () => {
    await expect(
      submitAndStore(undefined, store)(
        { turnId: TURN, submissions: { interactionId: "x" } },
        makeCtx(store),
      ),
    ).rejects.toThrow(InteractionSubmissionError);
  });

  it("throws when a submission is not an object", async () => {
    await expect(
      submitAndStore(undefined, store)(
        { turnId: TURN, submissions: [null] },
        makeCtx(store),
      ),
    ).rejects.toThrow(InteractionSubmissionError);
  });

  it("throws when a submission interactionId is missing", async () => {
    await expect(
      submitAndStore(undefined, store)(
        { turnId: TURN, submissions: [{ type: "form", values: {} }] },
        makeCtx(store),
      ),
    ).rejects.toThrow(InteractionSubmissionError);
  });

  it("throws for an invalid submission type", async () => {
    await expect(
      submitAndStore(undefined, store)(
        {
          turnId: TURN,
          submissions: [{ interactionId: "x", type: "bogus", values: {} }],
        },
        makeCtx(store),
      ),
    ).rejects.toThrow(InteractionSubmissionError);
  });

  it("throws when submission.values is an array", async () => {
    await expect(
      submitAndStore(undefined, store)(
        {
          turnId: TURN,
          submissions: [{ interactionId: "x", type: "form", values: [] }],
        },
        makeCtx(store),
      ),
    ).rejects.toThrow(InteractionSubmissionError);
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

    // A refusal the player can correct names the field by its label, in the
    // session's language, and is told apart from a malformed request.
    const refusal = (values: Record<string, unknown>, locale: string) =>
      submitOne(
        store,
        { interactionId: "profile", type: "form", values },
        locale,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
    // Every refused field is reported at once, each under its own field.
    const missing = await refusal({ age: "old" }, "en-US");
    expect(missing).toBeInstanceOf(FormRejectedError);
    expect(missing).toMatchObject({
      code: "form_rejected",
      issues: [
        { field: "name", message: 'Fill in "Name".' },
        { field: "age", message: '"Age" must be a number.' },
      ],
    });
    expect(await refusal({ age: "old" }, "zh-CN")).toMatchObject({
      issues: [{ field: "name", message: "请填写“Name”。" }, expect.anything()],
    });
    expect(await refusal({ name: "Aria", age: "old" }, "en-US")).toMatchObject({
      code: "form_rejected",
      message: '"Age" must be a number.',
    });
    expect(
      await refusal({ name: "Aria", origin: "moon" }, "en-US"),
    ).toMatchObject({
      code: "form_rejected",
      message: 'Choose one of the listed options for "Origin".',
    });
    const malformed = await refusal({ name: "Aria", admin: true }, "en-US");
    expect(malformed).toBeInstanceOf(InteractionSubmissionError);
    expect(malformed).not.toBeInstanceOf(FormRejectedError);
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

  describe("answering an interaction twice", () => {
    const form = {
      interactionId: "name-form",
      type: "form" as const,
      title: "Name",
      submitLabel: "Continue",
      fields: [{ type: "text", name: "name", label: "Name", required: true }],
      narrativeTemplate: "Hello {{name}}",
    };
    const answer = (name: string) => ({
      interactionId: "name-form",
      type: "form" as const,
      values: { name },
    });

    it("refuses any second answer: the stored one already has its turn", async () => {
      await seedInteraction(store, form);
      await submitOne(store, answer("Aria"));
      for (const name of ["Aria", "Different"]) {
        const refusal = await submitOne(store, answer(name)).catch(
          (error: unknown) => error,
        );
        expect(refusal).toBeInstanceOf(InteractionAlreadySubmittedError);
        expect(refusal).toMatchObject({
          code: "interaction_already_submitted",
        });
      }
      expect(await store.listPlayerInputs(SESSION)).toMatchObject([
        { values: { name: "Aria" } },
      ]);
    });

    it("stores nothing until the caller persists", async () => {
      await seedInteraction(store, form);
      const prepared = await createInteractionSubmitter(undefined, store)(
        { turnId: TURN, submissions: [answer("Aria")] },
        makeCtx(store),
      );
      expect(prepared).toMatchObject({
        turnId: TURN,
        playerMessage: "Hello Aria",
        results: [{ interactionId: "name-form", values: { name: "Aria" } }],
      });
      expect(await store.listPlayerInputs(SESSION)).toEqual([]);
      await prepared.persist(store);
      expect(await store.listPlayerInputs(SESSION)).toMatchObject([
        { id: prepared.results[0]!.submissionId, formId: "name-form" },
      ]);
    });
  });

  it("leaves out of the player's message an interaction that asks for no echo", async () => {
    await seedInteraction(store, {
      interactionId: "quiet",
      type: "form",
      title: "Quiet",
      submitLabel: "Continue",
      fields: [{ type: "text", name: "name", label: "Name" }],
      narrativeTemplate: "Quiet {{name}}",
      submitBehavior: { echoFilledNarrative: false },
    });
    await seedInteraction(store, {
      interactionId: "loud",
      type: "choice",
      prompt: "Choose",
      choices: [{ id: "x", label: "X" }],
      narrativeTemplate: "Chose {{selectedLabel}}",
    });
    const quiet = {
      interactionId: "quiet",
      type: "form",
      values: { name: "A" },
    };
    const submit = createInteractionSubmitter(undefined, store);
    expect(
      (await submit({ turnId: TURN, submissions: [quiet] }, makeCtx(store)))
        .playerMessage,
    ).toBe("");
    const both = await submit(
      {
        turnId: TURN,
        submissions: [
          quiet,
          {
            interactionId: "loud",
            type: "choice",
            values: { selectedId: "x" },
          },
        ],
      },
      makeCtx(store),
    );
    expect(both.playerMessage).toBe("Chose X");
    expect(both.results.map((result) => result.filledNarrative)).toEqual([
      "Quiet A",
      "Chose X",
    ]);
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
      submitAndStore(undefined, store)(
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

describe("typed numeric form constraints", () => {
  it.each(["", "NaN", "Infinity", -1, 6, 2.5])(
    "rejects %s without accepting the form",
    async (value) => {
      const store = createMemoryStore();
      await seedTemplate(store, "points", "{{points}}", [
        {
          type: "number",
          name: "points",
          label: "Points",
          required: true,
          defaultValue: 1,
          min: 0,
          max: 5,
          step: 1,
        },
      ]);
      await expect(
        submitOne(store, {
          interactionId: "points",
          type: "form",
          values: { points: value },
        }),
      ).rejects.toThrow();
      expect(await store.listPlayerInputs(SESSION)).toHaveLength(0);
    },
  );
  it("normalizes legacy numeric strings and typed defaults before persistence", async () => {
    const store = createMemoryStore();
    await seedTemplate(store, "points", "{{points}}", [
      {
        type: "number",
        name: "points",
        label: "Points",
        required: true,
        min: 0,
        max: 5,
        step: 0.5,
      },
      { type: "number", name: "zero", label: "Zero", defaultValue: 0 },
      { type: "checkbox", name: "ready", label: "Ready", defaultValue: false },
    ]);
    await submitOne(store, {
      interactionId: "points",
      type: "form",
      values: { points: "2.5" },
    });
    expect((await store.listPlayerInputs(SESSION))[0]?.values).toEqual({
      points: 2.5,
      zero: 0,
      ready: false,
    });
  });
});
