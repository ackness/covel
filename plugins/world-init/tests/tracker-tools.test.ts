// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as toolkit from "@covel/tools";
import register from "../server/index.js";

type Hook = (
  ctx: unknown,
  payload: unknown,
) => {
  action: string;
  replace?: { tools?: Array<{ name: string }> };
};

function trackerHook(): Hook {
  const hooks: Record<string, Hook> = {};
  register({
    provideExtension: () => {},
    registerTool: () => {},
    toolkit,
    on: (event: string, handler: Hook) => {
      hooks[event] = handler;
    },
  });
  return hooks.PreLLMCall!;
}

const tools = [
  "world-dimension-get",
  "world-dimension-list",
  "dimension-rule-get",
  "update-dimensions",
  "runtime-done",
].map((name) => ({ name }));
const call = (system: string, runtimeId = "world-init/dimension-tracker") => ({
  runtimeId,
  messages: [{ role: "system", content: system }],
  tools,
});

describe("dimension tracker tools", () => {
  const hook = trackerHook();

  it("withholds the read tools when every rule is in the prompt", () => {
    const result = hook({}, call('<dimension-rules>\n<dimension id="a">…'));
    expect(result.replace?.tools?.map((tool) => tool.name)).toEqual([
      "update-dimensions",
      "runtime-done",
    ]);
  });

  it("keeps them when the rules block lists truncated dimensions", () => {
    const system =
      "<dimension-rules>\nTruncated (read with dimension-rule-get and world-dimension-get before settling these):\nb (v1): …";
    expect(hook({}, call(system))).toEqual({ action: "continue" });
  });

  it("leaves other runtimes alone", () => {
    expect(hook({}, call("<dimension-rules>", "narrator"))).toEqual({
      action: "continue",
    });
  });
});
