import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestrationResponse } from "@covel/shared";
import { OrchestrationSettings } from "../orchestration-settings.js";
import {
  getOrchestration,
  patchOrchestration,
} from "@/services/api/sessions.js";

vi.mock("@/services/api/sessions.js", () => ({
  getOrchestration: vi.fn(),
  patchOrchestration: vi.fn(),
}));
const data = vi.hoisted(() => ({
  getSession: vi.fn(),
  updateSession: vi.fn(),
}));
vi.mock("@/settings/SettingsDialog.js", () => ({ SettingsDialog: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, args?: { field?: string }) =>
      args?.field ? `save-${args.field}` : key,
  }),
}));
vi.mock("@/services/data-service.js", () => ({
  getDataService: () => data,
  getSessionWorkspace: () => ({
    run: (_session: string, _action: string, mutate: () => Promise<unknown>) =>
      mutate(),
  }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const base: OrchestrationResponse = {
  settings: { maxActors: 4, maxSubagentCalls: 16 },
  status: "ambiguous",
  policies: [
    {
      pluginId: "sample",
      name: "ensemble",
      label: "Ensemble",
      status: "available",
    },
    { pluginId: "sample", name: "draw", label: "Draw", status: "available" },
  ],
};
describe("orchestration controls", () => {
  it("stays hidden when neither resource can be loaded", async () => {
    vi.mocked(getOrchestration).mockRejectedValue(new Error("Unavailable"));
    data.getSession.mockImplementation(() => {
      throw new Error("No session reader");
    });
    const { container } = render(<OrchestrationSettings sessionId="scene" />);
    await waitFor(() => expect(data.getSession).toHaveBeenCalledWith("scene"));
    expect(container.childElementCount).toBe(0);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("keeps orchestration controls available after a synchronous session read failure", async () => {
    vi.mocked(getOrchestration).mockResolvedValue(base);
    data.getSession.mockImplementation(() => {
      throw new Error("No session reader");
    });
    render(<OrchestrationSettings sessionId="scene" />);
    const actors = await screen.findByLabelText("orchestration.maxActors");
    expect((actors as HTMLInputElement).disabled).toBe(false);
    expect(
      (screen.getByLabelText("session.autoAdvanceLimit") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("orchestration.error");
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("keeps all independent limits reachable without a policy provider", async () => {
    data.getSession.mockResolvedValue({ autoAdvanceLimit: 3 });
    const empty: OrchestrationResponse = {
      ...base,
      status: "missing",
      policies: [],
    };
    vi.mocked(getOrchestration).mockResolvedValue(empty);
    vi.mocked(patchOrchestration).mockResolvedValue({
      ...empty,
      settings: { ...empty.settings, maxSubagentCalls: 0 },
    });
    render(<OrchestrationSettings sessionId="scene" />);
    const calls = (await screen.findByLabelText(
      "orchestration.maxSubagentCalls",
    )) as HTMLInputElement;
    await waitFor(() => expect(calls.disabled).toBe(false));
    expect(screen.getAllByRole("spinbutton")).toHaveLength(3);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("orchestration.missing")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.change(calls, { target: { value: "0" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: "save-orchestration.maxSubagentCalls",
      }),
    );
    await waitFor(() =>
      expect(patchOrchestration).toHaveBeenCalledWith("scene", {
        maxSubagentCalls: 0,
      }),
    );
  });
  it.each([
    ["maxActors", "17"],
    ["maxSubagentCalls", "65"],
    ["autoAdvanceLimit", "11"],
    ["maxActors", "-1"],
    ["maxActors", "1.5"],
  ])(
    "keeps an invalid %s draft and associates its error",
    async (field, text) => {
      data.getSession.mockResolvedValue({ autoAdvanceLimit: 3 });
      vi.mocked(getOrchestration).mockResolvedValue(base);
      render(<OrchestrationSettings sessionId="scene" />);
      const label =
        field === "autoAdvanceLimit"
          ? "session.autoAdvanceLimit"
          : `orchestration.${field}`;
      const control = (await screen.findByLabelText(label)) as HTMLInputElement;
      await waitFor(() => expect(control.disabled).toBe(false));
      fireEvent.change(control, { target: { value: text } });
      fireEvent.click(screen.getByRole("button", { name: `save-${label}` }));
      expect(control.value).toBe(text);
      expect(control.getAttribute("aria-invalid")).toBe("true");
      expect(control.getAttribute("aria-describedby")).toMatch(/-error$/);
      expect(patchOrchestration).not.toHaveBeenCalled();
      expect(data.updateSession).not.toHaveBeenCalled();
    },
  );
  it.each(["orchestration", "advance"])(
    "retains failed drafts and successful independent saves when %s fails",
    async (failure) => {
      data.getSession.mockResolvedValue({ autoAdvanceLimit: 3 });
      vi.mocked(getOrchestration).mockResolvedValue(base);
      vi.mocked(patchOrchestration).mockImplementation(async (_id, patch) => {
        if (failure === "orchestration") throw new Error("Save refused");
        const updated = {
          ...base,
          settings: { ...base.settings, maxActors: patch.maxActors ?? 4 },
        };
        vi.mocked(getOrchestration).mockResolvedValue(updated);
        return updated;
      });
      data.updateSession.mockImplementation(async (_id, patch) => {
        if (failure === "advance") throw new Error("Save refused");
        const updated = { autoAdvanceLimit: patch.autoAdvanceLimit };
        data.getSession.mockResolvedValue(updated);
        return updated;
      });
      render(<OrchestrationSettings sessionId="scene" />);
      await screen.findByLabelText("orchestration.policy");
      await waitFor(() =>
        expect(
          (
            screen.getByLabelText(
              "session.autoAdvanceLimit",
            ) as HTMLInputElement
          ).value,
        ).toBe("3"),
      );
      expect(screen.getAllByRole("spinbutton")).toHaveLength(3);
      expect(screen.getAllByRole("combobox")).toHaveLength(1);
      fireEvent.change(screen.getByLabelText("orchestration.maxActors"), {
        target: { value: "1" },
      });
      fireEvent.change(screen.getByLabelText("session.autoAdvanceLimit"), {
        target: { value: "2" },
      });
      fireEvent.click(
        screen.getByRole("button", { name: "save-orchestration.maxActors" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "save-session.autoAdvanceLimit" }),
      );
      await screen.findByRole("alert");
      expect(patchOrchestration).toHaveBeenCalledWith("scene", {
        maxActors: 1,
      });
      expect(data.updateSession).toHaveBeenCalledWith("scene", {
        autoAdvanceLimit: 2,
      });
      expect(
        (screen.getByLabelText("orchestration.maxActors") as HTMLInputElement)
          .value,
      ).toBe("1");
      expect(
        (screen.getByLabelText("session.autoAdvanceLimit") as HTMLInputElement)
          .value,
      ).toBe("2");
      const failed =
        failure === "advance"
          ? "session.autoAdvanceLimit"
          : "orchestration.maxActors";
      await waitFor(() =>
        expect(
          (
            screen.getByRole("button", {
              name: `save-${failed}`,
            }) as HTMLButtonElement
          ).disabled,
        ).toBe(false),
      );
      expect(
        screen.getByLabelText(failed).getAttribute("aria-describedby"),
      ).toMatch(/-error$/);
    },
  );
  it("isolates late saves and loads from another session", async () => {
    let resolveGate: (value: OrchestrationResponse) => void = () => {};
    const gate = {
      promise: new Promise<OrchestrationResponse>((resolve) => {
        resolveGate = resolve;
      }),
      resolve: (value: OrchestrationResponse) => resolveGate(value),
    };
    data.getSession.mockResolvedValue({ autoAdvanceLimit: 3 });
    vi.mocked(getOrchestration).mockResolvedValue(base);
    vi.mocked(patchOrchestration).mockReturnValue(gate.promise);
    const view = render(<OrchestrationSettings sessionId="first" />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("orchestration.maxActors") as HTMLInputElement)
          .value,
      ).toBe("4"),
    );
    fireEvent.change(screen.getByLabelText("orchestration.maxActors"), {
      target: { value: "0" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "save-orchestration.maxActors" }),
    );
    view.rerender(<OrchestrationSettings sessionId="second" />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("orchestration.maxActors") as HTMLInputElement)
          .value,
      ).toBe("4"),
    );
    await act(async () =>
      gate.resolve({ ...base, settings: { ...base.settings, maxActors: 0 } }),
    );
    expect(
      (screen.getByLabelText("orchestration.maxActors") as HTMLInputElement)
        .value,
    ).toBe("4");
  });
  it("selects an exact service and represents zero caps", async () => {
    data.getSession.mockResolvedValue({ autoAdvanceLimit: 3 });
    vi.mocked(getOrchestration).mockResolvedValue(base);
    vi.mocked(patchOrchestration).mockImplementation(async (_id, patch) => ({
      ...base,
      settings: {
        ...base.settings,
        ...patch,
        turnPolicy: patch.turnPolicy ?? undefined,
      },
    }));
    render(<OrchestrationSettings sessionId="scene" />);
    await waitFor(() =>
      expect(
        (screen.getByLabelText("orchestration.maxActors") as HTMLInputElement)
          .value,
      ).toBe("4"),
    );
    fireEvent.change(await screen.findByLabelText("orchestration.policy"), {
      target: { value: JSON.stringify({ pluginId: "sample", name: "draw" }) },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "save-orchestration.policy" }),
    );
    await waitFor(() =>
      expect(patchOrchestration).toHaveBeenCalledWith("scene", {
        turnPolicy: { pluginId: "sample", name: "draw" },
      }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("orchestration.maxActors") as HTMLInputElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("orchestration.maxActors"), {
      target: { value: "0" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "save-orchestration.maxActors" }),
    );
    await waitFor(() =>
      expect(patchOrchestration).toHaveBeenCalledWith("scene", {
        maxActors: 0,
      }),
    );
  });
  it("keeps an unavailable selection visible and permits clearing it", async () => {
    data.getSession.mockResolvedValue({ autoAdvanceLimit: 3 });
    vi.mocked(getOrchestration).mockResolvedValue({
      ...base,
      status: "missing",
      settings: {
        ...base.settings,
        turnPolicy: { pluginId: "gone", name: "Old plan" },
      },
      policies: [
        ...base.policies,
        {
          pluginId: "gone",
          name: "Old plan",
          label: "Old plan",
          status: "unavailable",
        },
      ],
    });
    vi.mocked(patchOrchestration).mockImplementation(async () => {
      vi.mocked(getOrchestration).mockResolvedValue(base);
      return base;
    });
    render(<OrchestrationSettings sessionId="scene" />);
    const control = await screen.findByLabelText("orchestration.policy");
    expect(
      (screen.getByRole("option", { name: /Old plan/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(control, { target: { value: "" } });
    fireEvent.click(
      screen.getByRole("button", { name: "save-orchestration.policy" }),
    );
    await waitFor(() =>
      expect(patchOrchestration).toHaveBeenCalledWith("scene", {
        turnPolicy: null,
      }),
    );
    await screen.findByText("orchestration.ambiguous");
  });
});
