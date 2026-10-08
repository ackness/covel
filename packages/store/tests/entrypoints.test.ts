import { expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => {
  throw new Error("SQLite driver was eagerly loaded");
});
vi.mock("postgres", () => {
  throw new Error("PostgreSQL driver was eagerly loaded");
});
vi.mock("idb", () => {
  throw new Error("IndexedDB driver was eagerly loaded");
});

it("imports the root and creates an in-memory store without loading other drivers", async () => {
  const { createStore } = await import("../src/index.js");
  const store = await createStore({ backend: "memory" });
  expect(await store.listSessions()).toEqual([]);
  await store.close();
});
