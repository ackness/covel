import { describe, expect, it } from "vitest";
import type { RuntimeManifest, RuntimeResult, TurnInput } from "@covel/shared";
import {
  attachRuntimeJournal,
  collectExecutionTriggers,
  journalOf,
} from "../src/execution-journal.js";

const input: TurnInput = { sessionId: "s", turnId: "t", playerMessage: "go" };
const SECRET = "The steward is the poisoner.";
const manifest = (concealed: boolean): RuntimeManifest => ({
  pluginId: "plotter",
  name: "plotter/plan",
  description: "Plans hidden events",
  runtimeType: "agent",
  trigger: { type: "auto" },
  outputKind: "plugin",
  ...(concealed ? { concealed: true } : {}),
});
const run = (
  concealed: boolean,
  output: Record<string, unknown>,
  effects?: RuntimeResult["effects"],
) => {
  const result = {
    runtimeId: "plotter/plan",
    pluginId: "plotter",
    status: "success",
    output,
    ...(effects ? { effects } : {}),
  } as RuntimeResult;
  attachRuntimeJournal(result, input, manifest(concealed), output);
  return result;
};

describe("conversation journal of a concealed runtime", () => {
  it.each(["narrativeOutput", "content"])(
    "keeps %s text out of the conversation and still counts the run",
    (field) => {
      expect(journalOf(run(false, { [field]: SECRET }))[0]?.content).toBe(
        SECRET,
      );
      const concealed = run(true, { [field]: SECRET });
      expect(journalOf(concealed)).toEqual([]);
      expect(collectExecutionTriggers({ runtimeResults: [concealed] })).toEqual(
        ["plotter/plan"],
      );
    },
  );

  it("journals what the runtime shows on purpose, without its text", () => {
    const ui = [{ type: "notice", props: { text: "Something stirs." } }];
    const [message] = journalOf(
      run(true, { content: SECRET }, { ui } as RuntimeResult["effects"]),
    );
    expect(message).toMatchObject({ content: "", ui });
    expect(JSON.stringify(message)).not.toContain(SECRET);
  });
});
