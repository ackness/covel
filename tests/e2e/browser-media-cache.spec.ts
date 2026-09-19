import { expect, test, type Page } from "@playwright/test";
import { seedAppSettings } from "./helpers/player.js";

async function save(page: Page, id: string, savedAt: number) {
  await page.evaluate(
    async ({ id, savedAt }) => {
      const path = "/src/lib/media-cache.ts";
      const { putCachedMedia } = await import(path);
      const blob = new Blob(["Synthetic cache bytes"], { type: "text/plain" });
      await putCachedMedia({
        id,
        mime: blob.type,
        size: blob.size,
        blob,
        savedAt,
      });
    },
    { id, savedAt },
  );
}

async function read(page: Page, id: string) {
  return page.evaluate(async (id) => {
    const path = "/src/lib/media-cache.ts";
    const { getCachedMedia } = await import(path);
    const record = await getCachedMedia(id);
    return (
      record && { savedAt: record.savedAt, content: await record.blob.text() }
    );
  }, id);
}

test("media cache survives cross-tab races and reload, reports aborts and releases deletion", async ({
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
  const id = `media-cache-${crypto.randomUUID()}`;
  try {
    await Promise.all([save(page, id, 1), save(second, id, 2)]);
    const first = await read(page, id);
    expect([1, 2]).toContain(first?.savedAt);
    expect(first?.content).toBe("Synthetic cache bytes");
    expect(await read(second, id)).toEqual(first);
    await save(second, id, 3);
    await page.reload();
    expect(await read(page, id)).toEqual(first);

    const aborted = `${id}-aborted`;
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "warning" &&
        message.text().includes("[media-cache]")
      )
        warnings.push(message.text());
    });
    const result = await page.evaluate(async (id) => {
      const path = "/src/lib/media-cache.ts";
      const { putCachedMedia, getCachedMedia } = await import(path);
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (value, key) {
        const request =
          key === undefined
            ? put.call(this, value)
            : put.call(this, value, key);
        if (value?.id === id)
          request.addEventListener("success", () => this.transaction.abort(), {
            once: true,
          });
        return request;
      };
      try {
        const blob = new Blob(["Aborted"], { type: "text/plain" });
        await putCachedMedia({
          id,
          mime: blob.type,
          size: blob.size,
          blob,
          savedAt: 1,
        });
        return getCachedMedia(id);
      } finally {
        IDBObjectStore.prototype.put = put;
      }
    }, aborted);
    expect(result).toBeNull();
    expect(warnings.some((message) => message.includes("write failed"))).toBe(
      true,
    );

    await page.evaluate(async () => {
      const path = "/src/services/storage/data-store.ts";
      const { BROWSER_STORAGE_DB_NAME } = await import(path);
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(BROWSER_STORAGE_DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
          reject(new Error("A cache connection blocked deletion"));
      });
    });
    expect(await read(second, id)).toBeNull();
    await save(page, id, 4);
    expect((await read(second, id))?.savedAt).toBe(4);
  } finally {
    await second.close();
  }
});
