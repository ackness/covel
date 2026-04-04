import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  createCollectingRegistrar,
} from "@covel/plugin-test-utils";
import { validateManifest } from "@covel/plugin-runtime";
import type { ToolExecutionContext, DynamicFieldSchema } from "@covel/shared";
import register from "../server/index.js";

// ── plugin.json manifest ────────────────────────────────────────

describe("plugin.json manifest", () => {
  it("passes schema validation", () => {
    const raw = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../plugin.json"), "utf-8"),
    );
    const result = validateManifest(raw);
    if (!result.ok) {
      throw new Error(
        `Manifest validation failed:\n${result.errors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});

// ── Plugin Registration ─────────────────────────────────────────

describe("register", () => {
  it("registers emit-character-form tool (no runtime handler)", () => {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);

    expect(contributions.tools.has("emit-character-form")).toBe(true);
    expect(contributions.runtimeHandlers.size).toBe(0);
    expect(contributions.hooks.size).toBe(0);
  });
});

// ── emit-character-form tool ──────────────────────────────────────

describe("emit-character-form tool", () => {
  function getToolHandler() {
    const { registrar, contributions } = createCollectingRegistrar();
    register(registrar);
    return contributions.tools.get("emit-character-form")!;
  }

  function makeCtx(
    locale: string,
    state?: Record<string, unknown>,
  ): ToolExecutionContext {
    return {
      input: {},
      locale,
      state: state ?? {},
    } as ToolExecutionContext;
  }

  it("emits a ui.render proposal with character_creation block", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx("zh-CN"));

    expect(result.proposals).toBeDefined();
    const uiRender = result.proposals!.find((p) => p.kind === "ui.render");
    expect(uiRender).toBeDefined();

    const payload = uiRender!.payload as {
      type: string;
      content: {
        fields: Array<{ id: string; type: string; label: string; required?: boolean }>;
        submitLabel: string;
        submitMapping: Record<string, string>;
      };
    };

    expect(payload.type).toBe("character_creation");
    expect(payload.content.fields).toHaveLength(1);
    expect(payload.content.fields[0]!.id).toBe("character_name");
    expect(payload.content.fields[0]!.type).toBe("text");
    expect(payload.content.fields[0]!.required).toBe(true);
    expect(payload.content.submitMapping.character_name).toBe("name");
  });

  it("uses Chinese labels for zh-CN locale", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx("zh-CN"));

    const uiRender = result.proposals!.find((p) => p.kind === "ui.render");
    const payload = uiRender!.payload as {
      content: {
        fields: Array<{ label: string; placeholder: string }>;
        submitLabel: string;
      };
    };

    expect(payload.content.fields[0]!.label).toBe("你的名字");
    expect(payload.content.fields[0]!.placeholder).toContain("键入");
    expect(payload.content.submitLabel).toBe("确认");
  });

  it("uses English labels for en-US locale", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx("en-US"));

    const uiRender = result.proposals!.find((p) => p.kind === "ui.render");
    const payload = uiRender!.payload as {
      content: {
        fields: Array<{ label: string; placeholder: string }>;
        submitLabel: string;
      };
    };

    expect(payload.content.fields[0]!.label).toBe("Your Name");
    expect(payload.content.fields[0]!.placeholder).toContain("Type your name");
    expect(payload.content.submitLabel).toBe("Confirm");
  });

  it("includes bio fields from schema when available", async () => {
    const handler = getToolHandler();
    const schema: DynamicFieldSchema = {
      worldId: "world_test",
      fields: [
        { key: "gender", label: "性别", type: "enum", category: "bio", options: ["男", "女"], visible: true },
        { key: "hp", label: "生命值", type: "number", category: "stats", visible: true },
        { key: "hidden_field", label: "隐藏", type: "string", category: "bio", visible: false },
      ],
    };

    const result = await handler(makeCtx("zh-CN", {
      characterFieldSchema: schema,
    }));

    const uiRender = result.proposals!.find((p) => p.kind === "ui.render");
    const payload = uiRender!.payload as {
      content: {
        fields: Array<{ id: string; label: string; type: string; options?: string[] }>;
        submitMapping: Record<string, string>;
      };
    };

    // name + gender (bio visible), NOT hp (stats), NOT hidden_field (visible=false)
    expect(payload.content.fields).toHaveLength(2);
    expect(payload.content.fields[0]!.id).toBe("character_name");
    expect(payload.content.fields[1]!.id).toBe("field_gender");
    expect(payload.content.fields[1]!.type).toBe("select");
    expect(payload.content.fields[1]!.options).toEqual(["男", "女"]);
    expect(payload.content.submitMapping["field_gender"]).toBe("fields.gender");
  });

  it("returns success output message", async () => {
    const handler = getToolHandler();
    const result = await handler(makeCtx("zh-CN"));

    expect(result.output).toEqual(expect.objectContaining({
      message: expect.any(String),
    }));
  });
});
