import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { PingResult } from "@/services/api.js";
import { invalidateAllPingResults, PingButton } from "../ping-button.js";

const apiMocks = vi.hoisted(() => ({ pingPreset: vi.fn() }));

vi.mock("@/services/api.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/api.js")>();
  return { ...original, pingPreset: apiMocks.pingPreset };
});

describe("PingButton cache invalidation", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    apiMocks.pingPreset.mockReset();
    invalidateAllPingResults();
  });

  it("clears the visible result in an already mounted button", async () => {
    apiMocks.pingPreset.mockResolvedValue({
      ok: false,
      latencyMs: 0,
      error: "invalid API key",
    } satisfies PingResult);
    render(<PingButton target={{ kind: "preset", presetId: "story" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Ping" }));
    await screen.findByText("Authentication failed. Check the API key.");

    act(() => invalidateAllPingResults());
    expect(
      screen.queryByText("Authentication failed. Check the API key."),
    ).toBeNull();
  });

  it("discards a ping response completed after key invalidation", async () => {
    let resolvePing: ((result: PingResult) => void) | undefined;
    apiMocks.pingPreset.mockReturnValue(
      new Promise<PingResult>((resolve) => {
        resolvePing = resolve;
      }),
    );
    render(<PingButton target={{ kind: "preset", presetId: "story" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Ping" }));
    act(() => invalidateAllPingResults());
    await act(async () => {
      resolvePing?.({ ok: true, latencyMs: 42 });
    });

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Ping" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(screen.queryByText("42ms")).toBeNull();
  });

  it("keeps concurrent results for different targets", async () => {
    const resolvers = new Map<string, (result: PingResult) => void>();
    apiMocks.pingPreset.mockImplementation(
      (requestId: string) =>
        new Promise<PingResult>((resolve) => {
          resolvers.set(requestId, resolve);
        }),
    );
    render(
      <>
        <PingButton target={{ kind: "preset", presetId: "story" }} />
        <PingButton target={{ kind: "preset", presetId: "fast" }} />
      </>,
    );

    for (const button of screen.getAllByRole("button", { name: "Ping" })) {
      fireEvent.click(button);
    }
    await act(async () => {
      resolvers.get("story")?.({ ok: true, latencyMs: 11 });
    });
    await screen.findByText("11ms");
    await act(async () => {
      resolvers.get("fast")?.({ ok: true, latencyMs: 22 });
    });

    expect(await screen.findByText("22ms")).not.toBeNull();
    expect(screen.getByText("11ms")).not.toBeNull();
  });
});
