import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("finishes with an empty submission sourced from advance-world-time", () => {
  const manifest = readFileSync(
    new URL("../runtimes/advance/RUNTIME.md", import.meta.url),
    "utf8",
  );
  expect(manifest).toMatch(/from:\s+tool: advance-world-time/);
  for (const file of [
    "runtimes/advance/RUNTIME.md",
    "runtimes/advance/RUNTIME.zh.md",
  ]) {
    const prompt = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    expect(prompt).toContain("`submit-output`");
    expect(prompt).toContain("{}");
  }
  const entry = readFileSync(
    new URL("../server/index.js", import.meta.url),
    "utf8",
  );
  expect(entry).not.toContain('covel.on("ReviewAgentOutput"');
});
