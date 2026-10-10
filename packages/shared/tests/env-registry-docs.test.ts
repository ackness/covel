import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COVEL_ENV_REGISTRY } from "../src/env/registry.js";

const GUIDE = path.resolve(
  import.meta.dirname,
  "../../../docs/guide/env-registry.md",
);

describe("environment variable guide", () => {
  it("mentions every variable declared in the registry", () => {
    const guide = readFileSync(GUIDE, "utf8");
    const missing = COVEL_ENV_REGISTRY.map((def) => def.name).filter(
      (name) => !guide.includes(name),
    );
    expect(missing, "add these to docs/guide/env-registry.md").toEqual([]);
  });
});
