import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import {
  createDraftForwarder,
  type OutputDraftEvent,
} from "../src/output-draft/draft-forwarder.js";

const segmentsSchema = {
  type: "object",
  properties: { segments: { type: "array" } },
};

function manifest(overrides: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name: "teller/story",
    pluginId: "teller",
    version: "1.0.0",
    runtimeType: "agent",
    outputKind: "story",
    ...overrides,
  } as RuntimeManifest;
}

function setup(
  overrides: Partial<RuntimeManifest> = {},
  schema: Readonly<Record<string, unknown>> = segmentsSchema,
  hold?: "review" | "commit",
) {
  const events: OutputDraftEvent[] = [];
  const forwarder = createDraftForwarder({
    sink: (event) => events.push(event),
    manifest: manifest(overrides),
    schema,
    turnId: "turn-1",
    runId: "run",
    toolName: "submit-output",
    ...(hold ? { hold } : {}),
  });
  return { events, forwarder: forwarder! };
}

const summary = (events: readonly OutputDraftEvent[]) =>
  events.map((event) =>
    event.type === "output.draft"
      ? `draft ${event.payload.draftId} ${event.payload.units.map((unit) => unit.text).join("|")}${event.payload.partial ? ` +${event.payload.partial.text}` : ""}`
      : event.type === "output.retracted"
        ? `retracted ${event.payload.draftId} ${event.payload.reason}`
        : `accepted ${event.payload.draftId} ${event.payload.units.map((unit) => unit.text).join("|")}`,
  );

afterEach(() => vi.useRealTimers());

describe("createDraftForwarder", () => {
  it("is off without a sink and for output that never reaches players", () => {
    const base = {
      schema: segmentsSchema,
      turnId: "t",
      runId: "r",
      toolName: "submit-output",
    };
    expect(
      createDraftForwarder({ ...base, sink: undefined, manifest: manifest() }),
    ).toBeUndefined();
    for (const overrides of [
      { outputKind: "system" as const },
      { concealed: true },
      { output: { live: "off" as const } },
      { output: { from: { tool: "write" } } },
      { runtimeType: "function" as const },
    ])
      expect(
        createDraftForwarder({
          ...base,
          sink: () => {},
          manifest: manifest(overrides),
        }),
      ).toBeUndefined();
  });

  it("shows nothing while held and the accepted story once", () => {
    const { events, forwarder } = setup({}, segmentsSchema, "review");
    const first = forwarder.observe();
    first.fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"kind":"narration","text":"Rejected."}]}',
    });
    forwarder.revise();
    const second = forwarder.observe();
    second.fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"kind":"narration","text":"Kept."}]}',
    });
    forwarder.accept({ segments: [{ kind: "narration", text: "Kept." }] });
    expect(summary(events)).toEqual(["accepted run:2:accepted Kept."]);
  });

  it("shows nothing at all when the hold lasts until the commit", () => {
    const { events, forwarder } = setup({}, segmentsSchema, "commit");
    forwarder.observe().fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"kind":"narration","text":"Raw."}]}',
    });
    forwarder.accept({ segments: [{ kind: "narration", text: "Raw." }] });
    forwarder.stop();
    expect(events).toEqual([]);
  });

  it("shows each complete unit of the submission, then the accepted story", () => {
    const { events, forwarder } = setup();
    const observer = forwarder.observe();
    // A business call streaming in the same response is never shown.
    observer.fragment(0, {
      index: 1,
      name: "lookup",
      argumentsDelta: '{"segments":[{"text":"no"}]}',
    });
    observer.fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"kind":"narration","text":"One."},',
    });
    observer.fragment(0, {
      index: 0,
      argumentsDelta: '{"kind":"dialogue","speaker":"Aya","text":"Two',
    });
    observer.fragment(0, { index: 0, argumentsDelta: '."}]}' });
    forwarder.accept({
      segments: [
        { kind: "narration", text: "One." },
        { kind: "dialogue", speaker: "Aya", text: "Two." },
      ],
    });
    expect(summary(events)).toEqual([
      "draft run:1:0 One.",
      "draft run:1:0 One.|Two.",
      "accepted run:1:0 One.|Two.",
    ]);
    expect(events[1]).toMatchObject({
      payload: {
        turnId: "turn-1",
        runtimeId: "teller/story",
        pluginId: "teller",
        mode: "units",
        units: [
          { text: "One.", meta: { kind: "narration" } },
          { text: "Two.", meta: { kind: "dialogue", speaker: "Aya" } },
        ],
      },
    });
  });

  it("retracts a retried attempt and a rejected request before showing the next", () => {
    const { events, forwarder } = setup();
    const first = forwarder.observe();
    first.fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"text":"A."},',
    });
    first.reset(0);
    first.fragment(1, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"text":"B."},',
    });
    forwarder.revise();
    const second = forwarder.observe();
    second.fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"text":"C."}]}',
    });
    forwarder.stop();
    // Nothing shown, nothing to retract.
    forwarder.revise();
    expect(summary(events)).toEqual([
      "draft run:1:0 A.",
      "retracted run:1:0 revising",
      "draft run:1:1 B.",
      "retracted run:1:1 revising",
      "draft run:2:0 C.",
      "retracted run:2:0 stopped",
    ]);
  });

  it("clears a draft still marked as being revised when the runtime stops", () => {
    const { events, forwarder } = setup();
    forwarder.observe().fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"text":"A."},',
    });
    forwarder.revise();
    // The next attempt starts but shows nothing before the runtime stops.
    forwarder.observe().fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segm',
    });
    forwarder.revise();
    forwarder.stop();
    forwarder.stop();
    expect(summary(events)).toEqual([
      "draft run:1:0 A.",
      "retracted run:1:0 revising",
      "retracted run:1:0 stopped",
    ]);
  });

  it("retracts an accepted story that later fails", () => {
    const { events, forwarder } = setup({}, { type: "object" });
    forwarder.observe();
    forwarder.accept({ narrativeOutput: "Whole story." });
    forwarder.stop();
    expect(summary(events)).toEqual([
      "accepted run:1:accepted Whole story.",
      "retracted run:1:accepted stopped",
    ]);
  });

  it("paces the unit being written in text mode", () => {
    vi.useFakeTimers();
    const { events, forwarder } = setup({ output: { live: "text" } });
    const observer = forwarder.observe();
    observer.fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"text":"H',
    });
    observer.fragment(0, { index: 0, argumentsDelta: "e" });
    observer.fragment(0, { index: 0, argumentsDelta: "y" });
    expect(summary(events)).toEqual(["draft run:1:0  +H"]);
    vi.advanceTimersByTime(80);
    expect(summary(events)).toEqual([
      "draft run:1:0  +H",
      "draft run:1:0  +Hey",
    ]);
    // A completed unit goes out at once.
    observer.fragment(0, { index: 0, argumentsDelta: '"}' });
    expect(summary(events).at(-1)).toBe("draft run:1:0 Hey");
  });

  it("starts over from replaced arguments", () => {
    const { events, forwarder } = setup();
    const observer = forwarder.observe();
    observer.fragment(0, {
      index: 0,
      name: "submit-output",
      argumentsDelta: '{"segments":[{"text":"Old."},',
    });
    observer.fragment(0, {
      index: 0,
      arguments: '{"segments":[{"text":"New."}]}',
    });
    expect(summary(events)).toEqual([
      "draft run:1:0 Old.",
      "draft run:1:0 New.",
    ]);
  });
});
