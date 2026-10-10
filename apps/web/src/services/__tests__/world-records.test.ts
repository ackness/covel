import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invalidateAllWorldRecords,
  invalidateWorldRecord,
  loadWorldRecord,
  useWorldRecord,
} from "../world-records.js";

const getWorld = vi.hoisted(() => vi.fn());
vi.mock("../data-service.js", () => ({ getDataService: () => ({ getWorld }) }));

const record = (lore: string) => ({
  id: "w",
  name: "W",
  description: "",
  lore,
  createdAt: "2026-01-01",
});

beforeEach(() => {
  invalidateAllWorldRecords();
  getWorld.mockReset();
});

describe("world records", () => {
  it("fetches a world once for every reader", async () => {
    getWorld.mockResolvedValue(record("one"));
    await Promise.all([loadWorldRecord("w"), loadWorldRecord("w")]);
    await loadWorldRecord("w");
    expect(getWorld).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous record while an invalidated one is fetched again", async () => {
    getWorld.mockResolvedValueOnce(record("one"));
    const { result } = renderHook(() => useWorldRecord("w"));
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.status).toBe("ready"));

    let release!: (value: ReturnType<typeof record>) => void;
    getWorld.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    act(() => invalidateWorldRecord("w"));
    expect(result.current.status).toBe("loading");
    expect(result.current.world?.lore).toBe("one");
    await act(async () => release(record("two")));
    await waitFor(() => expect(result.current.world?.lore).toBe("two"));
  });

  it("reads again when the record is invalidated while its first fetch is in flight", async () => {
    let releaseFirst!: (value: ReturnType<typeof record>) => void;
    getWorld.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    );
    const { result } = renderHook(() => useWorldRecord("w"));
    expect(result.current.status).toBe("loading");

    getWorld.mockResolvedValueOnce(record("two"));
    act(() => invalidateWorldRecord("w"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.world?.lore).toBe("two");
    // The first fetch finishing late does not replace the newer record.
    await act(async () => releaseFirst(record("one")));
    expect(result.current.world?.lore).toBe("two");
    expect(getWorld).toHaveBeenCalledTimes(2);
  });

  it("reports a failed fetch and fetches again on retry", async () => {
    getWorld.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useWorldRecord("w"));
    await waitFor(() => expect(result.current.status).toBe("error"));
    getWorld.mockResolvedValueOnce(record("one"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(getWorld).toHaveBeenCalledTimes(2);
  });
});
