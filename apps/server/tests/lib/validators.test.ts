import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE } from "@covel/shared";
import { normalizeLocale } from "../../src/lib/validators.js";
import { validateActionRequest } from "../../src/routes/api/actions/request.js";

describe("locale validation", () => {
  it("accepts safe BCP 47 script and region chains", () => {
    expect(normalizeLocale("ru-RU")).toBe("ru-RU");
    expect(normalizeLocale("sr-Latn-RS")).toBe("sr-Latn-RS");
    expect(normalizeLocale("zh-Hant-TW")).toBe("zh-Hant-TW");
    expect(normalizeLocale(" en_u_ca_gregory ")).toBe("en-u-ca-gregory");
  });

  it("gives an action request no way to change the session's locale", () => {
    const action = {
      requestId: "request-1",
      sessionId: "session-1",
      type: "send_message",
      payload: { content: "hello" },
    };
    expect(validateActionRequest(action).ok).toBe(true);
    // The content locale is fixed when the session is created.
    expect(validateActionRequest({ ...action, locale: "en-US" }).ok).toBe(
      false,
    );
  });

  it("rejects path-like locale values through the registry default", () => {
    expect(normalizeLocale("../../etc/passwd")).toBe(DEFAULT_LOCALE);
    expect(normalizeLocale("en-US.json")).toBe(DEFAULT_LOCALE);
  });
});
