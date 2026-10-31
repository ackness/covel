import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionActionKindsResponse } from "@covel/shared";
import type { SessionRecord } from "@/services/api.js";
import { emitToast } from "@/lib/toast-channel.js";
import { ComposerFields } from "../composer-fields.js";
import { useComposerModes } from "../use-composer-modes.js";

vi.mock("@/lib/toast-channel.js", () => ({ emitToast: vi.fn() }));

const consent = {
  kind: "p/consent",
  roles: ["player"],
  text: "none",
  actor: true,
  source: "plugin",
  pluginId: "p",
  display: { label: "Consent" },
  fieldsSchema: {
    type: "object",
    properties: { agree: { type: "boolean", title: "I agree" } },
    required: ["agree"],
  },
} as const;

const sessionMock = {
  submitComposerAction: vi.fn(),
  catalogue: {
    kinds: [consent],
    seats: [
      {
        seatId: "main",
        role: "player",
        controller: "human",
        allowed: ["p/consent"],
      },
    ],
  } as unknown as SessionActionKindsResponse,
};

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      sessionActionKinds: sessionMock.catalogue,
      gameState: {},
    },
    submitComposerAction: sessionMock.submitComposerAction,
    switchSeatCharacter: vi.fn(),
  }),
}));

const session = {
  id: "session-1",
  seats: [
    { id: "main", controller: "human", role: "player", characters: "auto" },
  ],
} as unknown as SessionRecord;

function Harness() {
  const modes = useComposerModes({
    session,
    executing: false,
    onSendMessage: vi.fn(),
  });
  const { selectKind } = modes;
  useEffect(() => selectKind("p/consent"), [selectKind]);
  return (
    <>
      <ComposerFields composerModes={modes} />
      <button type="button" onClick={() => modes.submit("")}>
        send
      </button>
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a required boolean field", () => {
  it("is submitted as false when left unchecked, as the input shows", () => {
    render(<Harness />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      false,
    );
    fireEvent.click(screen.getByText("send"));
    expect(emitToast).not.toHaveBeenCalled();
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
      { kind: "p/consent", fields: { agree: false } },
      undefined,
    );
  });

  it("is submitted as true once checked", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.click(screen.getByText("send"));
    expect(sessionMock.submitComposerAction).toHaveBeenCalledExactlyOnceWith(
      { kind: "p/consent", fields: { agree: true } },
      undefined,
    );
  });
});
