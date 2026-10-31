import {
  cleanup,
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
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/services/data-service.js", () => ({
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
  it("selects an exact service and represents zero caps", async () => {
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
    fireEvent.change(await screen.findByLabelText("orchestration.policy"), {
      target: { value: JSON.stringify({ pluginId: "sample", name: "draw" }) },
    });
    await waitFor(() =>
      expect(patchOrchestration).toHaveBeenCalledWith("scene", {
        turnPolicy: { pluginId: "sample", name: "draw" },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByLabelText("orchestration.maxActors").closest("fieldset")
          ?.disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("orchestration.maxActors"), {
      target: { value: "0" },
    });
    await waitFor(() =>
      expect(patchOrchestration).toHaveBeenCalledWith("scene", {
        maxActors: 0,
      }),
    );
  });
  it("keeps an unavailable selection visible and permits clearing it", async () => {
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
    vi.mocked(patchOrchestration).mockResolvedValue(base);
    render(<OrchestrationSettings sessionId="scene" />);
    const control = await screen.findByLabelText("orchestration.policy");
    expect(
      (screen.getByRole("option", { name: /Old plan/ }) as HTMLOptionElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(control, { target: { value: "" } });
    await waitFor(() =>
      expect(patchOrchestration).toHaveBeenCalledWith("scene", {
        turnPolicy: null,
      }),
    );
    await screen.findByText("orchestration.ambiguous");
  });
});
