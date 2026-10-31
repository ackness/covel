import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionKindDescriptor, Seat, TurnAction } from "@covel/shared";
import i18n from "@/i18n";
import type { StreamMessage } from "@/stores/session-store.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { SessionState } from "@/stores/session-store/types.js";
import { toStreamMessages } from "@/stores/session-store/restore-session.js";
import { ChatMessageRenderer } from "../chat-message-renderer.js";
import { playerMessageLabel } from "../player-message-label.js";

const t = ((key: string, fallback?: string) =>
  key === "session.player" ? "Player" : (fallback ?? key)) as never;

const twoSeats: Seat[] = [
  { id: "main", controller: "human", role: "player", characters: "auto" },
];
const characters = [
  { id: "aya", type: "player", name: "阿雅" },
  { id: "bo", type: "player", name: "Bo" },
];
const oneCharacter = characters.slice(0, 1);

const action = (overrides: Partial<TurnAction>): TurnAction => ({
  seatId: "main",
  kind: "say",
  text: "hi",
  source: "player",
  ...overrides,
});

const context = (overrides = {}) => ({
  seats: twoSeats,
  characters,
  catalogue: [] as ActionKindDescriptor[],
  language: "en-US",
  t: ((key: string) => key.split(".").pop()!) as never,
  ...overrides,
});

describe("playerMessageLabel", () => {
  it("is absent for a plain say by the only character the seat binds", () => {
    expect(
      playerMessageLabel([action({ actorId: "aya" })], {
        ...context(),
        characters: oneCharacter,
      }),
    ).toBeNull();
  });

  it("is absent for a message without recorded actions", () => {
    expect(playerMessageLabel(undefined, context())).toBeNull();
    expect(playerMessageLabel([], context())).toBeNull();
  });

  it("names a second character's say", () => {
    expect(playerMessageLabel([action({ actorId: "bo" })], context())).toBe(
      "Bo · say",
    );
  });

  it("names the actor and the kind of an act", () => {
    expect(
      playerMessageLabel([action({ kind: "act", actorId: "aya" })], {
        ...context(),
        characters: oneCharacter,
      }),
    ).toBe("阿雅 · act");
  });

  it("shows the kind alone for an action without an actor", () => {
    expect(
      playerMessageLabel([action({ seatId: "gm", kind: "narrate" })], {
        ...context(),
        seats: [
          ...twoSeats,
          { id: "gm", controller: "human", role: "host", characters: [] },
        ],
      }),
    ).toBe("narrate");
  });

  it("uses a plugin kind's own label and joins several actions", () => {
    const whisper: ActionKindDescriptor = {
      kind: "p/whisper",
      roles: ["player"],
      text: "optional",
      actor: true,
      source: "plugin",
      display: { label: { en: "Whisper", zh: "耳语" } },
    };
    expect(
      playerMessageLabel(
        [
          action({ actorId: "bo" }),
          action({ kind: "p/whisper", actorId: "bo" }),
        ],
        context({ catalogue: [whisper] }),
      ),
    ).toBe("Bo · say, Bo · Whisper");
  });

  it("shows the kind alone for a character the game state does not know", () => {
    expect(
      playerMessageLabel(
        [action({ kind: "act", actorId: "ghost" })],
        context({ characters: oneCharacter.concat(characters[1]!) }),
      ),
    ).toBe("act");
  });
});

describe("player message bubble", () => {
  afterEach(cleanup);

  const stateWith = (overrides: Partial<SessionState>): SessionState =>
    ({
      ...initialState,
      session: { id: "s", seats: twoSeats },
      gameState: { characters },
      ...overrides,
    }) as SessionState;

  function bubble(message: StreamMessage, state: SessionState | null) {
    return render(
      <SessionStateContext.Provider value={state}>
        <ChatMessageRenderer
          msg={message}
          viewMode="parsed"
          isImageGenActive={false}
          sessionId="s"
          executing={false}
          generatingImage={false}
          onGenerateImage={vi.fn()}
          t={t}
        />
      </SessionStateContext.Provider>,
    );
  }

  const user = (actions?: TurnAction[]): StreamMessage => ({
    id: "u1",
    role: "user",
    content: "hi",
    timestamp: "2026-01-01T00:00:00Z",
    ...(actions ? { actions } : {}),
  });

  it("keeps Player for the fast path and for old messages", async () => {
    await i18n.changeLanguage("en-US");
    bubble(
      user([action({ actorId: "aya" })]),
      stateWith({
        gameState: { characters: oneCharacter },
      }),
    );
    expect(screen.getByText("Player")).toBeDefined();
    cleanup();
    bubble(user(), stateWith({}));
    expect(screen.getByText("Player")).toBeDefined();
  });

  it("labels a second character's act with the actor and the kind", async () => {
    await i18n.changeLanguage("en-US");
    bubble(user([action({ kind: "act", actorId: "bo" })]), stateWith({}));
    expect(screen.getByText("Bo · Act")).toBeDefined();
  });

  it("shows the same label for a message restored from the snapshot", async () => {
    await i18n.changeLanguage("en-US");
    const [restored] = toStreamMessages([
      {
        id: "u1",
        role: "user",
        content: "hi",
        createdAt: "2026-01-01T00:00:00Z",
        actions: [action({ kind: "act", actorId: "bo" })],
      },
    ]);
    bubble(restored!, stateWith({}));
    expect(screen.getByText("Bo · Act")).toBeDefined();
  });

  it("falls back to Player outside a session", async () => {
    await i18n.changeLanguage("en-US");
    bubble(user([action({ actorId: "bo" })]), null);
    expect(screen.getByText("Player")).toBeDefined();
  });
});
