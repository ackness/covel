/**
 * TDD RED: Tests for world package schema validation.
 *
 * Tests worldPackageMetaSchema and upgraded worldRecordCreateSchema
 * that accepts I18nText for name/description/lore fields.
 */
import { describe, it, expect } from "vitest";
import {
  worldPackageMetaSchema,
  worldRecordCreateSchema,
  worldDimensionsSchema,
  i18nTextSchema,
} from "@covel/shared";

// ─── i18nTextSchema (exported) ──────────────────────────────────────────────

describe("i18nTextSchema", () => {
  it("should accept a plain string", () => {
    const result = i18nTextSchema.safeParse("hello world");
    expect(result.success).toBe(true);
  });

  it("should accept a locale record", () => {
    const result = i18nTextSchema.safeParse({
      "zh-CN": "你好",
      "en-US": "Hello",
    });
    expect(result.success).toBe(true);
  });

  it("should reject empty string", () => {
    const result = i18nTextSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("should reject empty object", () => {
    const result = i18nTextSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("should reject non-string values in record", () => {
    const result = i18nTextSchema.safeParse({ "zh-CN": 42 });
    expect(result.success).toBe(false);
  });
});

// ─── worldPackageMetaSchema ─────────────────────────────────────────────────

describe("worldPackageMetaSchema", () => {
  const validMeta = {
    schemaVersion: "1.0",
    id: "mistport",
    name: { "zh-CN": "雾港・裂潮纪", "en-US": "Mistport Chronicles" },
    version: "0.1.0",
    summary: { "zh-CN": "一座港口城市", "en-US": "A port city" },
    defaultLocale: "zh-CN",
    supportedLocales: ["zh-CN", "en-US"],
  };

  it("should accept a valid minimal manifest", () => {
    const result = worldPackageMetaSchema.safeParse(validMeta);
    expect(result.success).toBe(true);
  });

  it("should accept manifest with all optional fields", () => {
    const full = {
      ...validMeta,
      tags: ["dark-fantasy", "mystery"],
      requiredPlugins: ["core-persona"],
      recommendedPlugins: ["core-guide"],
      dimensions: {
        tone: {
          genres: ["dark-fantasy"],
          contentRating: "teen" as const,
        },
      },
    };
    const result = worldPackageMetaSchema.safeParse(full);
    expect(result.success).toBe(true);
  });

  it("should reject missing schemaVersion", () => {
    const { schemaVersion: _, ...noVersion } = validMeta;
    const result = worldPackageMetaSchema.safeParse(noVersion);
    expect(result.success).toBe(false);
  });

  it("should reject invalid schemaVersion", () => {
    const result = worldPackageMetaSchema.safeParse({
      ...validMeta,
      schemaVersion: "2.0",
    });
    expect(result.success).toBe(false);
  });

  it("should reject id with uppercase or spaces", () => {
    const result = worldPackageMetaSchema.safeParse({
      ...validMeta,
      id: "My World",
    });
    expect(result.success).toBe(false);
  });

  it("should accept kebab-case id", () => {
    const result = worldPackageMetaSchema.safeParse({
      ...validMeta,
      id: "my-awesome-world-123",
    });
    expect(result.success).toBe(true);
  });

  it("should reject empty supportedLocales", () => {
    const result = worldPackageMetaSchema.safeParse({
      ...validMeta,
      supportedLocales: [],
    });
    expect(result.success).toBe(false);
  });

  it("should accept name as plain string (I18nText union)", () => {
    const result = worldPackageMetaSchema.safeParse({
      ...validMeta,
      name: "Simple World Name",
    });
    expect(result.success).toBe(true);
  });
});

// ─── worldRecordCreateSchema (upgraded for I18nText) ────────────────────────

describe("worldRecordCreateSchema — I18nText support", () => {
  it("should still accept plain string name and description (backward compat)", () => {
    const result = worldRecordCreateSchema.safeParse({
      name: "Test World",
      description: "A test world",
    });
    expect(result.success).toBe(true);
  });

  it("should accept I18nText object for name", () => {
    const result = worldRecordCreateSchema.safeParse({
      name: { "zh-CN": "测试世界", "en-US": "Test World" },
      description: "A test world",
    });
    expect(result.success).toBe(true);
  });

  it("should accept I18nText object for description", () => {
    const result = worldRecordCreateSchema.safeParse({
      name: "Test",
      description: { "zh-CN": "测试描述", "en-US": "Test desc" },
    });
    expect(result.success).toBe(true);
  });

  it("should accept I18nText object for lore", () => {
    const result = worldRecordCreateSchema.safeParse({
      name: "Test",
      description: "Desc",
      lore: { "zh-CN": "# 中文设定", "en-US": "# English lore" },
    });
    expect(result.success).toBe(true);
  });

  it("should accept all fields as I18nText objects", () => {
    const result = worldRecordCreateSchema.safeParse({
      name: { "zh-CN": "名称" },
      description: { "zh-CN": "描述" },
      lore: { "zh-CN": "世界观" },
      locale: "zh-CN",
      tags: ["test"],
    });
    expect(result.success).toBe(true);
  });
});
