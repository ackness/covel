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

  it("warns once per plugin still using legacy registration fields", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const legacy = writePlugin("entry-legacy-a", null);
    (legacy.parsed.manifest as { hooks?: unknown[] }).hooks = [
      { event: "TurnStart", handler: "./h.js" },
    ];
    delete (legacy.parsed.manifest as { entry?: string }).entry;

    await createBootstrapPluginEntries(makeParams([legacy]));

    const legacyWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("deprecated"),
    );
    expect(legacyWarns).toHaveLength(1);
    expect(String(legacyWarns[0][0])).toContain("entry-legacy-a");
    warn.mockRestore();
  });
});
