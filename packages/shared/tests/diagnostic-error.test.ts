import { expect, it } from "vitest";
import { diagnosticErrorKind } from "../src/utils/diagnostic-error.js";

it("only returns fixed error categories, never user-controlled names, messages or causes", () => {
  const privateError = new Error("PRIVATE_MESSAGE", { cause: "PRIVATE_CAUSE" });
  privateError.name = "PRIVATE_NAME";
  expect(diagnosticErrorKind(privateError)).toBe("error");
  expect(diagnosticErrorKind("PRIVATE_STRING")).toBe("non-error");
  expect(diagnosticErrorKind(new SyntaxError("PRIVATE_JSON"))).toBe("syntax");
  expect(diagnosticErrorKind(new TypeError("PRIVATE_URL"))).toBe("type");
  expect(
    diagnosticErrorKind(new DOMException("PRIVATE_ABORT", "AbortError")),
  ).toBe("abort");
  expect(
    diagnosticErrorKind(new DOMException("PRIVATE_TIMEOUT", "TimeoutError")),
  ).toBe("timeout");
});
