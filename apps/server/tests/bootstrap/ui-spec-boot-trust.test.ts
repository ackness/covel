/**
 * S-04 regression: a community (non-autoLoad) plugin that declares a `ui`
 * block must NOT have its handler / wires JS imported by the boot-time
 * eager UI-spec load (bootstrap step 6b). Builtin plugins keep loading
 * fully at boot.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore } from "@covel/store";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";

const BUILTIN_FLAG = "__covelBuiltinHandlerImported";
const COMMUNITY_HANDLER_FLAG = "__covelCommunityHandlerImported";
const COMMUNITY_WIRES_FLAG = "__covelCommunityWiresImported";

const stubLLM: LLMAdapter = {
  async generate(): Promise<LLMResponse> {
    return { content: "", toolCalls: [], finishReason: "stop" };
  },
};

const PANEL_JSON = JSON.stringify({
  id: "boot-trust-panel",
  label: { zh: "面板", en: "Panel" },
  icon: "layout",
  dataSource: { namespace: "entries" },
  view: { component: "Stack", children: [] },
});

function writeUiPlugin(
  dir: string,
  pluginId: string,
  importFlags: { handler: string; wires?: string },
): void {
  const root = path.join(dir, pluginId);
  fs.mkdirSync(path.join(root, "ui"), { recursive: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "PLUGIN.md"),
    `---
name: ${pluginId}
description: boot trust fixture
priority: 500
runtimeType: function
handler: ./server/handler.mjs
${importFlags.wires ? "wires: ./server/wires.mjs" : ""}
trigger:
  type: manual
ui:
  right:
    - ./ui/panel.json
---

Fixture prompt.
`,
  );
  fs.writeFileSync(path.join(root, "ui", "panel.json"), PANEL_JSON);
  fs.writeFileSync(
    path.join(root, "server", "handler.mjs"),
    `globalThis.${importFlags.handler} = true;\nexport default async function handler() { return { proposals: [] }; }\n`,
  );
  if (importFlags.wires) {
    fs.writeFileSync(
      path.join(root, "server", "wires.mjs"),
      `globalThis.${importFlags.wires} = true;\nexport default { image: [] };\n`,
    );
  }
}

describe("bootstrap step 6b: UI-spec eager load respects plugin trust (S-04)", () => {
  let tmpRoot: string;
  let result: Awaited<ReturnType<typeof bootstrapApi>>;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "covel-ui-boot-trust-"));
    const builtinDir = path.join(tmpRoot, "builtin");
    const communityDir = path.join(tmpRoot, "community");
    fs.mkdirSync(builtinDir, { recursive: true });
    fs.mkdirSync(communityDir, { recursive: true });

    // First dir → source 'builtin'; second dir → source 'community'.
    writeUiPlugin(builtinDir, "builtin-ui-plugin", { handler: BUILTIN_FLAG });
    writeUiPlugin(communityDir, "community-ui-plugin", {
      handler: COMMUNITY_HANDLER_FLAG,
      wires: COMMUNITY_WIRES_FLAG,
    });

    result = await bootstrapApi({
      pluginsDir: builtinDir,
      pluginsDirs: [builtinDir, communityDir],
      llmAdapter: stubLLM,
      store: createMemoryStore(),
      storeBackend: "memory",
    });
  });

  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    const g = globalThis as Record<string, unknown>;
    delete g[BUILTIN_FLAG];
    delete g[COMMUNITY_HANDLER_FLAG];
    delete g[COMMUNITY_WIRES_FLAG];
  });

  it("does not import a community plugin's handler or wires JS at boot", () => {
    const g = globalThis as Record<string, unknown>;
    expect(g[COMMUNITY_HANDLER_FLAG]).toBeUndefined();
    expect(g[COMMUNITY_WIRES_FLAG]).toBeUndefined();
    expect(
      result.registry.get("community-ui-plugin")?.loadedRuntimes.size,
    ).toBe(0);
  });

  it("still fully loads builtin UI-declaring runtimes at boot", () => {
    const g = globalThis as Record<string, unknown>;
    expect(g[BUILTIN_FLAG]).toBe(true);
    const entry = result.registry.get("builtin-ui-plugin");
    const loaded = entry?.loadedRuntimes.get("builtin-ui-plugin");
    expect(loaded?.uiSpecs?.right).toHaveLength(1);
  });
});
