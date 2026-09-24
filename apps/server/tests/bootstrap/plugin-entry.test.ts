import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSpeechWire } from "@covel/ai-provider";
import type {
  ParsedPluginMd,
  PluginDiscoveryResult,
} from "@covel/plugin-loader";
import {
  createHookPipeline,
  createToolExecutor,
  createPluginRpcRegistry,
  type HookContext,
} from "@covel/runtime";
import type { RuntimeManifest } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { ToolModule } from "@covel/tools";
import { createBootstrapPluginEntries } from "../../src/routes/api/bootstrap/plugin-entry.js";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "covel-plugin-entry-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writePlugin(
  pluginId: string,
  entrySource: string | null,
  opts: { source?: "builtin" | "community"; entryPath?: string } = {},
): {
  discovery: PluginDiscoveryResult;
  parsed: ParsedPluginMd;
} {
  const rootPath = path.join(tmpRoot, pluginId);
  fs.mkdirSync(path.join(rootPath, "server"), { recursive: true });
  const entryPath = opts.entryPath ?? "server/index.mjs";
  if (entrySource !== null) {
    fs.writeFileSync(path.join(rootPath, entryPath), entrySource);
  }
  const manifest = {
    name: pluginId,
    pluginId,
    description: pluginId,
    entry: entryPath,
  } as unknown as RuntimeManifest;
  return {
    discovery: {
      id: pluginId,
      rootPath,
      isMultiRuntime: false,
      pluginMdPaths: [path.join(rootPath, "PLUGIN.md")],
      source: opts.source ?? "builtin",
    },
    parsed: { manifest, promptTemplate: "", rawFrontmatter: {} },
  };
}

function makeParams(entries: ReturnType<typeof writePlugin>[]) {
  return {
    discoveryMap: new Map(entries.map((e) => [e.discovery.id, e.discovery])),
    manifestCache: new Map(entries.map((e) => [e.discovery.id, [e.parsed]])),
    store: createMemoryStore(),
    toolMap: new Map<string, ToolModule>(),
    localToolNames: new Set<string>(),
    pluginToolAccess: new Map<string, Set<string>>(),
    hookPipeline: createHookPipeline(),
    rpcRegistry: createPluginRpcRegistry(),
    isCommunityServerCodeApproved: () => true,
    isCommunityHookApproved: () => true,
  };
}

const FULL_ENTRY_SRC = `
export default function (covel) {
  covel.registerTool(
    covel.toolkit.tool({
      name: "entry-tool",
      description: "registered via entry",
      parameters: covel.toolkit.z.object({ note: covel.toolkit.z.string() }),
      async execute(args) {
        return { _text: "ok:" + args.note };
      },
    }),
  );
  covel.on("TurnStart", async () => ({ action: "continue" }));
  covel.registerRpc("entry-action", async () => ({ done: true }), {
    description: "entry rpc",
  });
  covel.registerWires({
    speech: [{
      id: "entry-tts",
      async synthesize() {
        return { audio: { mimeType: "audio/mpeg", data: new Uint8Array() }, usage: null, warnings: [] };
      },
    }],
  });
}
`;

const hookCtx = { sessionId: "s1", turnId: "t1" } as unknown as HookContext;

describe("createBootstrapPluginEntries", () => {
  it("unregisters successful entries so a fresh host can register the same wires", async () => {
    const plugin = writePlugin("entry-host-lifecycle", FULL_ENTRY_SRC);
    const params = makeParams([plugin]);
    const closeStore = vi.spyOn(params.store, "close");
    const entries = await createBootstrapPluginEntries(params);
    expect(getSpeechWire("entry-host-lifecycle/entry-tts")).not.toBeNull();
    const closing = entries.close();
    expect(entries.close()).toBe(closing);
    await closing;
    expect(getSpeechWire("entry-host-lifecycle/entry-tts")).toBeNull();
    expect(params.toolMap.size).toBe(0);
    expect(params.localToolNames.size).toBe(0);
    expect(params.pluginToolAccess.size).toBe(0);
    expect(params.rpcRegistry.list()).toEqual([]);
    expect(closeStore).not.toHaveBeenCalled();
    await expect(
      entries.ensurePluginEntry("entry-host-lifecycle"),
    ).rejects.toThrow("closed");
    const replacement = await createBootstrapPluginEntries(
      makeParams([plugin]),
    );
    try {
      expect(getSpeechWire("entry-host-lifecycle/entry-tts")).not.toBeNull();
      await entries.close();
      expect(getSpeechWire("entry-host-lifecycle/entry-tts")).not.toBeNull();
    } finally {
      await replacement.close();
    }
  });

  it("drains an admitted approval check without loading code after close", async () => {
    const plugin = writePlugin("entry-closing-approval", FULL_ENTRY_SRC, {
      source: "community",
    });
    const params = makeParams([plugin]);
    const approval = Promise.withResolvers<boolean>();
    const entries = await createBootstrapPluginEntries({
      ...params,
      isCommunityServerCodeApproved: () => approval.promise,
    });
    const activation = entries.ensurePluginEntry(
      "entry-closing-approval",
      "session",
    );
    const rejected = expect(activation).rejects.toThrow("closed");
    let closed = false;
    const closing = entries.close().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      approval.resolve(true);
      await Promise.all([rejected, closing]);
    }
    expect(params.toolMap.size).toBe(0);
    expect(getSpeechWire("entry-closing-approval/entry-tts")).toBeNull();
  });

  it("waits for a running entry factory and discards its late publication", async () => {
    const state = {
      started: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    const globals = globalThis as Record<string, unknown>;
    globals.__covelClosingEntry = state;
    const plugin = writePlugin(
      "entry-closing-factory",
      `
      export default async function(api) {
        api.registerRpc("early", async () => true);
        globalThis.__covelClosingEntry.started.resolve();
        await globalThis.__covelClosingEntry.release.promise;
        api.registerRpc("late", async () => true);
      }
    `,
      { source: "community" },
    );
    const params = makeParams([plugin]);
    const entries = await createBootstrapPluginEntries(params);
    const activation = entries.ensurePluginEntry(
      "entry-closing-factory",
      "session",
    );
    const rejected = expect(activation).rejects.toThrow("failed to activate");
    await state.started.promise;
    let closed = false;
    const closing = entries.close().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
    } finally {
      state.release.resolve();
      await Promise.all([rejected, closing]);
      delete globals.__covelClosingEntry;
    }
    expect(params.rpcRegistry.list()).toEqual([]);
  });

  it("runs builtin entries at boot: tool, hook, rpc, and wires all registered", async () => {
    const p = writePlugin("entry-full-a", FULL_ENTRY_SRC);
    const params = makeParams([p]);

    await createBootstrapPluginEntries(params);

    // Tool: in the tool map, marked local, and in the plugin's access set.
    expect(params.toolMap.has("entry-tool")).toBe(true);
    expect(params.localToolNames.has("entry-tool")).toBe(true);
    expect(params.pluginToolAccess.get("entry-full-a")?.has("entry-tool")).toBe(
      true,
    );

    // Hook: fires through the pipeline.
    const result = await params.hookPipeline.run("TurnStart", hookCtx, {});
    expect(result.action).toBe("continue");

    // RPC: inline handler entry, trust from plugin source.
    const rpcEntry = params.rpcRegistry.getPluginAction(
      "entry-full-a",
      "entry-action",
    );
    expect(rpcEntry?.handler).toBeTypeOf("function");
    expect(rpcEntry?.trustLevel).toBe("builtin");

    // Wires: namespaced by pluginId.
    expect(getSpeechWire("entry-full-a/entry-tts")).not.toBeNull();
    expect(getSpeechWire("entry-tts")).toBeNull();
  });

  it("runs a MULTI-runtime plugin's entry declared on the metadata-only root PLUGIN.md", async () => {
    // Regression: discover.ts lists only runtime PLUGIN.mds for a multi-runtime
    // plugin, so an `entry` on the metadata-only root PLUGIN.md is absent from
    // manifestCache — the entry must be read from the root directly, otherwise
    // the plugin's local tools never register (npc-graph's graph tools case).
    const pluginId = "multi-root-entry";
    const rootPath = path.join(tmpRoot, pluginId);
    fs.mkdirSync(path.join(rootPath, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(rootPath, "server", "index.mjs"),
      `export default function (covel) {
        covel.registerTool(
          covel.toolkit.tool({
            name: "root-entry-tool",
            description: "registered via root entry",
            parameters: covel.toolkit.z.object({}),
            async execute() { return { _text: "ok" }; },
          }),
        );
      }`,
    );
    // Real root PLUGIN.md on disk carries the entry; the manifestCache holds
    // only the sub-runtime manifest (no entry) — exactly the multi-runtime shape.
    fs.writeFileSync(
      path.join(rootPath, "PLUGIN.md"),
      `---\nname: ${pluginId}\ndescription: multi-runtime root\npluginType: plugin\nentry: ./server/index.mjs\n---\n\n# Multi\n`,
    );
    const subManifest = {
      name: `${pluginId}/worker`,
      pluginId,
      description: "worker",
      tools: { plugin: ["root-entry-tool"] },
    } as unknown as RuntimeManifest;
    const params = makeParams([]);
    params.discoveryMap.set(pluginId, {
      id: pluginId,
      rootPath,
      isMultiRuntime: true,
      pluginMdPaths: [path.join(rootPath, "runtimes", "worker", "PLUGIN.md")],
      source: "builtin",
    } as PluginDiscoveryResult);
    params.manifestCache.set(pluginId, [
      { manifest: subManifest, promptTemplate: "", rawFrontmatter: {} },
    ]);

    await createBootstrapPluginEntries(params);

    expect(params.toolMap.has("root-entry-tool")).toBe(true);
    expect(params.pluginToolAccess.get(pluginId)?.has("root-entry-tool")).toBe(
      true,
    );
  });

  it("reports and activates a community MULTI-runtime root-only entry consistently", async () => {
    const pluginId = "multi-community-root-entry";
    const rootPath = path.join(tmpRoot, pluginId);
    fs.mkdirSync(path.join(rootPath, "server"), { recursive: true });
    fs.writeFileSync(
      path.join(rootPath, "server", "index.mjs"),
      `export default function (covel) {
        covel.registerRpc("root-action", async () => ({ ok: true }));
      }`,
    );
    fs.writeFileSync(
      path.join(rootPath, "PLUGIN.md"),
      `---\nname: ${pluginId}\ndescription: community multi-runtime root\npluginType: plugin\nentry: ./server/index.mjs\n---\n`,
    );

    const subManifest = {
      name: `${pluginId}/worker`,
      pluginId,
      description: "worker without an entry declaration",
    } as unknown as RuntimeManifest;
    const params = makeParams([]);
    params.discoveryMap.set(pluginId, {
      id: pluginId,
      rootPath,
      isMultiRuntime: true,
      pluginMdPaths: [path.join(rootPath, "runtimes", "worker", "PLUGIN.md")],
      source: "community",
    } as PluginDiscoveryResult);
    params.manifestCache.set(pluginId, [
      { manifest: subManifest, promptTemplate: "", rawFrontmatter: {} },
    ]);

    const { ensurePluginEntry, hasPendingEntry } =
      await createBootstrapPluginEntries(params);

    expect(hasPendingEntry(pluginId)).toBe(true);
    expect(
      params.rpcRegistry.getPluginAction(pluginId, "root-action"),
    ).toBeUndefined();

    await ensurePluginEntry(pluginId, "session-community-root");

    expect(hasPendingEntry(pluginId)).toBe(false);
    expect(
      params.rpcRegistry.getPluginAction(pluginId, "root-action"),
    ).toBeDefined();
  });

  it("defers community entries until ensurePluginEntry (memoized)", async () => {
    const p = writePlugin(
      "entry-community-a",
      `
let calls = 0;
export default function (covel) {
  calls += 1;
  covel.registerTool(
    covel.toolkit.tool({
      name: "community-tool-" + calls,
      description: "d",
      parameters: covel.toolkit.z.object({}),
      async execute() { return { _text: "ok" }; },
    }),
  );
}
`,
      { source: "community" },
    );
    const params = makeParams([p]);

    const { ensurePluginEntry } = await createBootstrapPluginEntries(params);
    expect(params.toolMap.has("community-tool-1")).toBe(false);

    await ensurePluginEntry("entry-community-a");
    expect(params.toolMap.has("community-tool-1")).toBe(true);

    // Second ensure is a no-op — the factory must not run twice.
    await ensurePluginEntry("entry-community-a");
    expect(params.toolMap.has("community-tool-2")).toBe(false);
  });

  it("rejects community entry activation without a session grant", async () => {
    const p = writePlugin(
      "entry-community-denied",
      `export default function (covel) { covel.registerRpc("x", async () => true); }`,
      { source: "community" },
    );
    const params = makeParams([p]);
    params.isCommunityServerCodeApproved = () => false;
    const { ensurePluginEntry } = await createBootstrapPluginEntries(params);

    await expect(
      ensurePluginEntry("entry-community-denied", "session-b"),
    ).rejects.toThrow("requires explicit approval");
    expect(
      params.rpcRegistry.getPluginAction("entry-community-denied", "x"),
    ).toBeUndefined();
  });

  it("rejects an entry path that escapes the plugin root through a symlink", async () => {
    const outsideDir = path.join(tmpRoot, "entry-escape-target");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(
      path.join(outsideDir, "evil.mjs"),
      `export default function (covel) { covel.registerRpc("escaped", async () => true); }`,
    );
    const pluginId = "entry-symlink-escape";
    const rootPath = path.join(tmpRoot, pluginId);
    fs.mkdirSync(path.join(rootPath, "server"), { recursive: true });
    fs.symlinkSync(
      path.join(outsideDir, "evil.mjs"),
      path.join(rootPath, "server", "index.mjs"),
    );
    const manifest = {
      name: pluginId,
      pluginId,
      description: pluginId,
      entry: "server/index.mjs",
    } as unknown as RuntimeManifest;
    const params = makeParams([]);
    params.discoveryMap.set(pluginId, {
      id: pluginId,
      rootPath,
      isMultiRuntime: false,
      pluginMdPaths: [path.join(rootPath, "PLUGIN.md")],
      source: "community",
    });
    params.manifestCache.set(pluginId, [
      { manifest, promptTemplate: "", rawFrontmatter: {} },
    ]);

    const { ensurePluginEntry } = await createBootstrapPluginEntries(params);
    const failure = await ensurePluginEntry(pluginId, "session").then(
      () => {
        throw new Error("expected activation to fail");
      },
      (error: unknown) => error as Error,
    );
    expect(failure.message).toContain("failed to activate entry");
    expect((failure.cause as Error).message).toContain(
      "escapes the plugin root",
    );
    expect(
      params.rpcRegistry.getPluginAction(pluginId, "escaped"),
    ).toBeUndefined();
  });

  it("supports async entry factories", async () => {
    const p = writePlugin(
      "entry-async-a",
      `
export default async function (covel) {
  await Promise.resolve();
  covel.registerRpc("late-action", async () => "late");
}
`,
    );
    const params = makeParams([p]);
    await createBootstrapPluginEntries(params);
    expect(
      params.rpcRegistry.getPluginAction("entry-async-a", "late-action"),
    ).toBeDefined();
  });

  it("keeps a failed multi-entry activation pending and retries the entire batch", async () => {
    const p = writePlugin(
      "entry-retry-batch",
      `
      let calls = 0;
      export default function (covel) {
        calls++;
        covel.registerRpc("count", async () => calls);
        covel.on("TurnStart", async () => ({ action: "abort", reason: "registered" }));
      }
    `,
      { source: "community" },
    );
    fs.writeFileSync(
      path.join(p.discovery.rootPath, "server/second.mjs"),
      `
      let calls = 0;
      export default function () { if (++calls === 1) throw new Error("first activation failed"); }
    `,
    );
    const params = makeParams([p]);
    params.manifestCache.set(p.discovery.id, [
      p.parsed,
      {
        ...p.parsed,
        manifest: { ...p.parsed.manifest, entry: "server/second.mjs" },
      },
    ]);
    const entries = await createBootstrapPluginEntries(params);
    const attempts = await Promise.allSettled([
      entries.ensurePluginEntry(p.discovery.id),
      entries.ensurePluginEntry(p.discovery.id),
    ]);
    expect(attempts.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(entries.hasPendingEntry(p.discovery.id)).toBe(true);
    expect(params.rpcRegistry.list()).toEqual([]);
    expect(await params.hookPipeline.run("TurnStart", hookCtx, {})).toEqual({
      action: "continue",
    });
    await entries.ensurePluginEntry(p.discovery.id);
    expect(entries.hasPendingEntry(p.discovery.id)).toBe(false);
    const entry = params.rpcRegistry.getPluginAction(p.discovery.id, "count");
    expect(
      await entry?.handler(
        {},
        { sessionId: "s1", pluginId: p.discovery.id, store: params.store },
      ),
    ).toBe(2);
    expect(
      (await params.hookPipeline.run("TurnStart", hookCtx, {})).action,
    ).toBe("abort");
  });

  it("warn-skips a throwing entry without breaking other plugins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = writePlugin(
      "entry-bad-a",
      `export default () => { throw new Error("boom"); };`,
    );
    const good = writePlugin(
      "entry-good-a",
      `export default (covel) => { covel.registerRpc("still-works", async () => 1); };`,
    );
    const params = makeParams([bad, good]);

    await createBootstrapPluginEntries(params);

    expect(
      params.rpcRegistry.getPluginAction("entry-good-a", "still-works"),
    ).toBeDefined();
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("entry-bad-a")),
    ).toBe(true);
    warn.mockRestore();
  });

  it("warn-skips non-function default exports, unknown hook events, and non-ToolModule registrations", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notFn = writePlugin(
      "entry-notfn-a",
      `export default { nope: true };`,
    );
    const badCalls = writePlugin(
      "entry-badcalls-a",
      `
export default (covel) => {
  covel.on("NotARealEvent", async () => ({ action: "continue" }));
  covel.registerTool({ name: "raw-object" });
};
`,
    );
    const params = makeParams([notFn, badCalls]);

    await createBootstrapPluginEntries(params);

    expect(params.toolMap.size).toBe(0);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("NotARealEvent")),
    ).toBe(true);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("registerTool")),
    ).toBe(true);
    warn.mockRestore();
  });

  it("rejects registerTool name collisions instead of overwriting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = writePlugin(
      "entry-collide-a",
      `
export default (covel) => {
  covel.registerTool(
    covel.toolkit.tool({
      name: "shared-name",
      description: "first wins",
      parameters: covel.toolkit.z.object({}),
      async execute() { return { _text: "first" }; },
    }),
  );
};
`,
    );
    const second = writePlugin(
      "entry-collide-b",
      `
export default (covel) => {
  covel.registerTool(
    covel.toolkit.tool({
      name: "shared-name",
      description: "would hijack",
      parameters: covel.toolkit.z.object({}),
      async execute() { return { _text: "second" }; },
    }),
  );
};
`,
    );
    const params = makeParams([first, second]);
    // Simulate a builtin already occupying a name — entry must not replace it.
    const builtinTool = {
      _type: "covel-tool",
      name: "shared-name",
    } as unknown as ToolModule;
    params.toolMap.set("shared-name", builtinTool);

    await createBootstrapPluginEntries(params);

    // Original registration untouched; neither collider got access.
    expect(params.toolMap.get("shared-name")).toBe(builtinTool);
    expect(params.localToolNames.has("shared-name")).toBe(false);
    expect(
      params.pluginToolAccess.get("entry-collide-a")?.has("shared-name"),
    ).toBeFalsy();
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("collides")),
    ).toHaveLength(2);
    warn.mockRestore();
  });

  it.each(["builtin", "community"] as const)(
    "injects pure helpers at %s activation and scoped reads at execution",
    async (source) => {
      const pluginId = `entry-reads-${source}`;
      const p = writePlugin(
        pluginId,
        `
export default function (covel) {
  if ("store" in covel.toolkit) throw new Error("Activation received store authority");
  covel.registerTool(covel.toolkit.tool({
    name: "read-state",
    description: "Read own state",
    parameters: covel.toolkit.z.object({}),
    async execute(_args, ctx) {
      if (ctx.store.setPluginData || ctx.store.close || ctx.store.withTransaction) {
        throw new Error("Tool received host authority");
      }
      const row = await ctx.store.getPluginData("entries", "current");
      return row.value;
    },
  }));
}
`,
        { source },
      );
      const params = makeParams([p]);
      for (const [sessionId, owner, value] of [
        ["s1", pluginId, "first"],
        ["s2", pluginId, "second"],
        ["s1", "other-plugin", "foreign"],
      ]) {
        await params.store.setPluginData({
          id: `${sessionId}-${owner}`,
          sessionId,
          pluginId: owner,
          namespace: "entries",
          key: "current",
          value,
          createdAt: "t",
          updatedAt: "t",
        });
      }
      const entries = await createBootstrapPluginEntries(params);
      await entries.ensurePluginEntry(pluginId);
      const executor = createToolExecutor({
        store: params.store,
        findTool: () => params.toolMap.get("read-state"),
      });
      const results = await Promise.all(
        ["s1", "s2"].map((sessionId) =>
          executor.execute(
            { toolCallId: sessionId, name: "read-state", arguments: "{}" },
            {
              sessionId,
              pluginId,
              turnId: "turn",
              runtimeId: `${pluginId}/main`,
            },
          ),
        ),
      );
      expect(results.map((result) => result.success)).toEqual([true, true]);
      expect(results.map((result) => result.parsedResult)).toEqual([
        "first",
        "second",
      ]);
      await entries.close();
    },
  );

  it("clamps a community entry that declares trustLevel:builtin down to community (LOW)", async () => {
    const p = writePlugin(
      "entry-clamp-a",
      `
export default function (covel) {
  covel.registerRpc("act", async () => ({ ok: true }), { trustLevel: "builtin" });
}
`,
      { source: "community" },
    );
    const params = makeParams([p]);
    const { ensurePluginEntry } = await createBootstrapPluginEntries(params);
    await ensurePluginEntry("entry-clamp-a");

    const entry = params.rpcRegistry.getPluginAction("entry-clamp-a", "act");
    expect(entry?.trustLevel).toBe("community");
  });

  it("dedupes concurrent ensurePluginEntry calls — factory runs once (LOW)", async () => {
    const p = writePlugin(
      "entry-inflight-a",
      `
let calls = 0;
export default async function (covel) {
  calls += 1;
  await Promise.resolve();
  covel.registerTool(
    covel.toolkit.tool({
      name: "inflight-tool-" + calls,
      description: "d",
      parameters: covel.toolkit.z.object({}),
      async execute() { return { _text: "ok" }; },
    }),
  );
}
`,
      { source: "community" },
    );
    const params = makeParams([p]);
    const { ensurePluginEntry } = await createBootstrapPluginEntries(params);

    // Invoke twice without awaiting the first — the second must share the
    // in-flight promise, not start a second factory run.
    await Promise.all([
      ensurePluginEntry("entry-inflight-a"),
      ensurePluginEntry("entry-inflight-a"),
    ]);

    expect(params.toolMap.has("inflight-tool-1")).toBe(true);
    expect(params.toolMap.has("inflight-tool-2")).toBe(false);
  });

  it("hasPendingEntry: true for a deferred community entry, false once activated", async () => {
    const community = writePlugin(
      "entry-pending-a",
      `export default (covel) => { covel.registerRpc("a", async () => 1); };`,
      { source: "community" },
    );
    const builtin = writePlugin(
      "entry-pending-b",
      `export default (covel) => { covel.registerRpc("b", async () => 1); };`,
    );
    const params = makeParams([community, builtin]);
    const { ensurePluginEntry, hasPendingEntry } =
      await createBootstrapPluginEntries(params);

    // Community entry not run yet → pending.
    expect(hasPendingEntry("entry-pending-a")).toBe(true);
    // Builtin entry ran at boot → never pending.
    expect(hasPendingEntry("entry-pending-b")).toBe(false);
    // Unknown plugin → not pending.
    expect(hasPendingEntry("nope")).toBe(false);

    await ensurePluginEntry("entry-pending-a");
    expect(hasPendingEntry("entry-pending-a")).toBe(false);
  });
});

it("publishes services atomically and removes them when the entry closes", async () => {
  const { PluginServiceRegistry } = await import("@covel/runtime");
  const services = new PluginServiceRegistry({
    list: async () => ["service-entry"],
    ensure: async () => {},
  });
  const fixture = writePlugin(
    "service-entry",
    `export default function(covel) {
    const schema = covel.toolkit.z.object({ value: covel.toolkit.z.number() });
    covel.registerService({ name: "double", contract: "fixture/double@1", input: schema, output: schema,
      handler: (input) => ({ value: input.value * 2 }) });
  }`,
  );
  const entries = await createBootstrapPluginEntries({
    ...makeParams([fixture]),
    services,
  });
  const client = services.createClient({
    sessionId: "service-session",
    pluginId: "consumer",
    signal: new AbortController().signal,
  });
  expect(
    await client.call({
      pluginId: "service-entry",
      name: "double",
      contract: "fixture/double@1",
      input: { value: 3 },
    }),
  ).toEqual({ value: 6 });
  await entries.close();
  expect(await client.discover("fixture/double@1")).toEqual([]);
});
