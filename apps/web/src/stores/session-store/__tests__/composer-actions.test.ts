import { describe, expect, it } from "vitest";
import type { Seat } from "@covel/shared";
import {
  composerActions,
  echoContent,
  echoedActions,
  stoppedSubmissionOf,
  textActions,
  type ComposerSubmission,
} from "../composer-actions.js";

const seats: Seat[] = [
  {
    id: "main",
    controller: "human",
    role: "player",
    characters: "auto",
    currentCharacterId: "bo",
  },
];
const characters = [
  { id: "aya", type: "player" },
  { id: "bo", type: "player" },
];

describe("textActions", () => {
  it("is the request a plain line always was", () => {
    expect(textActions("Look")).toEqual([{ kind: "say", text: "Look" }]);
    expect(textActions("/roll")).toEqual([{ kind: "command", text: "/roll" }]);
  });
});

describe("composerActions", () => {
  it("names the seat only when given", () => {
    expect(composerActions({ kind: "act", text: "x" })).toEqual([
      { kind: "act", text: "x" },
    ]);
    expect(composerActions({ kind: "advance", seatId: "gm" })).toEqual([
      { kind: "advance", seatId: "gm" },
    ]);
  });

  it("puts queued selections ahead as a say of the same seat", () => {
    expect(
      composerActions({ kind: "act", text: "x", seatId: "gm" }, "drafts"),
    ).toEqual([
      { kind: "say", text: "drafts", seatId: "gm" },
      { kind: "act", text: "x", seatId: "gm" },
    ]);
  });
});

describe("echoedActions", () => {
  it("resolves the primary seat and its current character", () => {
    expect(
      echoedActions([{ kind: "say", text: "x" }], { seats, characters }),
    ).toEqual([
      {
        kind: "say",
        text: "x",
        seatId: "main",
        actorId: "bo",
        source: "player",
      },
    ]);
  });

  it("gives a kind without an actor none", () => {
    expect(
      echoedActions([{ kind: "advance" }], { seats, characters })[0],
    ).not.toHaveProperty("actorId");
  });

  it("reads a plugin kind's actor flag from the catalogue", () => {
    const catalogue = [
      {
        kind: "p/x",
        roles: ["player"],
        text: "optional",
        actor: false,
        source: "plugin",
        display: { label: "X" },
      },
    ] as const;
    expect(
      echoedActions([{ kind: "p/x" }], {
        seats,
        characters,
        catalogue: [...catalogue],
      })[0],
    ).not.toHaveProperty("actorId");
  });
});

describe("echoContent", () => {
  it("joins the texts one per line", () => {
    expect(
      echoContent([
        { kind: "say", text: "a" },
        { kind: "act", text: "b" },
      ]),
    ).toBe("a\nb");
  });
  it("shows a plugin kind's fields when it has no text", () => {
    expect(
      echoContent([{ kind: "p/x", fields: { target: "Bo", loud: true } }]),
    ).toBe("target: Bo, loud: true");
  });
  it("is empty for an advance", () => {
    expect(echoContent([{ kind: "advance" }])).toBe("");
  });
});

describe("stoppedSubmissionOf", () => {
  const catalogue = [
    {
      kind: "act",
      roles: ["player"],
      text: "required",
      actor: true,
      source: "framework",
      display: { label: "act" },
    },
  ] as const;

  // What the composer holds again must send the same request.
  it.each<[string, ComposerSubmission, string | undefined]>([
    ["a say", { kind: "say", text: "Look around" }, undefined],
    ["an act", { kind: "act", text: "Draw sword" }, undefined],
    ["an act after queued selections", { kind: "act", text: "Draw" }, "Wait"],
    [
      "a fields-only action after queued selections",
      { kind: "p/whisper", fields: { target: "Bo", volume: 3 } },
      "Wait\nListen",
    ],
  ])("sends %s again unchanged", (_name, submission, drafts) => {
    const requests = composerActions(submission, drafts);
    const echoed = echoedActions(requests, { seats, characters, catalogue });
    const stopped = stoppedSubmissionOf(echoed);
    const again = composerActions(
      {
        kind: stopped.kind ?? "say",
        ...(stopped.text ? { text: stopped.text } : {}),
        ...(stopped.fields ? { fields: stopped.fields } : {}),
      },
      stopped.drafts,
    );
    expect(again).toEqual(requests);
  });

  it("keeps a queued say and an act apart, and a fields summary out of the text", () => {
    const requests = composerActions({ kind: "act", text: "Draw" }, "Wait");
    expect(stoppedSubmissionOf(requests)).toEqual({
      text: "Draw",
      kind: "act",
      drafts: "Wait",
    });
    expect(
      stoppedSubmissionOf([{ kind: "p/whisper", fields: { target: "Bo" } }]),
    ).toEqual({ text: "", kind: "p/whisper", fields: { target: "Bo" } });
  });

  it("restores a joined say as one line, and a command without a mode", () => {
    expect(stoppedSubmissionOf([{ kind: "say", text: "Wait\nLook" }])).toEqual({
      text: "Wait\nLook",
      kind: "say",
    });
    expect(stoppedSubmissionOf([{ kind: "command", text: "/roll" }])).toEqual({
      text: "/roll",
    });
  });
});
