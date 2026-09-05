import { describe, expect, it } from "vitest";
import { buildPluginCommandRequest } from "../plugin-command.js";

describe("plugin JSON-render command binding", () => {
  it("binds the command id to the rendering plugin", () => {
    expect(
      buildPluginCommandRequest("dice-check", {
        command: "roll",
        args: { notation: "2d6" },
      }),
    ).toEqual({
      ok: true,
      command: "roll",
      request: {
        kind: "command",
        commandId: "dice-check:roll",
        args: { notation: "2d6" },
      },
    });
  });

  it("rejects cross-namespace command ids and non-object args", () => {
    expect(
      buildPluginCommandRequest("dice-check", { command: "other:roll" }),
    ).toMatchObject({ ok: false });
    expect(
      buildPluginCommandRequest("dice-check", {
        command: "roll",
        args: ["2d6"],
      }),
    ).toMatchObject({ ok: false });
  });
});
