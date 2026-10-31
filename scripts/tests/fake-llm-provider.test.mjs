import { test } from "node:test";
import assert from "node:assert/strict";
import { startFakeLlmProvider } from "../../tests/e2e/helpers/fake-llm-provider.ts";

test("fake provider retains raw tool transport and returns complete chat tool calls", async () => {
  const provider = await startFakeLlmProvider();
  const call = {
    id: "actor-call",
    type: "function",
    function: { name: "delegate", arguments: '{"character":"Mara"}' },
  };
  const tools = [
    {
      type: "function",
      function: { name: "delegate", parameters: { type: "object" } },
    },
  ];
  const messages = [
    { role: "user", content: "Invite Mara." },
    { role: "assistant", content: null, tool_calls: [call] },
    {
      role: "tool",
      tool_call_id: call.id,
      content: '{"data":{"segments":[]}}',
    },
  ];
  provider.reply = () => ({ text: "", toolCalls: [call] });
  try {
    for (const stream of [false, true]) {
      const response = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ model: "fixture", messages, tools, stream }),
      });
      assert.equal(response.status, 200);
      if (stream) {
        const wire = await response.text();
        assert.match(wire, /"finish_reason":"tool_calls"/);
        assert.match(wire, /"id":"actor-call"/);
        assert.match(wire, /\[DONE\]/);
      } else {
        const result = await response.json();
        assert.deepEqual(result.choices[0].message.tool_calls, [call]);
        assert.equal(result.choices[0].finish_reason, "tool_calls");
      }
    }
    assert.deepEqual(provider.requests[0].rawMessages, messages);
    assert.deepEqual(provider.requests[0].tools, tools);
    assert.deepEqual(provider.requests[0].messages, [
      "Invite Mara.",
      "",
      '{"data":{"segments":[]}}',
    ]);
    provider.reply = () => ({ text: "A legacy text reply." });
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "Hello." }] }),
    });
    assert.equal(
      (await response.json()).choices[0].message.content,
      "A legacy text reply.",
    );
  } finally {
    await provider.close();
  }
});

test("fake provider gates replies and exposes deliberate HTTP failures", async () => {
  const provider = await startFakeLlmProvider();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  provider.reply = () => {
    entered.resolve();
    return { text: "After release.", hold: release.promise };
  };
  try {
    let settled = false;
    const pending = fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      body: "{}",
    }).then((response) => {
      settled = true;
      return response;
    });
    await entered.promise;
    assert.equal(settled, false);
    release.resolve();
    assert.equal(
      (await (await pending).json()).choices[0].message.content,
      "After release.",
    );
    provider.reply = () => ({
      text: "",
      error: { status: 503, message: "Deliberate failure." },
    });
    const failure = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(failure.status, 503);
    assert.equal((await failure.json()).error.message, "Deliberate failure.");
  } finally {
    release.resolve();
    await provider.close();
  }
});
