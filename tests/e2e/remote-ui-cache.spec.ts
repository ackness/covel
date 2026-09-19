import { expect, test, type Page } from "@playwright/test";
import { seedAppSettings } from "./helpers/player.js";

interface Owner {
  id: string;
  worldId: string;
  incarnation: string;
}

async function saveForm(page: Page, owner: Owner, label: string) {
  await page.evaluate(
    async ({ owner, label }) => {
      const modulePath = "/src/services/data-service/remote.ts";
      const { RemoteDataService } = await import(modulePath);
      await new RemoteDataService().saveSubmittedBlocks(
        owner.id,
        [label],
        { [label]: { value: label } },
        owner,
      );
    },
    { owner, label },
  );
}
async function saveHistory(page: Page, owner: Owner, turnId: string) {
  await page.evaluate(
    async ({ owner, turnId }) => {
      const modulePath = "/src/services/data-service/remote.ts";
      const { RemoteDataService } = await import(modulePath);
      await new RemoteDataService().saveExecutionSteps(
        owner.id,
        [{ turnId, runtimeId: "history-probe", status: "completed" }],
        owner,
      );
    },
    { owner, turnId },
  );
}
async function loadCache(page: Page, owner: Owner) {
  return page.evaluate(async (owner) => {
    const modulePath = "/src/services/data-service/remote.ts";
    const { RemoteDataService } = await import(modulePath);
    const ds = new RemoteDataService();
    return {
      forms: await ds.loadSubmittedBlocks(owner.id, owner),
      steps: await ds.loadExecutionSteps(owner.id, owner),
    };
  }, owner);
}

for (const kind of ["session", "world"] as const) {
  test(`remote UI cache follows ${kind} deletion across pages and same-id recreation`, async ({
    page,
    context,
  }) => {
    const second = await context.newPage();
    await seedAppSettings(page);
    await seedAppSettings(second);
    await page.goto("/session");
    await second.goto("/session");
    await expect(page.locator("article").first()).toBeVisible();
    await expect(second.locator("article").first()).toBeVisible();
    const worldId = `remote-cache-${crypto.randomUUID()}`;
    const id = `remote-cache-${crypto.randomUUID()}`;
    const create = (target: Page, createWorld: boolean) =>
      target.evaluate(
        async ({ worldId, id, createWorld }) => {
          const apiPath = "/src/services/api.ts";
          const { createWorld: addWorld } = await import(apiPath);
          const modulePath = "/src/services/data-service/remote.ts";
          const { RemoteDataService } = await import(modulePath);
          if (createWorld)
            await addWorld({
              id: worldId,
              name: "Remote cache fixture",
              description: "Synthetic",
            });
          return new RemoteDataService().createSession(
            worldId,
            id,
            [],
            "en-US",
          );
        },
        { worldId, id, createWorld },
      );
    let release: (() => void) | undefined;
    let pending: Promise<string> | undefined;
    try {
      const owner: Owner = await create(page, true);
      expect(owner.incarnation).toMatch(/^[a-f0-9]{64}$/);
      await Promise.all([
        saveForm(page, owner, "first"),
        saveForm(second, owner, "second"),
        saveHistory(page, owner, "first-turn"),
        saveHistory(second, owner, "second-turn"),
      ]);
      expect((await loadCache(second, owner)).forms.ids.sort()).toEqual([
        "first",
        "second",
      ]);
      await saveHistory(page, owner, "first-turn");
      const cached = await loadCache(second, owner);
      expect(cached.steps).toEqual(
        expect.arrayContaining([
          {
            turnId: "first-turn",
            runtimeId: "history-probe",
            status: "completed",
          },
          {
            turnId: "second-turn",
            runtimeId: "history-probe",
            status: "completed",
          },
        ]),
      );
      expect(cached.steps).toHaveLength(2);

      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(
        `**/api/sessions/${id}`,
        async (route) => {
          const response = await route.fetch();
          entered();
          await gate;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      pending = page.evaluate(async (owner) => {
        const modulePath = "/src/services/data-service/remote.ts";
        const { RemoteDataService } = await import(modulePath);
        try {
          await new RemoteDataService().loadExecutionSteps(owner.id, owner);
          return "loaded";
        } catch (error) {
          return error instanceof Error ? error.name : "unknown";
        }
      }, owner);
      await held;
      await second.evaluate(
        async ({ owner, kind }) => {
          const modulePath = "/src/services/data-service/remote.ts";
          const { RemoteDataService } = await import(modulePath);
          const ds = new RemoteDataService();
          if (kind === "session") await ds.deleteSession(owner.id);
          else await ds.deleteWorld(owner.worldId);
        },
        { owner, kind },
      );
      expect(
        await second.evaluate(async (owner) => {
          const modulePath = "/src/services/storage/remote-ui-cache.ts";
          const { listRemoteUiOwners } = await import(modulePath);
          return listRemoteUiOwners({ kind: "session", id: owner.id });
        }, owner),
      ).toEqual([]);
      const replacement: Owner = await create(second, kind === "world");
      expect(replacement.incarnation).not.toBe(owner.incarnation);
      await saveForm(second, replacement, "replacement");
      release!();
      expect(await pending).toBe("RemoteUiCacheChangedError");
      expect(await loadCache(page, replacement)).toEqual({
        forms: {
          ids: ["replacement"],
          values: { replacement: { value: "replacement" } },
        },
        steps: [],
      });
      await page.reload();
      expect((await loadCache(page, replacement)).forms.ids).toEqual([
        "replacement",
      ]);
    } finally {
      release?.();
      await pending?.catch(() => {});
      await second.evaluate(async (worldId) => {
        const modulePath = "/src/services/data-service/remote.ts";
        const { RemoteDataService } = await import(modulePath);
        await new RemoteDataService().deleteWorld(worldId).catch(() => {});
      }, worldId);
      await second.close();
    }
  });
}
