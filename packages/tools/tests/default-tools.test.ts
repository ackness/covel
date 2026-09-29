import { describe, expect, it } from "vitest";
import { createDefaultToolRegistry } from "../src/builtin/default-tools.js";
import type { DefaultToolRegistryDeps } from "../src/builtin/default-tools.js";

describe("default tool registry", () => {
  it("registers the same host built-ins when a store and event directory are supplied", () => {
    const store = {} as DefaultToolRegistryDeps["store"];
    const eventDirectory: DefaultToolRegistryDeps["eventDirectory"] = {
      async listTopics() {
        return [];
      },
      async validate() {
        return { ok: false, reason: "not configured" };
      },
    };
    const registry = createDefaultToolRegistry({ store, eventDirectory });

    expect([...registry.builtinTools.keys()].sort()).toEqual(
      [
        "render-ui",
        "create-form",
        "create-choices",
        "create-notification",
        "suspend",
        "runtime-done",
        "plugin-data-set",
        "plugin-data-set-batch",
        "plugin-data-get",
        "plugin-data-list",
        "emit-event",
        "get-character-schema",
        "create-character",
        "update-character",
        "sync-characters",
        "list-characters",
        "get-character",
      ].sort(),
    );
  });
});
