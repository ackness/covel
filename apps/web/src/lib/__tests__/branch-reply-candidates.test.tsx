import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { JSONUIProvider } from "@json-render/react";
import { covelRegistry } from "../catalog.js";
import { postPluginRpc } from "@/services/api.js";

const sessionMock = vi.hoisted(() => ({
  current: {
    state: {
      session: { id: "sess-branch" },
      pendingInteractionDrafts: [],
    },
    sendMessage: vi.fn(),
    upsertInteractionDraft: vi.fn(),
  },
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => sessionMock.current,
}));

vi.mock("@/services/api.js", () => ({
  postPluginRpc: vi.fn(() => Promise.resolve({ status: "ok" })),
}));

vi.mock("@/lib/toast-channel.js", () => ({
  emitToast: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  sessionMock.current = {
    state: {
      session: { id: "sess-branch" },
      pendingInteractionDrafts: [],
    },
    sendMessage: vi.fn(),
    upsertInteractionDraft: vi.fn(),
  };
});

function renderBranchReply(value: Record<string, unknown>) {
  const BranchReplyCandidates = covelRegistry.BranchReplyCandidates;
  return render(
    <JSONUIProvider registry={covelRegistry}>
      <BranchReplyCandidates
        element={{
          type: "BranchReplyCandidates",
          props: {
            pluginId: "branch-reply",
            value,
            title: "Reply candidates",
            draftLabel: "Draft",
            sendLabel: "Send",
            acceptLabel: "Accept",
            regenerateLabel: "Regenerate",
          },
        }}
        emit={() => {}}
        on={() => ({
          emit: () => {},
          shouldPreventDefault: false,
          bound: false,
        })}
      />
    </JSONUIProvider>,
  );
}

describe("BranchReplyCandidates", () => {
  const candidateSet = {
    turnId: "turn-42",
    candidates: [
      {
        id: "turn-42-candidate-1",
        text: "Ask about the sealed door.",
        source: "deterministic",
      },
      {
        id: "turn-42-candidate-2",
        text: "Wait and watch the guard.",
        source: "deterministic",
      },
    ],
  };

  it("accepts a candidate through the branch-reply runtime contract", async () => {
    renderBranchReply(candidateSet);

    fireEvent.click(screen.getAllByRole("button", { name: "Accept" })[1]);

    await waitFor(() => {
      expect(postPluginRpc).toHaveBeenCalledWith("sess-branch", {
        pluginId: "branch-reply",
        runtimeId: "branch-reply",
        payload: {
          action: "acceptCandidate",
          turnId: "turn-42",
          candidateId: "turn-42-candidate-2",
        },
      });
    });
  });

  it("regenerates through the branch-reply runtime contract", async () => {
    renderBranchReply(candidateSet);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));

    await waitFor(() => {
      expect(postPluginRpc).toHaveBeenCalledWith("sess-branch", {
        pluginId: "branch-reply",
        runtimeId: "branch-reply",
        payload: {
          action: "createCandidates",
          turnId: "turn-42",
          baseText: "Ask about the sealed door.",
          count: 3,
        },
      });
    });
  });

  it("does not re-render the seeded original as a card (no duplicate reply)", () => {
    renderBranchReply({
      turnId: "turn-7",
      candidates: [
        {
          id: "turn-7-candidate-1",
          text: "The seeded narrator reply text.",
          source: "original",
        },
      ],
    });

    // The original IS the narrative message above — it must NOT appear as a
    // candidate card here. Regenerate stays available; the hint is shown.
    expect(screen.queryByText("The seeded narrator reply text.")).toBeNull();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("disables runtime actions when the message state has no turn id", () => {
    renderBranchReply({
      candidates: [{ id: "candidate-1", text: "Draft only." }],
    });

    expect(
      screen.getByRole("button", { name: "Accept" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps draft and send on the local session path", () => {
    renderBranchReply(candidateSet);

    fireEvent.click(screen.getAllByRole("button", { name: "Draft" })[0]);
    expect(sessionMock.current.upsertInteractionDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "turn-42",
        selectionGroup: "branch-reply:turn-42",
        values: {
          text: "Ask about the sealed door.",
          candidateId: "turn-42-candidate-1",
        },
      }),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Send" })[1]);
    expect(sessionMock.current.sendMessage).toHaveBeenCalledWith(
      "Wait and watch the guard.",
    );
  });
});
