import assert from "node:assert/strict";
import test from "node:test";

import register from "../server/index.js";
import providers from "../runtimes/providers/handler.js";
import save from "../runtimes/save/handler.js";

const formatter = {
  pluginId: "note-formatter",
  name: "format-note",
  contract: "examples/note-format@1",
};

function saveContext(manualPayload, services = {}) {
  const writes = [];
  return {
    writes,
    ctx: {
      manualPayload,
      locale: "en-US",
      signal: new AbortController().signal,
      services: {
        discover: async () => [formatter],
        call: async ({ input }) => ({ text: `Formatted: ${input.text}` }),
        ...services,
      },
      pluginData: {
        async set(namespace, key, value) {
          writes.push({ namespace, key, value });
        },
      },
    },
  };
}

test("/notes only requests the notes panel", async () => {
  let action;
  register({ registerRpc: (name, handler) => (action = { name, handler }) });
  assert.equal(action.name, "open-notes");
  assert.deepEqual(await action.handler({}, { locale: "en-US" }), {
    ok: true,
    message: "Notes panel opened.",
    clientAction: { type: "open-plugin-panel", panelId: "notes-workbench" },
  });
});

test("providers lists only format-note and sorts by plugin ID", async () => {
  const result = await providers({
    services: {
      async discover(contract) {
        assert.equal(contract, "examples/note-format@1");
        return [
          { ...formatter, pluginId: "zeta", description: "Z" },
          { ...formatter, name: "other", pluginId: "ignored" },
          { ...formatter, pluginId: "alpha" },
        ];
      },
    },
  });
  assert.deepEqual(result.value.providers, [
    { pluginId: "alpha", name: "format-note" },
    { pluginId: "zeta", name: "format-note", description: "Z" },
  ]);
});

test("raw note persists exact input and null provider provenance", async () => {
  const { ctx, writes } = saveContext(
    { text: "  A note  ", providerPluginId: "  " },
    {
      discover: async () => assert.fail("raw save must not discover services"),
      call: async () => assert.fail("raw save must not call a service"),
    },
  );
  const result = await save(ctx);
  assert.equal(result.outcome, "success");
  assert.deepEqual(writes, [
    { namespace: "notes", key: result.value.note.id, value: result.value.note },
  ]);
  assert.match(
    result.value.note.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(result.value.note.originalText, "  A note  ");
  assert.equal(result.value.note.text, "  A note  ");
  assert.equal(result.value.note.providerPluginId, null);
});

test("selected provider is called with the contract, text, and time budget", async () => {
  const { ctx, writes } = saveContext(
    { text: "Hello", providerPluginId: "note-formatter" },
    {
      async call(request, options) {
        assert.deepEqual(request, {
          pluginId: "note-formatter",
          name: "format-note",
          contract: "examples/note-format@1",
          input: { text: "Hello" },
        });
        assert.deepEqual(options, { timeoutMs: 1500, signal: ctx.signal });
        return { text: "Formatted: Hello" };
      },
    },
  );
  const result = await save(ctx);
  assert.equal(writes.length, 1);
  assert.equal(result.value.note.text, "Formatted: Hello");
  assert.equal(result.value.note.providerPluginId, "note-formatter");
});

test("invalid input, unavailable providers, and failed formatting do not save", async () => {
  for (const payload of [
    { text: " " },
    { text: "x".repeat(4001) },
    { text: 42 },
  ]) {
    const { ctx, writes } = saveContext(payload);
    await assert.rejects(save(ctx));
    assert.equal(writes.length, 0);
  }

  const unavailable = saveContext({ text: "Hello", providerPluginId: "other" });
  await assert.rejects(save(unavailable.ctx), /unavailable/);
  assert.equal(unavailable.writes.length, 0);

  for (const call of [
    async () => {
      throw new Error("failed");
    },
    async () => ({ text: " " }),
    async () => ({ text: "x".repeat(8001) }),
  ]) {
    const { ctx, writes } = saveContext(
      { text: "Hello", providerPluginId: "note-formatter" },
      { call },
    );
    await assert.rejects(save(ctx));
    assert.equal(writes.length, 0);
  }
});
