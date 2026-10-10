// @vitest-environment node
import { describe, expect, it } from "vitest";
import { approvalConfirmMessage } from "../approval-message.js";

const t = (key: string, options?: Record<string, unknown>): string => {
  let text = String(options?.defaultValue ?? key);
  for (const [name, value] of Object.entries(options ?? {}))
    text = text.replaceAll(`{{${name}}}`, String(value));
  return text;
};

describe("approvalConfirmMessage", () => {
  it("explains server-code and runtime grants without the internal action id", () => {
    const code = approvalConfirmMessage(t, "p1", "covel:plugin-server-code");
    expect(code).toContain("without a process sandbox");
    expect(code).not.toContain("covel:plugin-server-code");
    expect(approvalConfirmMessage(t, "p1", "runtime:p1/draw")).toContain(
      "p1/draw",
    );
  });

  it("keeps the generic wording for other actions", () => {
    expect(approvalConfirmMessage(t, "p1", "generate-image")).toContain(
      "generate-image",
    );
  });
});
