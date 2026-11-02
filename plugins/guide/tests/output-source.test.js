import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("finishes with an empty submission sourced from generate-guide", () => {
  const manifest = readFileSync(
    new URL("../PLUGIN.md", import.meta.url),
    "utf8",
  );
  expect(manifest).toMatch(/from:\s+tool: generate-guide/);
  for (const file of ["PLUGIN.md", "PLUGIN.zh.md"]) {
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
