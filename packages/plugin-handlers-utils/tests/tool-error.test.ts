import {
  ToolError as PublicToolError,
  TOOL_ERROR_CODES as PUBLIC_TOOL_ERROR_CODES,
} from "@covel/plugin-handlers-utils";
import {
  ToolError as HostToolError,
  isToolError as isHostToolError,
  TOOL_ERROR_CODES as HOST_TOOL_ERROR_CODES,
} from "@covel/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  TOOL_ERROR_CODES,
  ToolError,
  isToolError,
  ToolValidationError,
  withModelView,
  withPendingProposals,
  withEmittedEvents,
  getModelView,
  getPendingProposals,
  getEmittedEvents,
  getToolContent,
  type PluginProposal,
} from "../src/index.js";

describe("coded tool errors", () => {
  it("shares error vocabulary and constructors with the host exports", () => {
    expect(HostToolError).toBe(PublicToolError);
    expect(HOST_TOOL_ERROR_CODES).toBe(PUBLIC_TOOL_ERROR_CODES);
    expect(HOST_TOOL_ERROR_CODES).toEqual(TOOL_ERROR_CODES);
    const hostError = new HostToolError("invalid-input", "Bad input", {
      hint: "Fix the fields",
    });
    const authorError = new ToolError("refused", "No work");
    expect(hostError).toBeInstanceOf(HostToolError);
    expect(isToolError(hostError)).toBe(true);
    expect(isHostToolError(authorError)).toBe(true);
    expect(hostError).toMatchObject({
      name: "ToolError",
      code: "invalid-input",
      message: "Bad input",
      hint: "Fix the fields",
    });
  });
  it("recognizes subclasses and errors from a second SDK copy", () => {
    const parsed = z.string().safeParse(1);
    if (parsed.success) throw new Error("Expected invalid input");
    const validation = new ToolValidationError(parsed.error);
    expect(validation.code).toBe("invalid-input");
    const foreign = Object.assign(new Error("foreign"), {
      name: "ToolError",
      code: "ambiguous",
    });
    for (const error of [
      new ToolError("not-found", "missing"),
      validation,
      foreign,
    ])
      expect(isToolError(error)).toBe(true);
    expect(
      isToolError(
        Object.assign(new Error("old"), { code: "VALIDATION_ERROR" }),
      ),
    ).toBe(false);
    expect(isToolError({ code: "internal" })).toBe(false);
  });
});

describe("tool result composition", () => {
  const proposal: PluginProposal = {
    id: "write",
    type: "plugin.data",
    source: { pluginId: "p", runtimeId: "p/r" },
    sessionId: "s",
    turnId: "t",
    timestamp: "2026-10-01T00:00:00Z",
    payload: { namespace: "notes", key: "k", value: 1 },
  };
  const events = [{ topic: "changed", data: {} }];
  const model = { summary: "Queued", data: { n: 1 } };
  const content = Object.freeze({ secret: 1 });
  it.each([
    () =>
      withModelView(
        withEmittedEvents(withPendingProposals(content, [proposal]), events),
        model,
      ),
    () =>
      withPendingProposals(
        withModelView(withEmittedEvents(content, events), model),
        [proposal],
      ),
    () =>
      withEmittedEvents(
        withPendingProposals(withModelView(content, model), [proposal]),
        events,
      ),
    () =>
      withModelView(
        withPendingProposals(withEmittedEvents(content, events), [proposal]),
        model,
      ),
    () =>
      withPendingProposals(
        withEmittedEvents(withModelView(content, model), events),
        [proposal],
      ),
    () =>
      withEmittedEvents(
        withModelView(withPendingProposals(content, [proposal]), model),
        events,
      ),
  ])(
    "keeps content, model view, proposals and events in every order (%#)",
    (compose) => {
      const result = compose();
      expect(getToolContent(result)).toBe(content);
      for (const copy of [
        result,
        { ...result },
        structuredClone(result),
        JSON.parse(JSON.stringify(result)),
      ]) {
        expect(getToolContent(copy)).toEqual(content);
        expect(getModelView(copy)).toEqual(model);
        expect(getPendingProposals(copy)).toEqual([proposal]);
        expect(getEmittedEvents(copy)).toEqual(events);
      }
    },
  );
});
