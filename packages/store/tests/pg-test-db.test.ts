import { beforeEach, describe, expect, it, vi } from "vitest";

const unsafe = vi.fn();
const end = vi.fn(async () => undefined);
const postgres = vi.fn(() => ({ unsafe, end }));

vi.mock("postgres", () => ({ default: postgres }));

import { createIsolatedPgDatabase } from "./pg-test-db.js";

describe("createIsolatedPgDatabase", () => {
  beforeEach(() => {
    unsafe.mockReset();
    end.mockClear();
    postgres.mockClear();
  });

  it("fails closed when CREATE DATABASE is unavailable", async () => {
    const denied = new Error("permission denied to create database");
    unsafe.mockRejectedValueOnce(denied);

    await expect(
      createIsolatedPgDatabase(
        "postgresql://user:pass@localhost:5432/shared",
        "contract_test",
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "refusing to run destructive schema tests against the shared database",
      ),
      cause: denied,
    });
    expect(end).toHaveBeenCalledOnce();
  });
});
