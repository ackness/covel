import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store";
import { createSubmitFormHandler } from "../src/rpc-defaults/submit-form.js";

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
  const context = { sessionId: "session", pluginId: "framework", store };
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
    await createSubmitFormHandler(validate)(
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
    const handler = createSubmitFormHandler(async ({ values }) =>
      Number(values.points) > 4 ? "Over budget" : undefined,
    );
    await expect(
      handler(
        {
          turnId: "turn",
          submissions: [submission("first", 3), submission("second", 5)],
        },
        context,
      ),
    ).rejects.toThrow("Over budget");
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

  it.each(["missing-owner", "missing-validator"])(
    "fails closed for %s",
    async (mode) => {
      const { store, context, submission } = await fixture(
        mode === "missing-owner" ? "" : "provider",
      );
      const validate = vi.fn(async () => undefined);
      const handler = createSubmitFormHandler(
        mode === "missing-validator" ? undefined : validate,
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
