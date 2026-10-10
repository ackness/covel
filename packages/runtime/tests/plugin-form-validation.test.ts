import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { submitAndStore as createSubmitFormHandler } from "./submit-and-store.js";

async function fixture(sourcePluginId: string | undefined = "provider") {
  const store = createMemoryStore();
  await store.appendTurnMessage({
    id: "message",
    sessionId: "session",
    turnId: "turn",
    sourceType: "runtime",
    sourcePluginId,
    role: "assistant",
    content: "",
    order: 1,
    createdAt: "2026-01-01T00:00:00Z",
    pendingInput: ["first", "second"].map((interactionId) => ({
      interactionId,
      type: "form",
      title: "Allocation",
      submitLabel: "Submit",
      fields: [
        { type: "number", name: "points", label: "Points", required: true },
      ],
      validation: { name: "budget", data: { limit: 4 } },
    })),
  });
  const context = { sessionId: "session" };
  const submission = (interactionId: string, points: unknown) => ({
    interactionId,
    type: "form",
    values: { points },
  });
  return { store, context, submission };
}

describe("plugin-owned form validation", () => {
  it("uses the committed owner and rule data with normalized input, ignoring forged metadata", async () => {
    const { store, context, submission } = await fixture();
    const validate = vi.fn(async () => undefined);
    await createSubmitFormHandler(validate, store)(
      {
        turnId: "turn",
        pluginId: "attacker",
        submissions: [
          {
            ...submission("first", "3"),
            validation: { name: "bypass", data: { limit: 99 } },
          },
        ],
      },
      context,
    );
    expect(validate).toHaveBeenCalledWith({
      sessionId: "session",
      pluginId: "provider",
      name: "budget",
      values: { points: 3 },
      data: { limit: 4 },
    });
    expect((await store.listPlayerInputs("session"))[0]?.values).toEqual({
      points: 3,
    });
  });

  it("rejects the complete batch before any writes when one plugin validation fails", async () => {
    const { store, context, submission } = await fixture();
    const handler = createSubmitFormHandler(
      async ({ values }) =>
        Number(values.points) > 4 ? [{ message: "Over budget" }] : undefined,
      store,
    );
    await expect(
      handler(
        {
          turnId: "turn",
          submissions: [submission("first", 3), submission("second", 5)],
        },
        context,
      ),
    ).rejects.toMatchObject({
      code: "form_rejected",
      message: "Over budget",
      issues: [{ message: "Over budget" }],
    });
    expect(await store.listPlayerInputs("session")).toHaveLength(0);
    await handler(
      {
        turnId: "turn",
        submissions: [submission("first", 3), submission("second", 4)],
      },
      context,
    );
    expect(await store.listPlayerInputs("session")).toHaveLength(2);
  });

  it("keeps a plugin issue on its field and moves one for an unknown field to the form", async () => {
    const { store, context, submission } = await fixture();
    const handler = createSubmitFormHandler(
      async () => [
        { field: "points", message: "Too many" },
        { field: "nowhere", message: "Not a field" },
      ],
      store,
    );
    await expect(
      handler(
        { turnId: "turn", submissions: [submission("first", 9)] },
        context,
      ),
    ).rejects.toMatchObject({
      code: "form_rejected",
      issues: [
        { field: "points", message: "Too many" },
        { message: "Not a field" },
      ],
    });
  });

  it.each(["missing-owner", "missing-validator"])(
    "fails closed for %s",
    async (mode) => {
      const { store, context, submission } = await fixture(
        mode === "missing-owner" ? "" : "provider",
      );
      const validate = vi.fn(async () => undefined);
      const handler = createSubmitFormHandler(
        mode === "missing-validator" ? undefined : validate,
        store,
      );
      await expect(
        handler(
          { turnId: "turn", submissions: [submission("first", 3)] },
          context,
        ),
      ).rejects.toThrow();
      expect(validate).not.toHaveBeenCalled();
      expect(await store.listPlayerInputs("session")).toHaveLength(0);
    },
  );
});
