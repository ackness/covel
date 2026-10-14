import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
import { LocalDataService } from "../data-service/local.js";
import { BrowserVault } from "../storage/browser-vault.js";

it("creates readable local session IDs without weak randomness", async () => {
  const vault = new BrowserVault({
    dbName: `session-id-${crypto.randomUUID()}`,
  });
  const service = new LocalDataService(vault);
  await vault.upsertWorld({
    id: "world",
    name: "World",
    description: "",
    createdAt: "2026-10-14T00:00:00.000Z",
  });
  const random = vi.spyOn(Math, "random").mockImplementation(() => {
    throw new Error("Session IDs must not use Math.random");
  });
  try {
    const session = await service.createSession("world");
    expect(session.id).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[0-9a-f]{8}$/);
    expect((await service.getSession(session.id))?.id).toBe(session.id);
  } finally {
    random.mockRestore();
    await vault.deleteDatabase();
  }
});
