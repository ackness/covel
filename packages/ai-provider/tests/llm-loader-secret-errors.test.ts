import { afterEach, describe, expect, it } from "vitest";
import { parseLlmConfig } from "../src/config/llm-loader.js";

const SECRET = "sk-should-not-leak-0123456789";

function messageOf(toml: string): string {
  try {
    parseLlmConfig(toml);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected parseLlmConfig to throw");
}

describe("llm.toml errors never quote an environment value", () => {
  afterEach(() => {
    delete process.env.SECRET_X;
  });

  it("a syntax error on an interpolated line names line and column only", () => {
    process.env.SECRET_X = SECRET;
    // The forgotten quotes are the common slip.
    const message = messageOf(`[covel.story]
provider = "deepseek"
apiKey = \${SECRET_X}
`);
    expect(message).not.toContain(SECRET);
    expect(message).toMatch(/line 3, column \d+/);
  });

  it("a validation error does not quote a value used as a slot name", () => {
    process.env.SECRET_X = SECRET;
    const message = messageOf(`[covel.\${SECRET_X}]
provider = "deepseek"
`);
    expect(message).toContain("${SECRET_X}");
    expect(message).not.toContain(SECRET);
  });

  it("an unresolved variable still names the variable", () => {
    delete process.env.SECRET_MISSING;
    expect(messageOf(`x = "\${SECRET_MISSING}"`)).toContain("SECRET_MISSING");
  });
});
