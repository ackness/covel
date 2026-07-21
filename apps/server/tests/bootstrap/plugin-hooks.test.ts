/**
 * Legacy `hooks:` trust gating at the bootstrap seam.
 *
 * `createBootstrapHookPipeline` registers hook declarations for every trust
 * tier, but community (non-autoLoad) handlers must stay dormant — never
 * import()'d, never executed — until the plugin is approved. The approval
 * seam is `ensurePluginEntry` (createBootstrapPluginEntries), the same seam
 * that unlocks deferred entries / local tools / wires.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ParsedPluginMd,
  PluginDiscoveryResult,
} from "@covel/plugin-loader";
import type { HookContext } from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { ToolModule } from "@covel/tools";
import { createBootstrapHookPipeline } from "../../src/routes/api/bootstrap/plugin-hooks.js";
import { createBootstrapPluginEntries } from "../../src/routes/api/bootstrap/plugin-entry.js";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "covel-hook-boot-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const importCounts = (): Record<string, number> => {
  const g = globalThis as Record<string, unknown>;
  g.__covelBootHookImports ??= {};
  return g.__covelBootHookImports as Record<string, number>;
};

function writeHookPlugin(
  pluginId: string,
  source: "builtin" | "community",
): { discovery: PluginDiscoveryResult; parsed: ParsedPluginMd } {
  const rootPath = path.join(tmpRoot, pluginId);
  fs.mkdirSync(path.join(rootPath, "server"), { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, "server", "hook.mjs"),
    `
const counts = (globalThis.__covelBootHookImports ??= {});
counts["${pluginId}"] = (counts["${pluginId}"] ?? 0) + 1;
export default async () => ({ action: "abort", reason: "${pluginId} ran" });
`,
  );
  const manifest = {
    name: pluginId,
    pluginId,
    description: pluginId,
    hooks: [{ event: "TurnStart", handler: "server/hook.mjs" }],
  } as unknown as RuntimeManifest;
  return {
    discovery: {
      id: pluginId,
      rootPath,
      isMultiRuntime: false,
      pluginMdPaths: [path.join(rootPath, "PLUGIN.md")],
      source,
    },
    parsed: { manifest, promptTemplate: "", rawFrontmatter: {} },
  };
}

const hookCtx = { sessionId: "s1", turnId: "t1" } as unknown as HookContext;

describe("createBootstrapHookPipeline trust gating", () => {
  it("keeps a community legacy hook dormant until ensurePluginEntry approves it", async () => {
    const community = writeHookPlugin("hook-community-a", "community");
    const discoveryMap = new Map([
      [community.discovery.id, community.discovery],
    ]);
    const manifestCache = new Map([
      [community.discovery.id, [community.parsed]],
    ]);

    const hookPipeline = createBootstrapHookPipeline({
      discoveryMap,
      manifestCache,
      isCommunityServerCodeApproved: (sessionId) => sessionId === "s1",
    });
    // Boot registered the declaration but imported nothing.
    expect(importCounts()["hook-community-a"]).toBeUndefined();

    // Firing pre-approval executes nothing — and still imports nothing.
    const before = await hookPipeline.run("TurnStart", hookCtx, {});
    expect(before.action).toBe("continue");
    expect(importCounts()["hook-community-a"]).toBeUndefined();

    // Approval seam (same wiring order as bootstrap.ts): the entry
    // registrar shares the pipeline and unlocks the plugin's hooks.
    const { ensurePluginEntry } = await createBootstrapPluginEntries({
      discoveryMap,
      manifestCache,
      store: createMemoryStore(),
      toolMap: new Map<string, ToolModule>(),
      localToolNames: new Set<string>(),
      pluginToolAccess: new Map<string, Set<string>>(),
      hookPipeline,
      rpcRegistry: (await import("@covel/runtime")).createPluginRpcRegistry(),
      isCommunityServerCodeApproved: (sessionId) => sessionId === "s1",
      isCommunityHookApproved: (sessionId) => sessionId === "s1",
    });
    await ensurePluginEntry("hook-community-a", "s1");

    const after = await hookPipeline.run("TurnStart", hookCtx, {});
    expect(after).toEqual({ action: "abort", reason: "hook-community-a ran" });
    expect(importCounts()["hook-community-a"]).toBe(1);

    const otherSession = await hookPipeline.run(
      "TurnStart",
      { ...hookCtx, sessionId: "s2" },
      {},
    );
    expect(otherSession.action).toBe("continue");
  });

  it("builtin legacy hooks fire from the first event without any activation", async () => {
    const builtin = writeHookPlugin("hook-builtin-a", "builtin");
    const hookPipeline = createBootstrapHookPipeline({
      discoveryMap: new Map([[builtin.discovery.id, builtin.discovery]]),
      manifestCache: new Map([[builtin.discovery.id, [builtin.parsed]]]),
    });

    const result = await hookPipeline.run("TurnStart", hookCtx, {});
    expect(result).toEqual({ action: "abort", reason: "hook-builtin-a ran" });
    expect(importCounts()["hook-builtin-a"]).toBe(1);
  });
});
