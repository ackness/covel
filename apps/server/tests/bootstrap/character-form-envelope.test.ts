import { expect, it } from "vitest";
import { createToolExecutor, createWorldModelView } from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { createFormTool, tool } from "@covel/tools";
import makeCharacterForm from "../../../../plugins/char-creator/tools/create-character-form.js";

it("carries the actual character form's correction into the executor envelope without publishing invalid input", async () => {
  const store = createMemoryStore();
  const registered = makeCharacterForm({ tool }, createFormTool);
  const executor = createToolExecutor({ store, findTool: () => registered });
  const context = {
    sessionId: "form-envelope",
    turnId: "setup",
    pluginId: "char-creator",
    runtimeId: "char-creator/player-init",
    locale: "en",
    world: await createWorldModelView(store, "form-envelope"),
  };
  const params = {
    formId: "char-creation",
    title: "Your character",
    submitLabel: "Continue",
    fields: [
      { name: "characterName", type: "text", label: "Name", required: true },
    ],
  };
  try {
    const rejected = await executor.execute(
      {
        toolCallId: "invalid",
        name: "create-character-form",
        arguments: JSON.stringify({
          ...params,
          narrativeTemplate: "Wren arrives.",
        }),
      },
      context,
    );
    expect(rejected.success).toBe(false);
    expect(JSON.parse(rejected.result)).toEqual({
      error: {
        code: "invalid-input",
        message: expect.stringContaining("must include {{characterName}}"),
      },
    });
    expect(rejected.parsedResult).toBeNull();
    expect(rejected.pendingProposals ?? []).toEqual([]);
    const corrected = await executor.execute(
      {
        toolCallId: "corrected",
        name: "create-character-form",
        arguments: JSON.stringify({
          ...params,
          narrativeTemplate: "{{characterName}} arrives.",
        }),
      },
      context,
    );
    expect(corrected.success, corrected.result).toBe(true);
    expect(corrected.parsedResult).toMatchObject({
      created: true,
      interaction: { type: "form", interactionId: "char-creation" },
    });
  } finally {
    await executor.close();
    await store.close();
  }
});
