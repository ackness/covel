import { expect, test } from "@playwright/test";
import { seedAppSettings } from "./helpers/player.js";

test("closing an owner tab releases the workspace and lets another tab recover the durable result", async ({
  page,
  context,
}) => {
  const sessionId = `workspace-${crypto.randomUUID()}`;
  const worldId = `workspace-world-${crypto.randomUUID()}`;
  const second = await context.newPage();
  await seedAppSettings(page);
  await seedAppSettings(second);
  await page.goto("/session");
  await second.goto("/session");
  await expect(page.locator("article").first()).toBeVisible();
  await expect(second.locator("article").first()).toBeVisible();
  try {
    await page.evaluate(
      async ({ sessionId, worldId }) => {
        const servicePath = "/src/services/data-service.ts";
        const apiPath = "/src/services/api.ts";
        const { getDataService, getSessionWorkspace } = await import(
          servicePath
        );
        const { updateSession } = await import(apiPath);
        const ds = getDataService();
        await ds.saveGeneratedWorld({
          id: worldId,
          name: "Workspace owner exit",
          description: "Synthetic fixture",
          createdAt: "2026-01-01T00:00:00Z",
        });
        await ds.createSession(worldId, undefined, sessionId, [], "en-US");
        const probe = window as unknown as {
          mutationDone?: boolean;
          failure?: string;
        };
        void getSessionWorkspace()
          .run(sessionId, "owner-exit-action", async () => {
            await updateSession(sessionId, { presetId: "owner-exit-preset" });
            probe.mutationDone = true;
            await new Promise<void>(() => {});
          })
          .catch((error: Error) => {
            probe.failure = error.message;
          });
      },
      { sessionId, worldId },
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { mutationDone?: boolean }).mutationDone,
        ),
      )
      .toBe(true);
    await page.close();
    const recovered = await second.evaluate(async (sessionId) => {
      const servicePath = "/src/services/data-service.ts";
      const vaultPath = "/src/services/storage/browser-vault.ts";
      const { getDataService, getSessionWorkspace } = await import(servicePath);
      const { BrowserVault } = await import(vaultPath);
      await getSessionWorkspace().hydrate(sessionId);
      return {
        session: await getDataService().getSession(sessionId),
        pending: await new BrowserVault().getPendingCommit(sessionId),
      };
    }, sessionId);
    expect(recovered.session.presetId).toBe("owner-exit-preset");
    expect(recovered.pending).toBeNull();
  } finally {
    if (!page.isClosed()) await page.close();
    await second.evaluate(async (worldId) => {
      const servicePath = "/src/services/data-service.ts";
      const { getDataService } = await import(servicePath);
      await getDataService().deleteWorld(worldId);
    }, worldId);
    await second.close();
  }
});

for (const followUp of ["hydrate", "local write", "delete world"] as const) {
  test(`another tab waits for a live workspace before ${followUp}`, async ({
    page,
    context,
  }) => {
    const sessionId = `workspace-${crypto.randomUUID()}`;
    const worldId = `workspace-world-${crypto.randomUUID()}`;
    const second = await context.newPage();
    await seedAppSettings(page);
    await seedAppSettings(second);
    await page.goto("/session");
    await second.goto("/session");
    await expect(page.locator("article").first()).toBeVisible();
    await expect(second.locator("article").first()).toBeVisible();

    try {
      await page.evaluate(
        async ({ sessionId, worldId }) => {
          const servicePath = "/src/services/data-service.ts";
          const apiPath = "/src/services/api.ts";
          const { getDataService, getSessionWorkspace } = await import(
            servicePath
          );
          const { updateSession } = await import(apiPath);
          const ds = getDataService();
          await ds.saveGeneratedWorld({
            id: worldId,
            name: "Workspace concurrency",
            description: "Synthetic fixture",
            createdAt: "2026-01-01T00:00:00Z",
          });
          await ds.createSession(worldId, undefined, sessionId, [], "en-US");
          const gate = Promise.withResolvers<void>();
          const probe = window as unknown as {
            releaseWorkspace: () => void;
            workspaceStarted: boolean;
            workspaceResult: Promise<string>;
          };
          probe.releaseWorkspace = gate.resolve;
          probe.workspaceResult = getSessionWorkspace()
            .run(sessionId, "first-action", async () => {
              probe.workspaceStarted = true;
              await gate.promise;
              await updateSession(sessionId, {
                presetId: "completed-action-preset",
              });
            })
            .then(
              () => "completed",
              (error: Error) => error.message,
            );
        },
        { sessionId, worldId },
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as unknown as { workspaceStarted?: boolean })
                .workspaceStarted,
          ),
        )
        .toBe(true);

      await second.evaluate(
        async ({ sessionId, worldId, followUp }) => {
          const servicePath = "/src/services/data-service.ts";
          const { getSessionWorkspace, getDataService } = await import(
            servicePath
          );
          const probe = window as unknown as {
            hydrationResult: Promise<string>;
            hydrationFinished?: boolean;
          };
          const pending =
            followUp === "hydrate"
              ? getSessionWorkspace().hydrate(sessionId)
              : followUp === "local write"
                ? getDataService().updateSession(sessionId, {
                    runtimeModelOverrides: { "probe/main": "second-tab-slot" },
                  })
                : getDataService().deleteWorld(worldId);
          probe.hydrationResult = pending.then(
            () => {
              probe.hydrationFinished = true;
              return "completed";
            },
            (error: Error) => error.message,
          );
        },
        { sessionId, worldId, followUp },
      );
      // Observe either admission to the lock queue or an incorrect early finish.
      await expect
        .poll(() =>
          second.evaluate(async (sessionId) => {
            if (
              (window as unknown as { hydrationFinished?: boolean })
                .hydrationFinished
            )
              return true;
            return (
              (await navigator.locks.query()).pending?.some((lock) =>
                lock.name?.includes(sessionId),
              ) ?? false
            );
          }, sessionId),
        )
        .toBe(true);
      const recoveredWhileLive = await second.evaluate(
        () =>
          !!(window as unknown as { hydrationFinished?: boolean })
            .hydrationFinished,
      );
      await page.evaluate(() =>
        (
          window as unknown as { releaseWorkspace: () => void }
        ).releaseWorkspace(),
      );
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { workspaceResult: Promise<string> })
              .workspaceResult,
        ),
      ).toBe("completed");
      expect(
        await second.evaluate(
          () =>
            (window as unknown as { hydrationResult: Promise<string> })
              .hydrationResult,
        ),
      ).toBe("completed");

      await second.reload();
      const persisted = await second.evaluate(async (sessionId) => {
        const servicePath = "/src/services/data-service.ts";
        const { getDataService } = await import(servicePath);
        return getDataService().getSession(sessionId);
      }, sessionId);
      if (followUp === "delete world") {
        expect(persisted).toBeNull();
      } else {
        expect(
          persisted.presetId,
          `other tab recovered while live: ${recoveredWhileLive}`,
        ).toBe("completed-action-preset");
        if (followUp === "local write")
          expect(persisted.runtimeModelOverrides).toEqual({
            "probe/main": "second-tab-slot",
          });
      }
      expect(recoveredWhileLive).toBe(false);
    } finally {
      await page.evaluate(() =>
        (
          window as unknown as { releaseWorkspace?: () => void }
        ).releaseWorkspace?.(),
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
