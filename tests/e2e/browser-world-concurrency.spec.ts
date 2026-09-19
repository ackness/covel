import { expect, test } from "@playwright/test";
import { seedAppSettings } from "./helpers/player.js";

for (const scenario of ["edit", "delete"] as const) {
  test(`world ${scenario} coordinates with another document`, async ({
    page,
    context,
  }) => {
    const worldId = `world-concurrency-${crypto.randomUUID()}`;
    const sessionId = `world-session-${crypto.randomUUID()}`;
    const second = await context.newPage();
    await seedAppSettings(page);
    await seedAppSettings(second);
    await page.goto("/session");
    await second.goto("/session");
    await expect(page.locator("article").first()).toBeVisible();
    await expect(second.locator("article").first()).toBeVisible();

    try {
      await page.evaluate(
        async ({ worldId, sessionId, scenario }) => {
          const servicePath = "/src/services/data-service.ts";
          const vaultPath = "/src/services/storage/browser-vault.ts";
          const { getDataService } = await import(servicePath);
          const { BrowserVault } = await import(vaultPath);
          const service = getDataService();
          await service.saveGeneratedWorld({
            id: worldId,
            name: "Original",
            description: "Original",
            createdAt: "2026-01-01T00:00:00Z",
          });
          if (scenario === "delete")
            await service.createSession(worldId, sessionId, [], "en-US");
          const gate = Promise.withResolvers<void>();
          const probe = window as unknown as {
            worldOperationStarted?: boolean;
            releaseWorldOperation: () => void;
            worldOperation: Promise<void>;
          };
          probe.releaseWorldOperation = gate.resolve;
          if (scenario === "edit") {
            const original = BrowserVault.prototype.upsertWorld;
            BrowserVault.prototype.upsertWorld = async function (world) {
              if (world.id === worldId) {
                BrowserVault.prototype.upsertWorld = original;
                probe.worldOperationStarted = true;
                await gate.promise;
              }
              return original.call(this, world);
            };
            probe.worldOperation = service
              .updateWorld(worldId, { name: "Edited name" })
              .then(() => {});
          } else {
            const original = BrowserVault.prototype.deleteWorld;
            BrowserVault.prototype.deleteWorld = async function (id) {
              if (id === worldId) {
                BrowserVault.prototype.deleteWorld = original;
                probe.worldOperationStarted = true;
                await gate.promise;
              }
              return original.call(this, id);
            };
            probe.worldOperation = service.deleteWorld(worldId);
          }
        },
        { worldId, sessionId, scenario },
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { worldOperationStarted?: boolean })
                .worldOperationStarted,
          ),
        )
        .toBe(true);

      await second.evaluate(
        async ({ worldId, sessionId, scenario }) => {
          const servicePath = "/src/services/data-service.ts";
          const { getDataService } = await import(servicePath);
          const probe = window as unknown as {
            competingFinished?: boolean;
            competing: Promise<string>;
          };
          const operation =
            scenario === "edit"
              ? getDataService().updateWorld(worldId, {
                  description: "Edited description",
                })
              : getDataService().createSession(
                  worldId,
                  `${sessionId}-new`,
                  [],
                  "en-US",
                );
          probe.competing = operation
            .then(
              () => "completed",
              (error: Error) => error.message,
            )
            .finally(() => {
              probe.competingFinished = true;
            });
        },
        { worldId, sessionId, scenario },
      );
      await expect
        .poll(() =>
          second.evaluate(async (worldId) => {
            if (
              (window as unknown as { competingFinished?: boolean })
                .competingFinished
            )
              return true;
            return (
              (await navigator.locks.query()).pending?.some((lock) =>
                lock.name?.includes(worldId),
              ) ?? false
            );
          }, worldId),
        )
        .toBe(true);
      const finishedEarly = await second.evaluate(
        () =>
          !!(window as unknown as { competingFinished?: boolean })
            .competingFinished,
      );
      await page.evaluate(() =>
        (
          window as unknown as { releaseWorldOperation: () => void }
        ).releaseWorldOperation(),
      );
      await page.evaluate(
        () =>
          (window as unknown as { worldOperation: Promise<void> })
            .worldOperation,
      );
      expect(
        await second.evaluate(
          () => (window as unknown as { competing: Promise<string> }).competing,
        ),
      ).toBe(scenario === "edit" ? "completed" : `World not found: ${worldId}`);
      await second.reload();
      const persisted = await second.evaluate(
        async ({ worldId, sessionId }) => {
          const servicePath = "/src/services/data-service.ts";
          const { getDataService } = await import(servicePath);
          return {
            world: await getDataService().getWorld(worldId),
            session: await getDataService().getSession(`${sessionId}-new`),
          };
        },
        { worldId, sessionId },
      );
      if (scenario === "edit")
        expect(persisted.world).toMatchObject({
          name: "Edited name",
          description: "Edited description",
        });
      else expect(persisted).toEqual({ world: null, session: null });
      expect(finishedEarly).toBe(false);
    } finally {
      await page.evaluate(() =>
        (
          window as unknown as { releaseWorldOperation?: () => void }
        ).releaseWorldOperation?.(),
      );
      await second.close();
      await page.evaluate(async (worldId) => {
        const servicePath = "/src/services/data-service.ts";
        const { getDataService } = await import(servicePath);
        await getDataService().deleteWorld(worldId);
      }, worldId);
    }
  });
}
