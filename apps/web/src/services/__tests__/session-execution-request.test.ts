import { afterEach, expect, it, vi } from "vitest";
import { getSessionExecution } from "../api/sessions.js";
import { ApiError } from "../api/request.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("lets the recovery poll own retry timing instead of retrying HTTP failures twice", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ error: "unavailable" }), { status: 503 }),
  );
  vi.stubGlobal("fetch", fetch);
  const pending = getSessionExecution("session", { retry: false }).catch(
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(60000);
  const error = await pending;
  expect(error).toBeInstanceOf(ApiError);
  expect(fetch).toHaveBeenCalledOnce();
});
