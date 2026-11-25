import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEventDirectory,
  type EventDirectoryManifestLike,
} from "../src/event-directory.js";

const tempDirs: string[] = [];

function makePluginDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "covel-event-dir-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("createEventDirectory", () => {
  it("validates advertised and own events against JSON Schema 2020-12 schemas with $defs", async () => {
    const dir = makePluginDir();
    mkdirSync(path.join(dir, "schemas"), { recursive: true });
    writeFileSync(
      path.join(dir, "schemas", "quest.json"),
      JSON.stringify({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["quest"],
        properties: {
          quest: { $ref: "#/$defs/questRef" },
        },
        $defs: {
          questRef: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", minLength: 1 } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      }),
    );

    const declarations: EventDirectoryManifestLike[] = [
      {
        pluginId: "quest-plugin",
        events: [
          {
            topic: "quest.updated",
            schema: "schemas/quest.json",
            advertise: true,
            description: "Quest status changed",
          },
        ],
      },
    ];
    const directory = createEventDirectory({
      registry: {
        getActivePluginDeclarations: () => declarations,
      },
      resolvePluginDir: (pluginId) =>
        pluginId === "quest-plugin" ? dir : undefined,
    });

    await expect(
      directory.validate("session-1", "quest.updated", { quest: { id: "q1" } }),
    ).resolves.toEqual({ ok: true });

    await expect(
      directory.validateOwn("session-1", "quest-plugin", "quest.updated", {
        quest: { id: "q1" },
      }),
    ).resolves.toEqual({ ok: true });

    const invalid = await directory.validateOwn(
      "session-1",
      "quest-plugin",
      "quest.updated",
      { quest: { id: "" } },
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.code).toBe("invalid");
      expect(invalid.reason).toContain("id");
    }

    const foreign = await directory.validateOwn(
      "session-1",
      "other-plugin",
      "quest.updated",
      { quest: { id: "q1" } },
    );
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) {
      expect(foreign.code).toBe("not-declared");
    }
  });

  it("rejects schema paths that escape the plugin root", async () => {
    const parent = makePluginDir();
    const pluginDir = path.join(parent, "plugin");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      path.join(parent, "outside.json"),
      JSON.stringify({ type: "object" }),
    );

    const directory = createEventDirectory({
      registry: {
        getActivePluginDeclarations: () => [
          {
            pluginId: "escape-plugin",
            events: [
              {
                topic: "escape.event",
                schema: "../outside.json",
                advertise: true,
                description: "Escaped schema test",
              },
            ],
          },
        ],
      },
      resolvePluginDir: () => pluginDir,
    });

    const result = await directory.validate("session-1", "escape.event", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/escape/i);
    }
  });
});
