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

for (const delayed of ["creation", "verification"] as const) {
  test(`world deletion reconciles credentials with delayed ${delayed}`, async ({
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
    const otherWorldId = `credential-other-${crypto.randomUUID()}`;
    const sessionId = `credential-session-${crypto.randomUUID()}`;
    const removedId = `${sessionId}-removed`;
    const otherId = `${sessionId}-other`;
    const entered = deferred();
    const release = deferred();
    let pending: Promise<string | undefined> | undefined;
    try {
      await page.evaluate(
        async ({
          worldId,
          otherWorldId,
          sessionId,
          removedId,
          otherId,
          delayed,
        }) => {
          const path = "/src/services/api.ts";
          const api = await import(path);
          await api.createWorld({
            id: worldId,
            name: "Credential fixture",
            description: "Synthetic",
          });
          await api.createWorld({
            id: otherWorldId,
            name: "Other credential fixture",
            description: "Synthetic",
          });
          await api.createSession(otherWorldId, otherId, []);
          if (delayed === "verification") {
            await api.createSession(worldId, sessionId, []);
            await api.createSession(worldId, removedId, []);
          }
        },
        { worldId, otherWorldId, sessionId, removedId, otherId, delayed },
      );
      const otherToken = await readToken(page, otherId);
      const originalToken = await readToken(page, sessionId);
      await page.route(
        delayed === "creation"
          ? "**/api/sessions"
          : `**/api/sessions/${sessionId}`,
        async (route) => {
          const response = await route.fetch();
          expect(response.status()).toBe(delayed === "creation" ? 201 : 404);
          entered.resolve();
          await release.promise;
          await route.fulfill({ response });
        },
        { times: 1 },
      );
      pending = page.evaluate(
        async ({ delayed, worldId, sessionId }) => {
          const path = "/src/services/api.ts";
          const api = await import(path);
          try {
            if (delayed === "creation")
              await api.createSession(worldId, sessionId, []);
            else await api.deleteWorld(worldId);
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : "Unknown failure";
          }
        },
        { delayed, worldId, sessionId },
      );
      await entered.promise;
      await second.evaluate(
        async ({ delayed, worldId, sessionId }) => {
          const path = "/src/services/api.ts";
          const api = await import(path);
          if (delayed === "creation") await api.deleteWorld(worldId);
          else {
            await api.createWorld({
              id: worldId,
              name: "Replacement fixture",
              description: "Synthetic",
            });
            await api.createSession(worldId, sessionId, []);
          }
        },
        { delayed, worldId, sessionId },
      );
      const replacementToken = await readToken(second, sessionId);
      release.resolve();
      expect(await pending).toBe(
        delayed === "creation"
          ? "Created session is no longer current"
          : undefined,
      );
      if (delayed === "creation")
        expect(await readToken(page, sessionId)).toBeUndefined();
      else {
        expect(replacementToken).toBeTruthy();
        expect(replacementToken).not.toBe(originalToken);
        expect(await readToken(page, sessionId)).toBe(replacementToken);
        expect(await readToken(page, removedId)).toBeUndefined();
      }
      await page.reload();
      expect(await readToken(page, sessionId)).toBe(
        delayed === "creation" ? undefined : replacementToken,
      );
      expect(await readToken(page, otherId)).toBe(otherToken);
    } finally {
      release.resolve();
      await pending?.catch(() => {});
      await second
        .evaluate(
          async (ids) => {
            const path = "/src/services/api.ts";
            const api = await import(path);
            for (const id of ids) await api.deleteWorld(id).catch(() => {});
          },
          [worldId, otherWorldId],
        )
        .catch(() => {});
      await second.close();
    }
  });
}
