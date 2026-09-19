import { expect, test, type Page } from "@playwright/test";
import { seedAppSettings } from "./helpers/player.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function readToken(page: Page, sessionId: string) {
  return page.evaluate(async (id) => {
    const path = "/src/services/session-credentials.ts";
    return (await import(path)).getSessionToken(id);
  }, sessionId);
}

for (const operation of ["create", "delete"] as const) {
  test(`a delayed ${operation} response preserves replacement credentials across pages`, async ({
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
    const worldId = `credential-world-${crypto.randomUUID()}`;
    const sessionId = `credential-session-${crypto.randomUUID()}`;
    const siblingIds = Array.from(
      { length: 8 },
      (_, index) => `${sessionId}-sibling-${index}`,
    );
    const entered = deferred();
    const release = deferred();
    let pending: Promise<string | undefined> | undefined;
    try {
      await page.evaluate(
        async ({ worldId, sessionId, operation }) => {
          const path = "/src/services/api.ts";
          const api = await import(path);
          await api.createWorld({
            id: worldId,
            name: "Credential fixture",
            description: "Synthetic",
          });
          if (operation === "delete")
            await api.createSession(worldId, undefined, sessionId, []);
        },
        { worldId, sessionId, operation },
      );
      await Promise.all(
        [page, second].map((target, index) =>
          target.evaluate(
            async (ids) => {
              const path = "/src/services/session-credentials.ts";
              const credentials = await import(path);
              await Promise.all(
                ids.map((id: string) =>
                  credentials.storeSessionToken(id, "synthetic-sibling-owner"),
                ),
              );
            },
            siblingIds.slice(index * 4, index * 4 + 4),
          ),
        ),
      );

      const oldToken = await readToken(page, sessionId);
      await page.route(
        operation === "create"
          ? "**/api/sessions"
          : `**/api/sessions/${sessionId}`,
        async (route) => {
          const response = await route.fetch();
          entered.resolve();
          await release.promise;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      pending = page.evaluate(
        async ({ operation, worldId, sessionId }) => {
          const path = "/src/services/api.ts";
          const api = await import(path);
          try {
            if (operation === "create")
              await api.createSession(worldId, undefined, sessionId, []);
            else await api.deleteSession(sessionId);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : "Unknown failure";
          }
        },
        { operation, worldId, sessionId },
      );
      await entered.promise;
      await second.evaluate(
        async ({ operation, worldId, sessionId }) => {
          const path = "/src/services/api.ts";
          const api = await import(path);
          if (operation === "create") await api.deleteSession(sessionId);
          await api.createSession(worldId, undefined, sessionId, []);
        },
        { operation, worldId, sessionId },
      );
      const replacementToken = await readToken(second, sessionId);
      expect(replacementToken).toBeTruthy();
      expect(replacementToken).not.toBe(oldToken);
      release.resolve();
      expect(await pending).toBe(
        operation === "create"
          ? "Session credential changed during creation"
          : undefined,
      );
      expect(await readToken(page, sessionId)).toBe(replacementToken);
      await page.reload();
      expect(await readToken(page, sessionId)).toBe(replacementToken);
      for (const id of siblingIds)
        expect(await readToken(page, id)).toBe("synthetic-sibling-owner");
    } finally {
      release.resolve();
      await pending?.catch(() => {});
      await second
        .evaluate(
          async ({ worldId, sessionId, siblingIds }) => {
            const apiPath = "/src/services/api.ts";
            const api = await import(apiPath);
            await api
              .deleteSession(sessionId, { silentErrors: true })
              .catch(() => {});
            await api.deleteWorld(worldId).catch(() => {});
            const credentialPath = "/src/services/session-credentials.ts";
            const credentials = await import(credentialPath);
            for (const id of siblingIds)
              await credentials.clearSessionToken(
                id,
                await credentials.getSessionToken(id),
              );
          },
          { worldId, sessionId, siblingIds },
        )
        .catch(() => {});
      await second.close();
    }
  });
}
