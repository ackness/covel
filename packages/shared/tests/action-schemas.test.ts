// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BASE_ACTION_KINDS,
  BASE_ACTION_KIND_RULES,
  MAX_ACTIONS_PER_SUBMISSION,
  MAX_PLAYER_MESSAGE_CHARS,
  ROLE_ACTION_KINDS,
  actionKindDeclarationSchema,
  actionRequestSchema,
  baseActionKindRoles,
  interactionActionKind,
  isBaseActionKind,
  pluginActionKindId,
  turnActionSchema,
  validateActionRequest,
} from "../src/index.js";

const request = (payload: unknown) => ({
  requestId: "req-1",
  sessionId: "session-1",
  type: "submit_actions",
  payload,
});

describe("action kinds", () => {
  it("keeps the role table of the seats design", () => {
    expect(BASE_ACTION_KINDS).toEqual([
      "say",
      "act",
      "narrate",
      "direct",
      "advance",
      "command",
    ]);
    expect(ROLE_ACTION_KINDS).toEqual({
      player: ["say", "act", "command"],
      host: ["narrate", "direct", "advance", "command"],
      spectator: ["advance"],
    });
    expect(Object.isFrozen(ROLE_ACTION_KINDS)).toBe(true);
    expect(Object.isFrozen(ROLE_ACTION_KINDS.player)).toBe(true);
    expect(baseActionKindRoles("command")).toEqual(["player", "host"]);
    expect(baseActionKindRoles("advance")).toEqual(["host", "spectator"]);
  });

  it("takes text and an actor by the base-kind rules", () => {
    expect(BASE_ACTION_KIND_RULES).toEqual({
      say: { text: "required", actor: true },
      act: { text: "required", actor: true },
      narrate: { text: "required", actor: false },
      direct: { text: "required", actor: false },
      advance: { text: "none", actor: false },
      command: { text: "required", actor: false },
    });
  });

  it("namespaces plugin kinds and maps interaction answers to base kinds", () => {
    expect(pluginActionKindId("whisper-pack", "whisper")).toBe(
      "whisper-pack/whisper",
    );
    expect(isBaseActionKind("say")).toBe(true);
    expect(isBaseActionKind("whisper-pack/whisper")).toBe(false);
    expect(interactionActionKind("choice")).toBe("say");
    expect(interactionActionKind("form")).toBe("act");
    expect(interactionActionKind("confirmation")).toBe("act");
  });
});

describe("submit_actions request", () => {
  it("accepts actions that leave the seat and actor to the server", () => {
    const parsed = validateActionRequest(
      request({
        actions: [{ kind: "say", text: "Hello" }],
        inputMessageId: "input-1",
      }),
    );
    expect(parsed).toEqual({
      ok: true,
      value: request({
        actions: [{ kind: "say", text: "Hello" }],
        inputMessageId: "input-1",
      }),
    });
  });

  it("refuses a client-set source and unknown action fields", () => {
    expect(
      actionRequestSchema.safeParse(
        request({ actions: [{ kind: "say", text: "Hi", source: "system" }] }),
      ).success,
    ).toBe(false);
    expect(
      actionRequestSchema.safeParse(
        request({ actions: [{ kind: "say", text: "Hi", extra: true }] }),
      ).success,
    ).toBe(false);
  });

  it("holds a submission to 1-8 actions and the text limit in total", () => {
    expect(
      actionRequestSchema.safeParse(request({ actions: [] })).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_ACTIONS_PER_SUBMISSION + 1 }, () => ({
      kind: "say",
      text: "x",
    }));
    expect(
      actionRequestSchema.safeParse(request({ actions: many })).success,
    ).toBe(false);
    const half = "x".repeat(MAX_PLAYER_MESSAGE_CHARS / 2 + 1);
    expect(
      actionRequestSchema.safeParse(
        request({
          actions: [
            { kind: "say", text: half },
            { kind: "act", text: half },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it("carries an interaction answer as an action with fields", () => {
    expect(
      actionRequestSchema.safeParse(
        request({
          actions: [
            {
              kind: "act",
              interaction: { turnId: "t1", interactionId: "f1", type: "form" },
              fields: { name: "Aya", strength: 3 },
            },
          ],
        }),
      ).success,
    ).toBe(true);
  });

  it.each(["send_message", "execute_command", "submit_interaction"])(
    "no longer accepts %s",
    (type) => {
      const result = validateActionRequest({
        requestId: "req-1",
        sessionId: "session-1",
        type,
        payload: { content: "hello" },
      });
      expect(result).toEqual({
        ok: false,
        error: `Unsupported action type: ${type}`,
      });
    },
  );

  it("resolves an action with its seat and source set", () => {
    expect(
      turnActionSchema.safeParse({ kind: "say", text: "Hi" }).success,
    ).toBe(false);
    expect(
      turnActionSchema.safeParse({
        seatId: "main",
        kind: "say",
        text: "Hi",
        source: "player",
      }).success,
    ).toBe(true);
  });
});

describe("contributes.actionKinds item", () => {
  it("accepts a declaration with its display", () => {
    expect(
      actionKindDeclarationSchema.parse({
        name: "whisper",
        roles: ["player"],
        schema: "./schemas/whisper.schema.json",
        display: { label: { en: "Whisper", zh: "耳语" }, icon: "ear" },
      }),
    ).toMatchObject({ name: "whisper" });
  });

  it("refuses a name that is not kebab-case, empty roles and a missing label", () => {
    const display = { label: "Whisper" };
    expect(
      actionKindDeclarationSchema.safeParse({ name: "Whisper", display })
        .success,
    ).toBe(false);
    expect(
      actionKindDeclarationSchema.safeParse({
        name: "whisper",
        roles: [],
        display,
      }).success,
    ).toBe(false);
    expect(
      actionKindDeclarationSchema.safeParse({ name: "whisper", display: {} })
        .success,
    ).toBe(false);
  });
});
