/**
 * Deferred (community) legacy hook gating (re-review H-03).
 *
 * A community plugin's `hooks:` handler module must NOT be import()'d — and
 * therefore must not execute any code — until the plugin is approved and
 * `activateDeferredPluginHooks` unlocks it. Import side effects are the
 * observable: the handler module bumps a globalThis counter at module scope.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import {
  registerPluginHooks,
  activateDeferredPluginHooks,
} from "../src/hooks/register-plugin-hooks.js";
import type { HookContext } from "../src/hooks/types.js";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "covel-deferred-hooks-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const importCounts = (): Record<string, number> => {
  const g = globalThis as Record<string, unknown>;
  g.__covelHookImportCounts ??= {};
  return g.__covelHookImportCounts as Record<string, number>;
};

/** Write a hook handler whose module load is observable via a counter. */
function writeHandler(pluginId: string): string {
  const rootPath = path.join(tmpRoot, pluginId);
  fs.mkdirSync(rootPath, { recursive: true });
  fs.writeFileSync(
    path.join(rootPath, "hook.mjs"),
    `
const counts = (globalThis.__covelHookImportCounts ??= {});
counts["${pluginId}"] = (counts["${pluginId}"] ?? 0) + 1;
export default async () => ({ action: "abort", reason: "handler ran" });
`,
  );
  return rootPath;
}

const ctx = { sessionId: "s1", turnId: "t1" } as unknown as HookContext;

describe("registerPluginHooks deferred gating (H-03)", () => {
  it("does not import a deferred handler at registration or invocation; activation unlocks it", async () => {
    const pluginId = "deferred-community";
    const rootPath = writeHandler(pluginId);
    const pipeline = createHookPipeline();

    const registered = registerPluginHooks(pipeline, [
      {
        pluginId,
        rootPath,
        hooks: [{ event: "TurnStart", handler: "hook.mjs" }],
        deferred: true,
      },
    ]);
    expect(registered).toBe(1);
    // Registration alone imports nothing.
    expect(importCounts()[pluginId]).toBeUndefined();

    // Firing the event BEFORE activation is a dormant no-op continue —
    // crucially, the handler module is still not imported.
    const before = await pipeline.run("TurnStart", ctx, {});
    expect(before.action).toBe("continue");
    expect(importCounts()[pluginId]).toBeUndefined();

    // Approval seam unlocks the handler; next fire imports and executes it.
    activateDeferredPluginHooks(pipeline, pluginId);
    const after = await pipeline.run("TurnStart", ctx, {});
    expect(after).toEqual({ action: "abort", reason: "handler ran" });
    expect(importCounts()[pluginId]).toBe(1);
  });

  it("activation is scoped to the pipeline instance", async () => {
    const pluginId = "deferred-scoped";
    const rootPath = writeHandler(pluginId);
    const source = {
      pluginId,
      rootPath,
      hooks: [{ event: "TurnStart" as const, handler: "hook.mjs" }],
      deferred: true,
    };
    const pipelineA = createHookPipeline();
    const pipelineB = createHookPipeline();
    registerPluginHooks(pipelineA, [source]);
    registerPluginHooks(pipelineB, [source]);

    // Activating on A must not unlock the same plugin's hooks on B.
    activateDeferredPluginHooks(pipelineA, pluginId);
    const onB = await pipelineB.run("TurnStart", ctx, {});
    expect(onB.action).toBe("continue");
    expect(importCounts()[pluginId]).toBeUndefined();

    const onA = await pipelineA.run("TurnStart", ctx, {});
    expect(onA.action).toBe("abort");
    expect(importCounts()[pluginId]).toBe(1);
  });

  it("non-deferred (builtin/official) handlers keep lazy-importing on first fire", async () => {
    const pluginId = "eager-builtin";
    const rootPath = writeHandler(pluginId);
    const pipeline = createHookPipeline();
    registerPluginHooks(pipeline, [
      {
        pluginId,
        rootPath,
        hooks: [{ event: "TurnStart", handler: "hook.mjs" }],
      },
    ]);

    expect(importCounts()[pluginId]).toBeUndefined();
    const result = await pipeline.run("TurnStart", ctx, {});
    expect(result.action).toBe("abort");
    expect(importCounts()[pluginId]).toBe(1);
  });
});
