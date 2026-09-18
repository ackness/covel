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

async function saveForm(page: Page, sessionId: string, blockId: string) {
  return page.evaluate(
    async ({ sessionId, blockId }) => {
      const path = "/src/services/data-service.ts";
      const { getDataService } = await import(path);
      await getDataService().saveSubmittedBlocks(sessionId, [blockId], {
        [blockId]: { score: 7 },
      });
    },
    { sessionId, blockId },
  );
}

async function saveTimeline(page: Page, sessionId: string) {
  return page.evaluate(async (sessionId) => {
    const path = "/src/services/data-service.ts";
    const { getDataService } = await import(path);
    await getDataService().saveExecutionSteps(sessionId, [
      { runtimeId: "probe", status: "completed" },
    ]);
  }, sessionId);
}

async function readUiCache(page: Page, sessionId: string) {
  return page.evaluate(async (sessionId) => {
    const path = "/src/services/data-service.ts";
    const { getDataService } = await import(path);
    const ds = getDataService();
    const forms = await ds.loadSubmittedBlocks(sessionId);
    return {
      forms: { ...forms, ids: forms.ids.sort() },
      steps: await ds.loadExecutionSteps(sessionId),
    };
  }, sessionId);
}

test("session display caches persist across tabs and stay deleted after late writes", async ({
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
    await Promise.all([
      saveForm(page, sessionId, "first"),
      saveForm(second, sessionId, "second"),
      saveTimeline(second, sessionId),
    ]);
    const expectedUiCache = {
      forms: {
        ids: ["first", "second"],
        values: { first: { score: 7 }, second: { score: 7 } },
      },
      steps: [{ runtimeId: "probe", status: "completed" }],
    };
    expect(await readUiCache(page, sessionId)).toEqual(expectedUiCache);
    await page.reload();
    expect((await readPatches(page, sessionId)).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(await readUiCache(page, sessionId)).toEqual(expectedUiCache);
    await page.evaluate(async (sessionId) => {
      const path = "/src/services/data-service.ts";
      const { getDataService } = await import(path);
      await getDataService().deleteSession(sessionId);
    }, sessionId);
    await expect(appendPatch(second, sessionId, "late")).rejects.toThrow(
      "Session not found",
    );
    await expect(saveForm(second, sessionId, "late")).rejects.toThrow(
      "Session not found",
    );
    await expect(saveTimeline(second, sessionId)).rejects.toThrow(
      "Session not found",
    );
    await second.reload();
    expect(await readPatches(second, sessionId)).toEqual([]);
    expect(await readUiCache(second, sessionId)).toEqual({
      forms: { ids: [], values: {} },
      steps: [],
    });
  } finally {
    await second.close();
    await page.evaluate(async (worldId) => {
      const path = "/src/services/data-service.ts";
      const { getDataService } = await import(path);
      await getDataService().deleteWorld(worldId);
    }, worldId);
  }
});
