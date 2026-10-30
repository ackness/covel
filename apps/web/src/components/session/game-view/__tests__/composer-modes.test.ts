import { describe, expect, it } from "vitest";
import {
  composerFieldsOf,
  type ActionKindDescriptor,
  type Seat,
  type SessionActionKindsResponse,
} from "@covel/shared";
import {
  characterSwitcherOf,
  deriveComposerModes,
  modeAcceptsInput,
  type ComposerMode,
} from "../composer-modes.js";

const baseLabel = (kind: string) => `base:${kind}`;
const base = (
  kind: string,
  roles: ActionKindDescriptor["roles"],
  text: ActionKindDescriptor["text"],
  actor: boolean,
): ActionKindDescriptor => ({
  kind,
  roles,
  text,
  actor,
  source: "framework",
  display: { label: kind },
});

const BASE_KINDS: ActionKindDescriptor[] = [
  base("say", ["player"], "required", true),
  base("act", ["player"], "required", true),
  base("narrate", ["host"], "required", false),
  base("direct", ["host"], "required", false),
  base("advance", ["host", "spectator"], "none", false),
  base("command", ["player", "host"], "required", false),
];

const whisper: ActionKindDescriptor = {
  kind: "whisper-pack/whisper",
  roles: ["player"],
  text: "optional",
  actor: true,
  source: "plugin",
  pluginId: "whisper-pack",
  display: {
    label: { en: "Whisper", zh: "耳语" },
    icon: "ear",
    placeholder: { en: "Whisper to someone", zh: "对某人耳语" },
  },
  fieldsSchema: {
    type: "object",
    properties: { target: { type: "string", title: "Target" } },
    required: ["target"],
  },
};

const nested: ActionKindDescriptor = {
  kind: "whisper-pack/nested",
  roles: ["player"],
  text: "optional",
  actor: true,
  source: "plugin",
  pluginId: "whisper-pack",
  display: { label: "Nested" },
  fieldsSchema: {
    type: "object",
    properties: { inner: { type: "object", properties: {} } },
  },
};

const player: Seat = {
  id: "main",
  controller: "human",
  role: "player",
  characters: "auto",
};
const host: Seat = {
  id: "gm",
  controller: "human",
  role: "host",
  characters: [],
};

function catalogue(
  kinds: ActionKindDescriptor[],
  seats: SessionActionKindsResponse["seats"],
): SessionActionKindsResponse {
  return { kinds, seats };
}

function modes(
  response: SessionActionKindsResponse | null,
  seats: Seat[],
): ComposerMode[] {
  return deriveComposerModes({
    catalogue: response,
    seats,
    language: "en-US",
    baseLabel,
  });
}

describe("deriveComposerModes", () => {
  it("offers say only until the catalogue is read", () => {
    expect(modes(null, [player]).map((mode) => mode.kind)).toEqual(["say"]);
  });

  it("offers say and act to a player seat and never command", () => {
    const response = catalogue(BASE_KINDS, [
      {
        seatId: "main",
        role: "player",
        controller: "human",
        allowed: ["say", "act", "command"],
      },
    ]);
    expect(modes(response, [player]).map((mode) => mode.kind)).toEqual([
      "say",
      "act",
    ]);
  });

  it("offers a host seat narrate, direct and advance", () => {
    const response = catalogue(BASE_KINDS, [
      {
        seatId: "gm",
        role: "host",
        controller: "human",
        allowed: ["narrate", "direct", "advance", "command"],
      },
    ]);
    const result = modes(response, [host]);
    expect(result.map((mode) => mode.kind)).toEqual([
      "narrate",
      "direct",
      "advance",
    ]);
    expect(result.find((mode) => mode.kind === "advance")?.text).toBe("none");
  });

  it("puts plugin kinds after the base kinds with their label, icon and placeholder", () => {
    const response = catalogue(
      [...BASE_KINDS, whisper],
      [
        {
          seatId: "main",
          role: "player",
          controller: "human",
          allowed: ["say", "act", "command", "whisper-pack/whisper"],
        },
      ],
    );
    const result = modes(response, [player]);
    expect(result.map((mode) => mode.kind)).toEqual([
      "say",
      "act",
      "whisper-pack/whisper",
    ]);
    expect(result[0]?.label).toBe("base:say");
    expect(result[2]).toMatchObject({
      label: "Whisper",
      icon: "ear",
      placeholder: "Whisper to someone",
      actor: true,
    });
    expect(result[2]?.fields.map((field) => field.name)).toEqual(["target"]);
  });

  it("hides a kind whose fields schema the composer cannot draw", () => {
    const response = catalogue(
      [...BASE_KINDS, whisper, nested],
      [
        {
          seatId: "main",
          role: "player",
          controller: "human",
          allowed: [
            "say",
            "act",
            "whisper-pack/nested",
            "whisper-pack/whisper",
          ],
        },
      ],
    );
    expect(modes(response, [player]).map((mode) => mode.kind)).toEqual([
      "say",
      "act",
      "whisper-pack/whisper",
    ]);
  });

  it("falls back to say when the seat may submit nothing", () => {
    const response = catalogue(BASE_KINDS, [
      { seatId: "main", role: "player", controller: "empty", allowed: [] },
    ]);
    expect(modes(response, [player]).map((mode) => mode.kind)).toEqual(["say"]);
  });
});

describe("modeAcceptsInput", () => {
  const mode = (
    text: ComposerMode["text"],
    fields: ComposerMode["fields"] = [],
  ): ComposerMode => ({
    kind: "x",
    label: "x",
    text,
    actor: true,
    fields,
  });
  it("needs text when it is required", () => {
    expect(modeAcceptsInput(mode("required"), " ")).toBe(false);
    expect(modeAcceptsInput(mode("required"), "go")).toBe(true);
  });
  it("accepts an empty submit for a kind without text", () => {
    expect(modeAcceptsInput(mode("none"), "")).toBe(true);
  });
  it("accepts an empty submit for optional text only when there are fields", () => {
    const fields = composerFieldsOf({
      type: "object",
      properties: { a: { type: "string" } },
    })!;
    expect(modeAcceptsInput(mode("optional"), "")).toBe(false);
    expect(modeAcceptsInput(mode("optional", fields), "")).toBe(true);
  });
});

describe("characterSwitcherOf", () => {
  const characters = [
    { id: "aya", type: "player", name: "Aya" },
    { id: "bo", type: "player", name: "Bo" },
    { id: "npc", type: "npc", name: "Guard" },
  ];
  it("lists the characters an auto seat binds", () => {
    expect(characterSwitcherOf([player], characters)).toEqual({
      seatId: "main",
      options: [
        { id: "aya", name: "Aya" },
        { id: "bo", name: "Bo" },
      ],
      currentId: "aya",
    });
  });
  it("follows the seat's current character", () => {
    const seat: Seat = { ...player, currentCharacterId: "bo" };
    expect(characterSwitcherOf([seat], characters)?.currentId).toBe("bo");
  });
  it("is absent for a seat with one character", () => {
    expect(characterSwitcherOf([player], characters.slice(0, 1))).toBeNull();
    expect(characterSwitcherOf([], characters)).toBeNull();
  });
});
