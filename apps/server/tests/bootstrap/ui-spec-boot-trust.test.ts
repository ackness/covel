/** Regression: UI discovery is declaration-only and never imports runtime code. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LLMAdapter, LLMResponse } from "@covel/runtime";
import { createMemoryStore } from "@covel/store";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { buildUiSpecsResponse } from "../../src/routes/misc-api/ui-specs.js";

const BUILTIN_FLAG = "__covelBuiltinHandlerImported";
const COMMUNITY_HANDLER_FLAG = "__covelCommunityHandlerImported";
const COMMUNITY_ENTRY_FLAG = "__covelCommunityEntryImported";

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
  importFlags: { handler: string; entry?: string },
): void {
  const root = path.join(dir, pluginId);
  fs.mkdirSync(path.join(root, "ui"), { recursive: true });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "PLUGIN.md"),
    `---
name: ${pluginId}
description: boot trust fixture
runtimeType: function
handler: ./server/handler.mjs
${importFlags.entry ? "entry: ./server/entry.mjs" : ""}
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
  if (importFlags.entry) {
    fs.writeFileSync(
      path.join(root, "server", "entry.mjs"),
      `globalThis.${importFlags.entry} = true;\nexport default function entry() {}\n`,
    );
  }
}

describe("bootstrap UI-spec declaration discovery", () => {
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
      entry: COMMUNITY_ENTRY_FLAG,
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
    delete g[COMMUNITY_ENTRY_FLAG];
  });

  it("does not import community runtime or entry code at boot", () => {
    const g = globalThis as Record<string, unknown>;
    expect(g[COMMUNITY_HANDLER_FLAG]).toBeUndefined();
    expect(g[COMMUNITY_ENTRY_FLAG]).toBeUndefined();
    expect(
      result.registry.get("community-ui-plugin")?.loadedRuntimes.size,
    ).toBe(0);
  });

  it("reads builtin UI declarations without loading the runtime", async () => {
    const g = globalThis as Record<string, unknown>;
    expect(g[BUILTIN_FLAG]).toBeUndefined();
    const entry = result.registry.get("builtin-ui-plugin");
    expect(entry?.loadedRuntimes.size).toBe(0);

    const response = await buildUiSpecsResponse({
      registry: result.registry,
      store: result.store,
    });
    expect(response.right).toEqual([
      expect.objectContaining({ pluginId: "builtin-ui-plugin" }),
      expect.objectContaining({ pluginId: "community-ui-plugin" }),
    ]);
  });
});
