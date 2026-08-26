import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SessionRecord } from "@/services/api.js";
import { PluginListPanel } from "../../plugin-list-panel.js";

const api = vi.hoisted(() => ({
  updateSession: vi.fn(),
}));

vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  updateSession: api.updateSession,
}));

vi.mock("@/services/data-service.js", () => ({
  getDataService: () => ({ updateSession: api.updateSession }),
}));

const session = {
  id: "sess-a",
  worldId: "world-a",
  status: "active",
  phase: "setup",
  completedPlayerTurns: 0,
  setupRuntimes: {},
  activePlugins: ["fixture"],
  locale: "en-US",
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
} satisfies SessionRecord;

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
});

describe("PluginListPanel runtime model overrides", () => {
  it("persists the latest full map and rolls back a failed latest change", async () => {
    let resolveFirst!: (session: SessionRecord) => void;
    api.updateSession
      .mockReturnValueOnce(
        new Promise<SessionRecord>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({
        ...session,
        runtimeModelOverrides: { "fixture/runtime": "quality" },
      })
      .mockRejectedValueOnce(new Error("disk full"));

    render(
      <PluginListPanel
        packages={[
          {
            name: "fixture",
            displayName: "Fixture",
            enabled: true,
            runtimes: [
              {
                id: "fixture/runtime",
                kind: "agent",
                model: "text",
                trigger: { type: "auto" },
              },
            ],
          },
        ]}
        sessionId={session.id}
        runtimeModelOverrides={{ "fixture/runtime": "text" }}
        resolvedSlots={[
          {
            slotId: "text",
            presetId: "",
            preset: null,
            label: "text",
            tag: "text",
          },
          {
            slotId: "fast",
            presetId: "",
            preset: null,
            label: "fast",
            tag: "text",
          },
          {
            slotId: "quality",
            presetId: "",
            preset: null,
            label: "quality",
            tag: "text",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText("Fixture"));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "fast" } });
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(1));
    fireEvent.change(select, { target: { value: "quality" } });
    expect(select.value).toBe("quality");

    act(() => {
      resolveFirst({
        ...session,
        runtimeModelOverrides: { "fixture/runtime": "fast" },
      });
    });
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(2));
    expect(api.updateSession).toHaveBeenLastCalledWith(session.id, {
      runtimeModelOverrides: { "fixture/runtime": "quality" },
    });
    expect(select.value).toBe("quality");

    fireEvent.change(select, { target: { value: "fast" } });
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(select.value).toBe("quality");
    expect(screen.getByRole("alert").title).toBe("disk full");
  });

  it("rolls consecutive failed changes back to the last confirmed map", async () => {
    api.updateSession
      .mockRejectedValueOnce(new Error("first failed"))
      .mockRejectedValueOnce(new Error("second failed"));

    render(
      <PluginListPanel
        packages={[
          {
            name: "fixture",
            displayName: "Fixture",
            enabled: true,
            runtimes: [
              {
                id: "fixture/runtime",
                kind: "agent",
                model: "text",
                trigger: { type: "auto" },
              },
            ],
          },
        ]}
        sessionId={session.id}
        runtimeModelOverrides={{ "fixture/runtime": "text" }}
        resolvedSlots={[
          {
            slotId: "text",
            presetId: "",
            preset: null,
            label: "text",
            tag: "text",
          },
          {
            slotId: "fast",
            presetId: "",
            preset: null,
            label: "fast",
            tag: "text",
          },
          {
            slotId: "quality",
            presetId: "",
            preset: null,
            label: "quality",
            tag: "text",
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByText("Fixture"));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "fast" } });
    fireEvent.change(select, { target: { value: "quality" } });

    await waitFor(() => expect(api.updateSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(select.value).toBe("text");
  });

  it("resets optimistic state when sessions both omit overrides", async () => {
    let resolveFirst!: (session: SessionRecord) => void;
    api.updateSession.mockReturnValueOnce(
      new Promise<SessionRecord>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const props = {
      packages: [
        {
          name: "fixture",
          displayName: "Fixture",
          enabled: true,
          runtimes: [
            {
              id: "fixture/runtime",
              kind: "agent" as const,
              model: "text",
              trigger: { type: "auto" as const },
            },
          ],
        },
      ],
      resolvedSlots: [
        {
          slotId: "fast",
          presetId: "",
          preset: null,
          label: "fast",
          tag: "text",
        },
      ],
    };
    const { rerender } = render(
      <PluginListPanel {...props} sessionId="sess-a" />,
    );

    fireEvent.click(screen.getByText("Fixture"));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "fast" } });
    expect(select.value).toBe("fast");
    await waitFor(() => expect(api.updateSession).toHaveBeenCalledOnce());

    rerender(<PluginListPanel {...props} sessionId="sess-b" />);
    await waitFor(() => expect(select.value).toBe(""));

    act(() => resolveFirst(session));
    await Promise.resolve();
    expect(select.value).toBe("");
  });
});
