import { describe, expect, it } from "vitest";
import { validatePluginHookRegistration } from "../src/plugin-hook-registration.js";

const handler = async () => ({ action: "continue" });
describe("shared plugin hook registration validation", () => {
  it.each([
    null,
    { match: "yes" },
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { enforce: "unknown" },
    { extra: true },
  ])("rejects invalid options %j", (options) => {
    expect(() =>
      validatePluginHookRegistration("TurnStart", handler, options),
    ).toThrow("on:");
  });
  it("validates the event and handler without depending on a running turn", () => {
    expect(() =>
      validatePluginHookRegistration("Unknown", handler, undefined),
    ).toThrow("unknown hook event");
    expect(() =>
      validatePluginHookRegistration("TurnStart", null, undefined),
    ).toThrow("handler function");
    expect(() =>
      validatePluginHookRegistration("TurnStart", handler, {
        match: () => true,
        timeoutMs: 5,
        enforce: "pre",
      }),
    ).not.toThrow();
  });
  it("preserves the host's registration error classification", () => {
    const invalid = (message: string) =>
      Object.assign(new Error(message), {
        code: "plugin_registration_invalid",
      });
    expect(() =>
      validatePluginHookRegistration("TurnStart", handler, null, invalid),
    ).toThrowError(
      expect.objectContaining({ code: "plugin_registration_invalid" }),
    );
  });
});
