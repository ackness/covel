// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const readme = readFileSync(new URL("README.md", root), "utf8");
const manifest = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
) as {
  readonly exports: Readonly<Record<string, unknown>>;
  readonly peerDependencies: Readonly<Record<string, string>>;
};

describe("SDK README", () => {
  it("states the zod range the package declares", () => {
    const range = manifest.peerDependencies.zod;
    expect(range).toBeDefined();
    expect(readme).toContain(`\`zod\` peer package (\`${range}\`)`);
  });

  it("describes every subpath the package exports", () => {
    const subpaths = Object.keys(manifest.exports)
      .filter((path) => path !== ".")
      .map((path) => path.replace(/^\.\//, ""));
    expect(subpaths.length).toBeGreaterThan(0);
    for (const subpath of subpaths)
      expect(readme, subpath).toContain(`\`${subpath}\` subpath`);
  });
});
