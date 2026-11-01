import { expect, it } from "vitest";
import type { SseEnvelope } from "@covel/shared";
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

    const action = await fixture.app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        sessionId: fixture.sessionId,
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: "Begin" }] },
      }),
    });
    expect(action.status).toBe(200);
    const events: SseEnvelope[] = (await action.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(
      events.filter((event) => event.type === "execution.round.completed"),
    ).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({
      type: "execution.completed",
      payload: { committed: true },
    });
    expect(fixture.calls()).toBe(3);
    expect(
      (await fixture.store.listMessages(fixture.sessionId))
        .filter((message) => message.role === "assistant")
        .map((message) => message.content),
    ).toEqual(["Saved scene 1.", "Saved scene 2.", "Saved scene 3."]);
    expect(
      (await fixture.store.getSession(fixture.sessionId))?.completedPlayerTurns,
    ).toBe(1);
  } finally {
    await fixture.close();
  }
});
