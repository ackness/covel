import { expect, it } from "vitest";
import { createAdvancementBrowserFixture } from "../helpers/auto-advance-browser.js";

it("serves the browser boot resources and a playable remote session", async () => {
  const fixture = await createAdvancementBrowserFixture();
  try {
    const paths = [
      "/api/presets",
      "/api/plugins",
      "/api/worlds",
      "/api/llm-config",
      `/api/sessions/${fixture.sessionId}`,
      `/api/sessions/${fixture.sessionId}/view`,
      `/api/ui-specs?sessionId=${fixture.sessionId}`,
    ];
    const responses = await Promise.all(
      paths.map((path) => fixture.app.request(path)),
    );
    for (const [index, response] of responses.entries())
      expect(response.status, paths[index]).toBe(200);
    const [presets, plugins, worlds, llmConfig, session, view, uiSpecs] =
      await Promise.all(responses.map((response) => response.json()));
    expect(presets).toEqual({ items: [] });
    expect(plugins.items).toEqual([
      expect.objectContaining({ id: "story-probe" }),
    ]);
    expect(worlds.items).toEqual([
      expect.objectContaining({ id: "advance-world" }),
    ]);
    expect(llmConfig).toEqual({ configured: false, slots: {}, providers: [] });
    expect(session).toMatchObject({
      id: fixture.sessionId,
      worldId: "advance-world",
      phase: "playing",
      autoAdvanceLimit: 2,
    });
    expect(view.session.id).toBe(fixture.sessionId);
    expect(view.messages).toEqual([]);
    expect(uiSpecs.diagnostics).toEqual([]);
    expect(fixture.calls()).toBe(0);
  } finally {
    await fixture.close();
  }
});
