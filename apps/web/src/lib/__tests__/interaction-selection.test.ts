import { describe, expect, it } from "vitest";
import {
  matchesPendingDraft,
  resolveActionParams,
} from "../interaction-selection.js";

describe("resolveActionParams", () => {
  it("resolves nested state refs for plugin runtime payloads", () => {
    const result = resolveActionParams(
      {
        runtimeId: "character-blueprint",
        payload: {
          blueprintJson: { $bindState: "/draftJson" },
          instantiate: { $bindState: "/instantiate" },
          tags: [{ $state: "/tag" }],
        },
      },
      (path) => {
        const values: Record<string, unknown> = {
          "/draftJson": '{"schemaVersion":1}',
          "/instantiate": true,
          "/tag": "npc",
        };
        return values[path];
      },
    );

    expect(result).toEqual({
      runtimeId: "character-blueprint",
      payload: {
        blueprintJson: '{"schemaVersion":1}',
        instantiate: true,
        tags: ["npc"],
      },
    });
  });
});

describe("matchesPendingDraft", () => {
  it("matches branch reply candidates by candidateId", () => {
    expect(
      matchesPendingDraft({ candidateId: "candidate-2" }, [
        {
          label: "Take the second branch.",
          values: {
            text: "Take the second branch.",
            candidateId: "candidate-2",
          },
        },
      ]),
    ).toBe(true);
  });

  it("matches branch reply drafts by text", () => {
    expect(
      matchesPendingDraft({ text: "Open with a softer reply." }, [
        {
          label: "Open with a softer reply.",
          values: { text: "Open with a softer reply." },
        },
      ]),
    ).toBe(true);
  });
});
