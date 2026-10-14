// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";

// F-110: the advertised builtin tools come from the registry bootstrap builds,
// not from a hand-written list. The old fallback named `get-world-dimensions`,
// which no tool has, so an agent generating against the index called a tool
// that does not exist.
describe("GET /api/framework/capabilities builtin tools", () => {
  it("advertises the registry's builtin tools and no stale name", async () => {
    const store = createMemoryStore();
    const api = await bootstrapApi({
      pluginsDir: "unused",
      storeBackend: "memory",
      store,
      llmAdapter: { generate: vi.fn() },
    });
    try {
      const res = await api.app.request("/api/framework/capabilities");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        framework: { tools: { builtin: string[] } };
      };
      const builtin = body.framework.tools.builtin;
      expect(builtin).toContain("emit-event");
      expect(builtin).toContain("plugin-data-get");
      expect(builtin).not.toContain("get-world-dimensions");
      expect(builtin).toEqual([...builtin].sort());
    } finally {
      await api.closePluginEntries();
      await api.closeTools();
      await api.eventBus.close();
      await store.close();
    }
  });
});
