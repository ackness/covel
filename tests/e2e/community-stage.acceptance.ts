import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { seedAppSettings, useServerWorlds } from "./helpers/player.js";

const pluginId = "community-stage-proof";
const worldFile = resolve(
  import.meta.dirname,
  "../../worlds/haruka-academy/world.yaml",
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

function worldDigest(): string {
  return createHash("sha256").update(readFileSync(worldFile)).digest("hex");
}

async function putData(
  request: APIRequestContext,
  sessionId: string,
  namespace: string,
  key: string,
  value: unknown,
) {
  const response = await request.put(
    `/api/sessions/${sessionId}/plugin-data/${pluginId}/${namespace}/${key}`,
    { data: { value } },
  );
  expect(
    response.ok(),
    `${namespace}/${key}: ${await response.text()}`,
  ).toBeTruthy();
}

test("isolated community package projects stage and portrait through GET/SSE, then clears a failed preview", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const beforeWorld = worldDigest();
  await seedAppSettings(page);
  await useServerWorlds(page);
  const created = await request.post("/api/sessions", {
    data: {
      worldId: "haruka-academy",
      locale: "zh-CN",
      plugins: [pluginId],
      // Every bundled world declares dimensions, and a session refuses to
      // start without their provider, so `world-init` stays.
      excludedPlugins: ["pregame", "char-creator"],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { id: sessionId } = (await created.json()) as { id: string };
  try {
    const approval = await request.put(
      `/api/sessions/${sessionId}/plugins/${pluginId}`,
    );
    expect(approval.status()).toBe(202);
    const pending = (await approval.json()) as {
      status: string;
      approvalId: string;
    };
    expect(pending.status).toBe("approval-required");
    const decision = await request.post(
      `/api/approvals/${pending.approvalId}/decision`,
      {
        data: { decision: "allow", scope: "session" },
      },
    );
    expect(decision.ok(), await decision.text()).toBeTruthy();
    const activated = await request.put(
      `/api/sessions/${sessionId}/plugins/${pluginId}`,
    );
    expect(activated.ok(), await activated.text()).toBeTruthy();
    const plugins = await request.get(`/api/sessions/${sessionId}/plugins`);
    expect(plugins.ok()).toBeTruthy();
    expect((await plugins.json()).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: pluginId,
          active: true,
          serverCodeApproved: true,
        }),
      ]),
    );

    const uploaded = await request.post(`/api/media?sessionId=${sessionId}`, {
      data: png,
      headers: { "content-type": "image/png" },
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
    const mediaRef = (await uploaded.json()) as {
      id: string;
      mime: string;
      size: number;
    };
    await putData(request, sessionId, "scenery_private", "current", {
      name: "Committed Cove",
      ref: mediaRef,
    });
    await putData(request, sessionId, "cast_private", "current", {
      actors: [
        { characterId: "proof-hero", displayName: "Proof Hero", active: true },
      ],
      retainWhenEmpty: false,
    });
    await putData(request, sessionId, "portraits_private", "proof-hero", {
      characterId: "proof-hero",
      displayName: "Proof Hero",
      sprite: mediaRef,
    });
    const projected = await request.get(`/api/sessions/${sessionId}/ui-slots`);
    expect(projected.ok(), await projected.text()).toBeTruthy();
    const { items } = (await projected.json()) as {
      items: { slot: string; key?: string; value: Record<string, unknown> }[];
    };
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slot: "stage.backdrop@1",
          value: expect.objectContaining({ name: "Committed Cove" }),
        }),
        expect.objectContaining({
          slot: "stage.cast@1",
          value: expect.objectContaining({
            actors: [expect.objectContaining({ characterId: "proof-hero" })],
          }),
        }),
        expect.objectContaining({
          slot: "character.visual@1",
          key: "proof-hero",
          value: expect.objectContaining({ sprite: mediaRef }),
        }),
      ]),
    );

    // With `world-init` active the session is still in setup, and no model is
    // configured here to finish it; the stage opens only once play has
    // started. Present the session to the page as playing. What the test
    // checks — the projections, the SSE updates, the preview — still comes
    // from the server untouched.
    const sessionPath = `/api/sessions/${sessionId}`;
    const [session, view] = await Promise.all([
      request.get(sessionPath).then((response) => response.json()),
      request.get(`${sessionPath}/view`).then((response) => response.json()),
    ]);
    await page.route(`**${sessionPath}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ json: { ...session, phase: "playing" } })
        : route.fallback(),
    );
    await page.route(`**${sessionPath}/view`, (route) =>
      route.fulfill({
        json: { ...view, session: { ...view.session, phase: "playing" } },
      }),
    );

    await page.goto(`/session?sid=${sessionId}`);
    const stage = page.getByTestId("stage-view");
    await expect(stage).toBeVisible();
    await expect(stage.getByTestId("stage-hud")).toContainText(
      "Committed Cove",
    );
    await expect
      .poll(() => stage.getByTestId("stage-backdrop").locator("img").count())
      .toBeGreaterThan(0);
    await expect(stage.getByRole("img", { name: "Proof Hero" })).toBeVisible();

    await putData(request, sessionId, "scenery_private", "current", {
      name: "SSE Cove",
      ref: mediaRef,
    });
    await expect(stage.getByTestId("stage-hud")).toContainText("SSE Cove");
    const preview = await request.post("/api/events/emit", {
      data: {
        topic: "plugin",
        sessionId,
        payload: {
          _subType: "domain-event.previewed",
          topic: "community-stage.preview",
          data: { name: "Preview Cove" },
          turnId: "community-preview-turn",
        },
      },
    });
    expect(preview.ok(), await preview.text()).toBeTruthy();
    await expect(stage.getByTestId("stage-hud")).toContainText("Preview Cove");
    const failed = await request.post("/api/events/emit", {
      data: {
        topic: "plugin",
        sessionId,
        payload: { _subType: "turn.failed", turnId: "community-preview-turn" },
      },
    });
    expect(failed.ok(), await failed.text()).toBeTruthy();
    await expect(stage.getByTestId("stage-hud")).toContainText("SSE Cove");
    const afterFailure = await request.get(
      `/api/sessions/${sessionId}/ui-slots?slot=stage.backdrop@1`,
    );
    expect((await afterFailure.json()).items[0].value.name).toBe("SSE Cove");
    expect(worldDigest()).toBe(beforeWorld);
  } finally {
    await page.goto("about:blank");
    const deleted = await request.delete(`/api/sessions/${sessionId}`);
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
  }
});
