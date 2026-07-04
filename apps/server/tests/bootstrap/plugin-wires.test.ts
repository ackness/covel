import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getImageWire,
  getSpeechWire,
  getTranscriptionWire,
} from "@covel/ai-provider";
import type {
  ParsedPluginMd,
  PluginDiscoveryResult,
} from "@covel/plugin-loader";
import type { RuntimeManifest } from "@covel/shared";
import { createBootstrapPluginWires } from "../../src/routes/api/bootstrap/plugin-wires.js";

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "covel-plugin-wires-"));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writePlugin(
  pluginId: string,
  wiresSource: string | null,
  opts: { source?: "builtin" | "community"; wiresPath?: string } = {},
): {
  discovery: PluginDiscoveryResult;
  parsed: ParsedPluginMd;
} {
  const rootPath = path.join(tmpRoot, pluginId);
  fs.mkdirSync(path.join(rootPath, "lib"), { recursive: true });
  const wiresPath = opts.wiresPath ?? "lib/wires.mjs";
  if (wiresSource !== null) {
    fs.writeFileSync(path.join(rootPath, wiresPath), wiresSource);
  }
  const manifest = {
    name: pluginId,
    pluginId,
    description: pluginId,
    runtimeType: "function",
    handler: "./handler.js",
    wires: wiresPath,
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

function makeMaps(
  entries: ReturnType<typeof writePlugin>[],
): Parameters<typeof createBootstrapPluginWires>[0] {
  return {
    discoveryMap: new Map(entries.map((e) => [e.discovery.id, e.discovery])),
    manifestCache: new Map(entries.map((e) => [e.discovery.id, [e.parsed]])),
  };
}

const SPEECH_WIRE_SRC = (id: string) => `
export default {
  speech: [{
    id: ${JSON.stringify(id)},
    async synthesize() {
      return { audio: { mimeType: "audio/mpeg", data: new Uint8Array() }, usage: null, warnings: [] };
    },
  }],
};
`;

describe("createBootstrapPluginWires", () => {
  it("registers builtin-source plugin wires at bootstrap, namespaced by pluginId", async () => {
    const p = writePlugin("wires-builtin-a", SPEECH_WIRE_SRC("mimo"));

    await createBootstrapPluginWires(makeMaps([p]));

    expect(getSpeechWire("wires-builtin-a/mimo")).not.toBeNull();
    // The raw id must NOT be registered — namespacing is mandatory.
    expect(getSpeechWire("mimo")).toBeNull();
  });

  it("defers community-source plugin wires until ensurePluginWires", async () => {
    const p = writePlugin("wires-community-a", SPEECH_WIRE_SRC("tts"), {
      source: "community",
    });

    const { ensurePluginWires } = await createBootstrapPluginWires(
      makeMaps([p]),
    );
    expect(getSpeechWire("wires-community-a/tts")).toBeNull();

    await ensurePluginWires("wires-community-a");
    expect(getSpeechWire("wires-community-a/tts")).not.toBeNull();
  });

  it("registers image/speech/transcription groups and supports the factory form with injection", async () => {
    const src = `
export default ({ fetchWithRetry, validateBaseUrl }) => {
  if (typeof fetchWithRetry !== "function" || typeof validateBaseUrl !== "function") {
    throw new Error("missing injection");
  }
  return {
    image: [{ id: "img", async generate() { return { images: [], usage: null, warnings: [] }; } }],
    speech: [{ id: "spk", async synthesize() { return { audio: { mimeType: "audio/mpeg", data: new Uint8Array() }, usage: null, warnings: [] }; } }],
    transcription: [{ id: "stt", async transcribe() { return { text: "", usage: null, warnings: [] }; } }],
  };
};
`;
    const p = writePlugin("wires-factory-a", src);

    await createBootstrapPluginWires(makeMaps([p]));

    expect(getImageWire("wires-factory-a/img")).not.toBeNull();
    expect(getSpeechWire("wires-factory-a/spk")).not.toBeNull();
    expect(getTranscriptionWire("wires-factory-a/stt")).not.toBeNull();
  });

  it("lets two plugins register wires with the same local id (namespace isolation)", async () => {
    const a = writePlugin("wires-dup-a", SPEECH_WIRE_SRC("same"));
    const b = writePlugin("wires-dup-b", SPEECH_WIRE_SRC("same"));

    await createBootstrapPluginWires(makeMaps([a, b]));

    expect(getSpeechWire("wires-dup-a/same")).not.toBeNull();
    expect(getSpeechWire("wires-dup-b/same")).not.toBeNull();
  });

  it("is idempotent: double bootstrap and repeat ensurePluginWires only warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const p = writePlugin("wires-idem-a", SPEECH_WIRE_SRC("v"));

      await createBootstrapPluginWires(makeMaps([p]));
      const { ensurePluginWires } = await createBootstrapPluginWires(
        makeMaps([p]),
      );
      await ensurePluginWires("wires-idem-a");
      await ensurePluginWires("wires-idem-a");

      expect(getSpeechWire("wires-idem-a/v")).not.toBeNull();
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("already registered"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and skips a missing wires file without failing boot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const p = writePlugin("wires-missing-a", null);

      await expect(
        createBootstrapPluginWires(makeMaps([p])),
      ).resolves.toBeDefined();
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("not found")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and skips a wires path escaping the plugin root", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Bypasses the schema (which already rejects `..`) to pin the loader's
      // own defence-in-depth check.
      const p = writePlugin("wires-escape-a", null, {
        wiresPath: "../outside.mjs",
      });

      await createBootstrapPluginWires(makeMaps([p]));
      expect(
        warn.mock.calls.some((c) =>
          String(c[0]).includes("escapes the plugin root"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and skips malformed wire entries", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const src = `export default { speech: [{ id: "", synthesize: 42 }, "junk"] };`;
      const p = writePlugin("wires-malformed-a", src);

      await createBootstrapPluginWires(makeMaps([p]));
      expect(
        warn.mock.calls.some((c) => String(c[0]).includes("malformed wire")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
