import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveImageWire } from "../../../../scripts/lib/image-gen-common.mjs";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "covel-image-config-"));
  vi.stubEnv("COVEL_HOME", home);
  vi.stubEnv("COVEL_LLM_TOML", "");
  vi.stubEnv("COVEL_IMG_KEY", "synthetic-image-key");
  vi.stubEnv("AUDIT_IMAGE_BASE_URL", "https://example.com/v1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

const slot = `[covel.image]
provider = "openai"
model = "fixture-image"
baseUrl = "\${AUDIT_IMAGE_BASE_URL}"
protocol = "openai-chat-v1"
`;

it.each([
  'providerRequestMetadata = { imageWire = "dashscope-wan" }',
  '[covel.image.providerRequestMetadata]\nimageWire = "dashscope-wan"',
])("uses the application TOML schema: %s", async (metadata) => {
  await writeFile(join(home, "llm.toml"), slot + metadata, "utf8");
  const result = await resolveImageWire("image");
  expect(result.wireId).toBe("dashscope-wan");
  expect(result.config).toEqual({
    baseUrl: "https://example.com/v1",
    apiKey: "synthetic-image-key",
  });
});

it("honors explicit config and provider environment keys", async () => {
  const configPath = join(home, "custom.toml");
  await writeFile(configPath, slot, "utf8");
  await writeFile(
    join(home, "keys.env"),
    'OPENAI_API_KEY="file-key" # comment\n',
    "utf8",
  );
  vi.stubEnv("COVEL_LLM_TOML", configPath);
  vi.stubEnv("COVEL_IMG_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "shell-key");
  expect((await resolveImageWire("image")).config.apiKey).toBe("shell-key");
  vi.stubEnv("OPENAI_API_KEY", "");
  expect((await resolveImageWire("image")).config.apiKey).toBe("file-key");
});

it("rejects invalid or missing slots before generation", async () => {
  await writeFile(join(home, "llm.toml"), slot, "utf8");
  await expect(resolveImageWire("missing")).rejects.toThrow("missing");
  await writeFile(join(home, "llm.toml"), "invalid = [", "utf8");
  await expect(resolveImageWire("image")).rejects.toThrow();
});
