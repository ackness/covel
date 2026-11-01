import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import register from "../../tests/third-party/submission-review-probe/server/injections.js";
import {
  completedBusinessData,
  submitOutputReply,
} from "../../tests/e2e/helpers/fake-llm-provider.ts";

test("bundled narrator guides require valid submissions even when invalid stories contain text", () => {
  for (const id of ["narrator", "chat-mode-narrator"]) {
    const readme = readFileSync(
      new URL(`../../plugins/${id}/README.md`, import.meta.url),
      "utf8",
    );
    assert.match(readme, /只通过 `submit-output` 提交/);
    assert.match(readme, /纠正后仍不合法就失败，即使含有正文也不能提交/);
    assert.match(readme, /`ReviewAgentOutput` Hook 检查已验证提交值/);
    assert.match(readme, /只有提交成功才能完成 agent/);
    assert.doesNotMatch(readme, /只有没有任何正文时才失败|缓冲模型草稿/);
  }
});

function observer() {
  const hooks = new Map();
  register(
    { on: (event, fn) => hooks.set(event, fn), onDispose() {} },
    () => "en",
  );
  const ctx = {
    sessionId: "s",
    turnId: "t",
    runtimeId: "story",
    locale: "en-US",
    getOwnSettings: () => ({ mode: "review-once", targetRuntime: "story" }),
  };
  return { hooks, ctx };
}

test("review injection is explicitly scoped, once per subject and turn, with no candidate/effect replacement", () => {
  const { hooks, ctx } = observer();
  const review = hooks.get("ReviewAgentOutput");
  assert.deepEqual(review({ ...ctx, runtimeId: "other" }), {
    action: "continue",
  });
  assert.deepEqual(
    review({
      ...ctx,
      getOwnSettings: () => ({ mode: "disabled", targetRuntime: "story" }),
    }),
    { action: "continue" },
  );
  assert.deepEqual(Object.keys(review(ctx).replace), ["correction"]);
  assert.deepEqual(review(ctx), { action: "continue" });
  assert.ok(review({ ...ctx, turnId: "another" }).replace.correction);
  hooks.get("SessionEnd")(ctx);
  assert.ok(review(ctx).replace.correction);
});

test("schema injection preserves the call identity and allows the later corrected submission", () => {
  const { hooks, ctx } = observer();
  const context = {
    ...ctx,
    getOwnSettings: () => ({ mode: "schema-once", targetRuntime: "story" }),
  };
  const pre = hooks.get("PreToolUse");
  assert.deepEqual(
    pre(context, { toolCall: { id: "work", name: "save", arguments: "{}" } }),
    { action: "continue" },
  );
  const call = {
    id: "actual-id",
    name: "submit-output",
    arguments: '{"narrativeOutput":"valid"}',
  };
  const result = pre(context, { toolCall: call });
  assert.equal(result.replace.toolCall.id, call.id);
  assert.equal(result.replace.toolCall.name, call.name);
  assert.deepEqual(JSON.parse(result.replace.toolCall.arguments), {
    segments: [{ kind: "dialogue", text: "" }],
  });
  assert.deepEqual(pre(context, { toolCall: call }), { action: "continue" });
  assert.equal(call.arguments, '{"narrativeOutput":"valid"}');
});

test("fake replies submit canonical correlated data after business work, without repeating a write", () => {
  const request = {
    rawMessages: [
      {
        role: "assistant",
        tool_calls: [{ id: "one", function: { name: "save" } }],
      },
      {
        role: "tool",
        tool_call_id: "unrelated",
        content: '{"data":{"text":"wrong"}}',
      },
      {
        role: "tool",
        tool_call_id: "one",
        content: '{"data":{"facts":{"summary":"canonical"}}}',
      },
    ],
  };
  const data = completedBusinessData(request, "save");
  const reply = submitOutputReply(data.facts);
  assert.equal(reply.text, "");
  assert.equal(reply.toolCalls.length, 1);
  assert.equal(reply.toolCalls[0].function.name, "submit-output");
  assert.deepEqual(JSON.parse(reply.toolCalls[0].function.arguments), {
    summary: "canonical",
  });
  request.rawMessages.push({
    role: "tool",
    tool_call_id: "one",
    content: '{"error":{"code":"failed"}}',
  });
  assert.equal(completedBusinessData(request, "save"), undefined);
});

test("verification CLI exposes initial selection and rejects conflicting selection flags before HTTP", (t) => {
  const run = (...args) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/e2e-plugin-verify.ts", ...args],
      { encoding: "utf8" },
    );
  const help = run("--help");
  if (help.error?.code === "EPERM") {
    t.skip(
      "Sandbox blocks subprocess execution; coordinator must verify CLI flags",
    );
    return;
  }
  assert.ifError(help.error);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--plugins <ids>/);
  const invalid = run("--plugins", "story", "--core-only");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout + invalid.stderr, /cannot be combined/);
});
