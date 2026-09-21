import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@covel/shared";
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

const fixturePlugin: PluginSummary = {
  id: "fixture",
  displayName: "Fixture",
  description: "Fixture plugin",
  pluginType: "plugin",
  source: "builtin",
  status: "registered",
  runtimeCount: 1,
  capabilities: [],
  tags: [],
  runtimes: [
    {
      id: "fixture/runtime",
      runtimeType: "agent",
      model: "text",
      trigger: { type: "auto" },
      execution: "sync",
      turnCompletion: { mode: "await" },
      outputKind: "plugin",
      capabilities: [],
      tags: [],
    },
  ],
  tools: [],
  userSettings: [],
};

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
});

describe("PluginListPanel runtime model overrides", () => {
  it("shows an unavailable default without displaying another role as its model", () => {
    render(
      <PluginListPanel
        plugins={[fixturePlugin]}
        sessionId={session.id}
        runtimeModelOverrides={{ "fixture/runtime": "default" }}
        resolvedSlots={[
          {
            slotId: "story",
            presetId: "bad",
            preset: null,
            label: "story",
            tag: "text",
            isAvailable: false,
          },
          {
            slotId: "text",
            presetId: "ok",
            preset: null,
            label: "text",
            tag: "text",
            serverModel: "other-model",
          },
        ]}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Customize plugins and advanced settings",
      }),
    );
    fireEvent.click(screen.getByText("Fixture"));
    expect(screen.getByRole("status").textContent).toContain("default");
    expect(screen.getByRole("status").textContent).not.toContain("other-model");
  });

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
        plugins={[fixturePlugin]}
        sessionId={session.id}
        runtimeModelOverrides={{ "fixture/runtime": "text" }}
        resolvedSlots={[
          {
            slotId: "broken",
            presetId: "bad",
            preset: null,
            label: "broken",
            tag: "text",
            isAvailable: false,
          },
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

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Customize plugins and advanced settings",
      }),
    );
    fireEvent.click(screen.getByText("Fixture"));
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(screen.queryByRole("option", { name: /^broken$/ })).toBeNull();
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
        plugins={[fixturePlugin]}
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

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Customize plugins and advanced settings",
      }),
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
      plugins: [fixturePlugin],
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

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Customize plugins and advanced settings",
      }),
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

it("uses session metadata and exposes every agent runtime with text-only role choices", async () => {
  const first = fixturePlugin.runtimes[0]!;
  const sessionPlugin = {
    ...fixturePlugin,
    displayName: "Current session plugin",
    active: true,
    locked: false,
    runtimes: [
      {
        ...first,
        id: "fixture/function",
        runtimeType: "function" as const,
        stage: "pre-turn" as const,
        model: undefined,
      },
      {
        ...first,
        id: "fixture/story",
        model: "story",
        stage: "narrative" as const,
      },
      {
        ...first,
        id: "fixture/tracker",
        model: "tracker",
        stage: "post-turn" as const,
      },
    ],
  };
  api.updateSession.mockImplementation(async (_id, update) => ({
    ...session,
    ...update,
  }));
  render(
    <PluginListPanel
      plugins={[
        { ...fixturePlugin, displayName: "Obsolete catalogue description" },
      ]}
      sessionPlugins={[sessionPlugin]}
      sessionId={session.id}
      runtimeModelOverrides={{ "fixture/story": "story" }}
      resolvedSlots={[
        {
          slotId: "story",
          label: "story",
          tag: "text",
          presetId: "",
          preset: null,
          serverModel: "story-model",
        },
        {
          slotId: "tracker",
          label: "tracker",
          tag: "text",
          presetId: "",
          preset: null,
          serverModel: "tracker-model",
        },
        {
          slotId: "image",
          label: "image",
          tag: "image",
          presetId: "",
          preset: null,
          serverModel: "image-model",
        },
      ]}
    />,
  );
  expect(screen.queryByText("Obsolete catalogue description")).toBeNull();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Customize plugins and advanced settings",
    }),
  );
  expect(screen.getAllByRole("combobox")).toHaveLength(2);
  expect(screen.getByText("Narrative")).toBeTruthy();
  expect(screen.getByText("Post-Turn")).toBeTruthy();
  const tracker = screen.getByRole("combobox", {
    name: "Model · fixture/tracker",
  }) as HTMLSelectElement;
  expect(
    Array.from(tracker.options).map((option) => option.value),
  ).not.toContain("image");
  expect(
    screen.getByText("tracker · tracker-model", { selector: "span" }),
  ).toBeTruthy();
  fireEvent.change(tracker, { target: { value: "story" } });
  await waitFor(() =>
    expect(api.updateSession).toHaveBeenCalledWith(session.id, {
      runtimeModelOverrides: {
        "fixture/story": "story",
        "fixture/tracker": "story",
      },
    }),
  );
});
