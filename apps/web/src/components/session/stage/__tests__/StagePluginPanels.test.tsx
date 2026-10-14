import i18n from "@/i18n/index.js";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UISlotSpec } from "@/services/api/plugin-data.js";
import { useRightPanelState } from "../../right-panel-state.js";
import { StageChoices } from "../StageChoices.js";
import { StagePluginPanels } from "../StagePluginPanels.js";

const api = vi.hoisted(() => ({
  fetchUiSpecs: vi.fn(),
  fetchServerHealth: vi.fn(),
}));
const activePlugins = [{ id: "probe", active: true }];
vi.mock("@/services/api.js", () => api);
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { sessionPlugins: activePlugins } }),
}));
// Simulate a webview invoking sendMessage on load, without player activation.
vi.mock("../../plugin-panel.js", () => ({
  PluginPanel: ({
    handlers,
    spec,
  }: {
    handlers: Record<string, (params: Record<string, unknown>) => void>;
    spec: Record<string, unknown>;
  }) => {
    useEffect(() => {
      handlers.sendMessage?.({ text: "Visit the docks" });
    }, []);
    return <div data-testid="loaded-panel">{String(spec.id)}</div>;
  },
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const spec: UISlotSpec = {
  id: "stage-only",
  label: "Stage probe",
  surfaces: ["stage"],
  webview: { html: "<p>Stage probe</p>" },
};

function Host({
  onSendMessage,
  executing = false,
}: {
  onSendMessage: (text: string) => void;
  executing?: boolean;
}) {
  const panelState = useRightPanelState("session");
  return (
    <StageChoices
      visible
      executing={executing}
      interactionChoices={[]}
      locale="en-US"
      onSendMessage={onSendMessage}
      extensions={(choices, onDraftMessage) => (
        <StagePluginPanels
          panelState={panelState}
          activePluginIds={["probe"]}
          turnIds={[]}
          choices={choices.map(({ id, label }) => ({ id, text: label }))}
          executing={executing}
          onDraftMessage={onDraftMessage}
        />
      )}
    />
  );
}

function succeed() {
  api.fetchServerHealth.mockResolvedValue({});
  api.fetchUiSpecs.mockResolvedValue({
    right: [
      {
        pluginId: "probe",
        specs: [spec, { ...spec, id: "panel-only", surfaces: ["panel"] }],
      },
      { pluginId: "inactive", specs: [spec] },
    ],
  });
}

describe("stage plugin panels", () => {
  it("reuses loaded stage-only specs and drafts automatic plugin messages until the player sends", async () => {
    succeed();
    const onSendMessage = vi.fn();
    render(<Host onSendMessage={onSendMessage} />);
    await screen.findByTestId("loaded-panel");
    expect(screen.getAllByTestId("loaded-panel")).toHaveLength(1);
    expect(screen.getByTestId("loaded-panel").textContent).toBe("stage-only");
    expect(api.fetchUiSpecs).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("stage-decision-input")).toHaveProperty(
      "value",
      "Visit the docks",
    );
    expect(onSendMessage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("stage-decision-input"), {
      target: { value: "Visit the market" },
    });
    fireEvent.keyDown(screen.getByTestId("stage-decision-input"), {
      key: "Enter",
    });
    expect(onSendMessage).toHaveBeenCalledExactlyOnceWith("Visit the market");
  });

  it("shows discovery failure and retries the shared request without blocking the composer", async () => {
    succeed();
    api.fetchUiSpecs.mockRejectedValueOnce(new Error("offline"));
    const onSendMessage = vi.fn();
    render(<Host onSendMessage={onSendMessage} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(i18n.t("session.panelLoadFailed"));
    fireEvent.change(screen.getByTestId("stage-decision-input"), {
      target: { value: "Continue" },
    });
    fireEvent.keyDown(screen.getByTestId("stage-decision-input"), {
      key: "Enter",
    });
    expect(onSendMessage).toHaveBeenCalledExactlyOnceWith("Continue");
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("common.retry") }),
    );
    await screen.findByTestId("loaded-panel");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.fetchUiSpecs).toHaveBeenCalledTimes(2);
  });

  it("keeps plugin messages locked during execution", async () => {
    succeed();
    const onSendMessage = vi.fn();
    render(<Host onSendMessage={onSendMessage} executing />);
    await screen.findByTestId("loaded-panel");
    expect(screen.getByTestId("stage-decision-input")).toHaveProperty(
      "value",
      "",
    );
    expect(onSendMessage).not.toHaveBeenCalled();
  });
});
