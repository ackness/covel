import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "../prompt-prefix-report.mjs";

const call = (turnId, runtimeId, body) => ({
  sessionId: "s",
  turnId,
  payload: JSON.stringify({ runtimeId, providerRequests: [{ body }] }),
});
const tool = (name) => ({ type: "function", function: { name } });
const system = { role: "system", content: "instructions ".repeat(10) };

test("the shared prefix ends where a turn's first request leaves the previous turn's", () => {
  const [entry] = buildReport([
    call("t1", "tracker", {
      tools: [tool("write")],
      messages: [system, { role: "system", content: "rows: a\ninputs: one" }],
    }),
    // A later call of the same turn (a tool loop) does not open a comparison.
    call("t1", "tracker", {
      tools: [tool("write")],
      messages: [system, { role: "user", content: "retry" }],
    }),
    call("t2", "tracker", {
      tools: [tool("write")],
      messages: [system, { role: "system", content: "rows: a\ninputs: two" }],
    }),
  ]);

  assert.equal(entry.turns, 2);
  assert.equal(entry.calls, 3);
  const [pair] = entry.pairs;
  const stable = JSON.stringify(tool("write")).length + system.content.length;
  assert.equal(pair.shared, stable + "rows: a\ninputs: ".length);
  assert.equal(pair.firstDifference, "message 2 (system)");
  assert.equal(pair.offset, "rows: a\ninputs: ".length);
});

test("a changed tool list shares nothing, whatever follows it", () => {
  const [entry] = buildReport([
    call("t1", "tracker", {
      tools: [tool("read"), tool("write")],
      messages: [system],
    }),
    call("t2", "tracker", {
      tools: [tool("write"), tool("read")],
      messages: [system],
    }),
  ]);
  const [pair] = entry.pairs;
  assert.equal(pair.firstDifference, "tool 1 (write)");
  assert.ok(pair.shared < JSON.stringify(tool("read")).length);
});
