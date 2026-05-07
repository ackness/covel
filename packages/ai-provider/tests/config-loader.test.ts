import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAiConfig, parseAiConfig } from "../src/config/loader.js";

describe("config-loader", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let tmpDir: string;

  beforeEach(() => {
    savedEnv.TEST_BASE_URL = process.env.TEST_BASE_URL;
    savedEnv.TEST_OTHER_URL = process.env.TEST_OTHER_URL;
    process.env.TEST_BASE_URL = "https://api.test.com/v1";
    process.env.TEST_OTHER_URL = "https://other.test.com/v1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-ai-config-"));
  });

  afterEach(() => {
    process.env.TEST_BASE_URL = savedEnv.TEST_BASE_URL;
    process.env.TEST_OTHER_URL = savedEnv.TEST_OTHER_URL;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("parses a minimal TOML config", () => {
    const config = parseAiConfig(`
[providers.test]
baseUrl = "https://api.test.com/v1"
protocol = "openai-chat-v1"

[[presets]]
id = "default"
name = "Test Preset"
provider = "test"
model = "test-model"
tier = "medium"
supportedModes = ["text", "stream"]
enabled = true
isDefault = true
`);

    expect(config.providers.test).toBeDefined();
    expect(config.providers.test.baseUrl).toBe("https://api.test.com/v1");
    expect(config.presets).toHaveLength(1);
    expect(config.presets[0].id).toBe("default");
    expect(config.presets[0].model).toBe("test-model");
  });

  it("interpolates ${VAR} from process.env", () => {
    const config = parseAiConfig(`
[providers.test]
baseUrl = "\${TEST_BASE_URL}"
protocol = "openai-chat-v1"

[providers.other]
baseUrl = "\${TEST_OTHER_URL}"
protocol = "openai-chat-v1"
`);

    expect(config.providers.test.baseUrl).toBe("https://api.test.com/v1");
    expect(config.providers.other.baseUrl).toBe("https://other.test.com/v1");
  });

  it("reads process.env at parse time so runtime key changes are visible", () => {
    const toml = `
[providers.test]
baseUrl = "\${TEST_BASE_URL}"
protocol = "openai-chat-v1"
`;

    expect(parseAiConfig(toml).providers.test.baseUrl).toBe(
      "https://api.test.com/v1",
    );
    process.env.TEST_BASE_URL = "https://api.changed.test/v1";
    expect(parseAiConfig(toml).providers.test.baseUrl).toBe(
      "https://api.changed.test/v1",
    );
  });

  it("loads TOML from disk and reports read failures with the resolved path", () => {
    const file = path.join(tmpDir, "llm.toml");
    fs.writeFileSync(
      file,
      `
[providers.test]
baseUrl = "\${TEST_BASE_URL}"
protocol = "openai-chat-v1"
`,
    );

    expect(loadAiConfig(file).providers.test.baseUrl).toBe(
      "https://api.test.com/v1",
    );

    const missing = path.join(tmpDir, "missing.toml");
    expect(() => loadAiConfig(missing)).toThrow(
      `failed to read file "${missing}"`,
    );
  });

  it("throws on unresolved env variable", () => {
    expect(() =>
      parseAiConfig(`
[providers.test]
baseUrl = "\${NONEXISTENT_VAR_12345}"
`),
    ).toThrow("unresolved environment variables: NONEXISTENT_VAR_12345");
  });

  it("validates preset schema", () => {
    expect(() =>
      parseAiConfig(`
[[presets]]
id = "bad"
name = "Bad"
provider = "test"
model = "m"
tier = "invalid_tier"
supportedModes = ["text"]
enabled = true
`),
    ).toThrow();
  });

  it("defaults empty providers and presets", () => {
    const config = parseAiConfig("");
    expect(config.providers).toEqual({});
    expect(config.presets).toEqual([]);
    expect(config.profiles).toEqual([]);
  });

  it("parses fallbackPresetIds", () => {
    const config = parseAiConfig(`
[[presets]]
id = "primary"
name = "Primary"
provider = "a"
model = "m1"
tier = "medium"
supportedModes = ["text"]
enabled = true
fallbackPresetIds = ["secondary"]

[[presets]]
id = "secondary"
name = "Secondary"
provider = "b"
model = "m2"
tier = "small"
supportedModes = ["text"]
enabled = true
`);

    expect(config.presets[0].fallbackPresetIds).toEqual(["secondary"]);
  });
});
