import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ZodError } from "zod";
import { LocalDataService } from "../data-service/local.js";
import { BrowserVault } from "../storage/browser-vault.js";

const preset = {
  version: 97,
  types: ["scout"],
  attributes: [
    {
      id: "title",
      name: { en: "Title", fr: "Titre" },
      type: "string",
      category: "bio",
      defaultValue: "Scout",
    },
  ],
};
let vault: BrowserVault;
let service: LocalDataService;
let id: string;

async function worldWith(characterSchema: unknown): Promise<void> {
  await vault.upsertWorld({
    id: "preset-world",
    name: "Preset",
    description: "",
    metadata: { characterSchema },
    createdAt: "2026-01-01",
  });
}

beforeEach(() => {
  id = `schema-${crypto.randomUUID()}`;
  vault = new BrowserVault({ dbName: id });
  service = new LocalDataService(vault);
});
afterEach(() => vault.deleteDatabase());

it("seeds a local session with the world's character schema, as the server does", async () => {
  await worldWith(preset);
  await service.createSession("preset-world", id);
  const checkpoint = (await vault.getLatestCheckpoint(id))!;
  expect(checkpoint.characterSchema).toEqual({
    ...preset,
    version: 1,
    sessionId: id,
    createdAt: checkpoint.committedAt,
    updatedAt: checkpoint.committedAt,
  });
});

it.each([undefined, null])(
  "leaves the schema empty for a world without a preset (%s)",
  async (schema) => {
    await worldWith(schema);
    await service.createSession("preset-world", id);
    expect((await vault.getLatestCheckpoint(id))!.characterSchema).toBeNull();
  },
);

it("refuses an invalid preset before it saves the session", async () => {
  await worldWith({
    types: ["scout"],
    attributes: [{ id: "x", name: "X", type: "invalid", category: "bio" }],
  });
  await expect(
    service.createSession("preset-world", id),
  ).rejects.toBeInstanceOf(ZodError);
  expect(await vault.getSession(id)).toBeNull();
  expect(await vault.getLatestCheckpoint(id)).toBeNull();
});
