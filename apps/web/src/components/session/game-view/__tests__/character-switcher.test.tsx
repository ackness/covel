import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionActionKindsResponse } from "@covel/shared";
import type { SessionRecord } from "@/services/api.js";
import { emitToast } from "@/lib/toast-channel.js";
import { ComposerModeBar } from "../composer-mode-bar.js";
import { useComposerModes } from "../use-composer-modes.js";

vi.mock("@/lib/toast-channel.js", () => ({ emitToast: vi.fn() }));

const sessionMock = {
  sessionActionKinds: null as SessionActionKindsResponse | null,
  gameState: {} as Record<string, unknown>,
  submitComposerAction: vi.fn(),
  switchSeatCharacter: vi.fn(async (_seat: string, _character: string) => {}),
};

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      sessionActionKinds: sessionMock.sessionActionKinds,
      gameState: sessionMock.gameState,
    },
    submitComposerAction: sessionMock.submitComposerAction,
    switchSeatCharacter: sessionMock.switchSeatCharacter,
  }),
}));

const session = (currentCharacterId?: string): SessionRecord =>
  ({
    id: "session-1",
    seats: [
      {
        id: "main",
        controller: "human",
        role: "player",
        characters: "auto",
        ...(currentCharacterId ? { currentCharacterId } : {}),
      },
    ],
  }) as unknown as SessionRecord;

const catalogue = (): SessionActionKindsResponse => ({
  kinds: [
    {
      kind: "say",
      roles: ["player"],
      text: "required",
      actor: true,
      source: "framework",
      display: { label: "Say" },
    },
    {
      kind: "narrate",
      roles: ["player"],
      text: "required",
      actor: false,
      source: "framework",
      display: { label: "Narrate" },
    },
  ],
  seats: [
    {
      seatId: "main",
      role: "player",
      controller: "human",
      allowed: ["say", "narrate"],
    },
  ],
});

const twoCharacters = [
  { id: "aya", name: "Aya", type: "player" },
  { id: "bo", name: "Bo", type: "player" },
];

function Harness({
  record,
  executing = false,
  pickKind,
}: {
  record: SessionRecord;
  executing?: boolean;
  pickKind?: string;
}) {
  const composerModes = useComposerModes({
    session: record,
    executing,
    onSendMessage: vi.fn(),
  });
  return (
    <>
      <button
        type="button"
        onClick={() => composerModes.selectKind(pickKind ?? "say")}
      >
        pick
      </button>
      <ComposerModeBar
        t={((_key: string, fallback?: string) => fallback ?? _key) as never}
        composerModes={composerModes}
        executing={executing}
      />
    </>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.sessionActionKinds = catalogue();
  sessionMock.gameState = { characters: twoCharacters };
});
afterEach(cleanup);

describe("character switcher", () => {
  it("lists the bound characters with the current one selected", () => {
    render(<Harness record={session("bo")} />);
    const select = screen.getByTestId(
      "composer-character-switcher",
    ) as HTMLSelectElement;
    expect([...select.options].map((option) => option.text)).toEqual([
      "Aya",
      "Bo",
    ]);
    expect(select.value).toBe("bo");
  });

  it("is hidden when the seat binds one character", () => {
    sessionMock.gameState = { characters: twoCharacters.slice(0, 1) };
    render(<Harness record={session()} />);
    expect(screen.queryByTestId("composer-character-switcher")).toBeNull();
  });

  it("is hidden in a mode that is not taken as a character", () => {
    render(<Harness record={session()} pickKind="narrate" />);
    expect(screen.getByTestId("composer-character-switcher")).toBeTruthy();
    fireEvent.click(screen.getByText("pick"));
    expect(screen.queryByTestId("composer-character-switcher")).toBeNull();
  });

  it("asks the store to switch the seat's character", () => {
    render(<Harness record={session()} />);
    fireEvent.change(screen.getByTestId("composer-character-switcher"), {
      target: { value: "bo" },
    });
    expect(sessionMock.switchSeatCharacter).toHaveBeenCalledExactlyOnceWith(
      "main",
      "bo",
    );
  });

  it("keeps the selection and says why when the server refuses", async () => {
    sessionMock.switchSeatCharacter.mockRejectedValueOnce(
      new Error("Character bo is not bound to seat main"),
    );
    render(<Harness record={session("aya")} />);
    const select = screen.getByTestId(
      "composer-character-switcher",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "bo" } });
    await vi.waitFor(() =>
      expect(emitToast).toHaveBeenCalledWith(
        "error",
        expect.any(String),
        "Character bo is not bound to seat main",
      ),
    );
    expect(select.value).toBe("aya");
  });

  it("is disabled while a turn executes", () => {
    render(<Harness record={session()} executing />);
    expect(
      (screen.getByTestId("composer-character-switcher") as HTMLSelectElement)
        .disabled,
    ).toBe(true);
  });
});
