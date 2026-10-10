import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureBootKeySources,
  envOverriddenProviders,
} from "../../src/lib/env-key-overrides.js";

let home: string;
const saved = (body: string) =>
  writeFileSync(path.join(home, "keys.env"), body);

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "covel-key-sources-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("envOverriddenProviders", () => {
  it("flags a saved key that the environment replaces", () => {
    saved("DEEPSEEK_API_KEY=saved\n");
    vi.stubEnv("DEEPSEEK_API_KEY", "from-shell");
    captureBootKeySources(home);
    expect(envOverriddenProviders(home)).toEqual(["deepseek"]);
  });

  it("does not flag a value that was merged in from keys.env", () => {
    saved("DEEPSEEK_API_KEY=saved\n");
    vi.stubEnv("DEEPSEEK_API_KEY", "saved");
    captureBootKeySources(home);
    expect(envOverriddenProviders(home)).toEqual([]);
    // Saving a new key later is not an override: the next start merges it.
    saved("DEEPSEEK_API_KEY=newer\n");
    expect(envOverriddenProviders(home)).toEqual([]);
  });

  it("keeps flagging after a save, and stops once the saved key matches", () => {
    saved("DEEPSEEK_API_KEY=saved\n");
    vi.stubEnv("DEEPSEEK_API_KEY", "from-shell");
    captureBootKeySources(home);
    saved("DEEPSEEK_API_KEY=other\n");
    expect(envOverriddenProviders(home)).toEqual(["deepseek"]);
    saved("DEEPSEEK_API_KEY=from-shell\n");
    expect(envOverriddenProviders(home)).toEqual([]);
  });

  it("reports nothing without a saved key or outside desktop", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "from-shell");
    captureBootKeySources(home);
    expect(envOverriddenProviders(home)).toEqual([]);
    expect(envOverriddenProviders(null)).toEqual([]);
  });
});
