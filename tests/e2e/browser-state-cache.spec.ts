import { expect, test, type Page } from "@playwright/test";
import { seedAppSettings } from "./helpers/player.js";

async function readPatches(page: Page, sessionId: string) {
  return page.evaluate(async (sessionId) => {
    const path = "/src/services/data-service.ts";
    const { getDataService } = await import(path);
    return (await getDataService().listStatePatches(sessionId)).map(
      (patch) => patch.id,
    );
  }, sessionId);
}

async function appendPatch(page: Page, sessionId: string, id: string) {
  return page.evaluate(
    async ({ sessionId, id }) => {
      const path = "/src/services/data-service.ts";
      const { getDataService } = await import(path);
      await getDataService().addStatePatch(sessionId, {
        id,
        sessionId,
        summary: id,
        packageName: "probe",
        createdAt: "2026-01-01",
      });
    },
    { sessionId, id },
  );
}

test("state display history merges across tabs and stays deleted after a late event", async ({
  page,
  context,
}) => {
  const worldId = `cache-world-${crypto.randomUUID()}`;
  const sessionId = `cache-session-${crypto.randomUUID()}`;
  const second = await context.newPage();
  await seedAppSettings(page);
  await seedAppSettings(second);
  await page.goto("/session");
  await second.goto("/session");
  await expect(page.locator("article").first()).toBeVisible();
  await expect(second.locator("article").first()).toBeVisible();
  try {
    await page.evaluate(
      async ({ worldId, sessionId }) => {
        const path = "/src/services/data-service.ts";
        const { getDataService } = await import(path);
        await getDataService().saveGeneratedWorld({
          id: worldId,
          name: "Cache fixture",
          description: "Synthetic",
          createdAt: "2026-01-01",
        });
        await getDataService().createSession(
          worldId,
          undefined,
          sessionId,
          [],
          "en-US",
        );
      },
      { worldId, sessionId },
    );
    expect(await readPatches(page, sessionId)).toEqual([]);
    expect(await readPatches(second, sessionId)).toEqual([]);
    await Promise.all([
      appendPatch(page, sessionId, "first"),
      appendPatch(second, sessionId, "second"),
    ]);
    expect((await readPatches(page, sessionId)).sort()).toEqual([
      "first",
      "second",
    ]);
    expect((await readPatches(second, sessionId)).sort()).toEqual([
      "first",
      "second",
    ]);
    await page.reload();
    expect((await readPatches(page, sessionId)).sort()).toEqual([
      "first",
      "second",
    ]);
    await page.evaluate(async (sessionId) => {
      const path = "/src/services/data-service.ts";
      const { getDataService } = await import(path);
      await getDataService().deleteSession(sessionId);
    }, sessionId);
    await expect(appendPatch(second, sessionId, "late")).rejects.toThrow(
      "Session not found",
    );
    await second.reload();
    expect(await readPatches(second, sessionId)).toEqual([]);
  } finally {
    await second.close();
    await page.evaluate(async (worldId) => {
      const path = "/src/services/data-service.ts";
      const { getDataService } = await import(path);
      await getDataService().deleteWorld(worldId);
    }, worldId);
  }
});
