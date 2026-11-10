/**
 * Commit (and the auto-advance decision it returns), inline presentation and
 * deferred presentation agree on the story that speaks for a turn: the
 * automatic story runtime's when it told one, and never a nested call's.
 */
import { describe, expect, it } from "vitest";
import type { DeferredRuntimeJob, RuntimeManifest } from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { executeTurn } from "../src/execution.js";
import { finalizePresentationJobs } from "../src/presentation/jobs.js";
import { publicStoryCandidate } from "../src/presentation/projection.js";
import {
  input,
  narrator,
  presenter,
  setup,
  story,
} from "./presentation-fixture.js";

const aside = {
  segments: [{ kind: "narration", text: "Meanwhile, elsewhere." }],
} as const;
// A recursive call stays inside its package, so a called story shares the
// caller's plugin ID.
const asideStory = (
  trigger: RuntimeManifest["trigger"],
  pluginId = "aside",
): RuntimeManifest => ({
  name: pluginId === "aside" ? "aside" : `${pluginId}/aside`,
  pluginId,
  description: "Another story",
  runtimeType: "function",
  handler: "./handler.js",
  outputKind: "story",
  trigger,
});
const later = presenter({ turnCompletion: { mode: "detached" } });

async function runAndCommit(
  runtimes: readonly RuntimeManifest[],
  handlers: Record<string, FunctionHandler>,
) {
  const f = await setup();
  const execution = await executeTurn(input, runtimes, f.deps(handlers));
  const inline = publicStoryCandidate(
    runtimes,
    execution.result.runtimeResults,
  );
  let jobs: readonly DeferredRuntimeJob[] = [];
  const outcome = await f.commit(execution, {
    extraInTx: async (tx) => {
      jobs = await finalizePresentationJobs(
        tx,
        "session",
        execution.result.deferredRuntimeJobs ?? [],
        runtimes,
        true,
      );
    },
  });
  expect(outcome.status).toBe("committed");
  const turnStories = await Promise.all(
    (outcome.turnStoryMessageIds ?? []).map((id) =>
      f.store.getMessage("session", id),
    ),
  );
  const told = (await f.store.listMessages("session")).filter(
    (message) =>
      (message.metadata as { kind?: string } | undefined)?.kind === "story",
  );
  await f.store.close();
  return {
    execution,
    inline,
    deferred: jobs[0]?.presentation?.story,
    turnStories: turnStories.map(
      (message) =>
        (message?.metadata as { runtimeId?: string } | undefined)?.runtimeId,
    ),
    told: told.map(
      (message) => (message.metadata as { runtimeId?: string }).runtimeId,
    ),
  };
}

describe("the story that speaks for a turn", () => {
  it("keeps the automatic story when an event story runs in the same execution", async () => {
    const runtimes = [
      narrator,
      asideStory({ type: "event", topic: "aside.cue" }),
      later,
    ];
    const run = await runAndCommit(runtimes, {
      story: async () => ({
        outcome: "success",
        value: story,
        effects: { events: [{ topic: "aside.cue", data: {} }] },
      }),
      aside: async () => ({ outcome: "success", value: aside }),
    });
    expect(run.told.sort()).toEqual(["aside", "story"]);
    expect(run.inline).toEqual(story);
    expect(run.deferred).toEqual(story);
    // Auto-advance follows the one story the commit returns.
    expect(run.turnStories).toEqual(["story"]);
  });

  it("keeps the automatic story when it calls a manual story", async () => {
    const runtimes = [narrator, asideStory({ type: "manual" }, "story"), later];
    const run = await runAndCommit(runtimes, {
      story: async (ctx) => {
        await ctx.recursiveCall!({
          manualTrigger: { runtimeId: "story/aside" },
        });
        return { outcome: "success", value: story };
      },
      "story/aside": async () => ({ outcome: "success", value: aside }),
    });
    expect(run.told.sort()).toEqual(["story", "story/aside"]);
    expect(run.inline).toEqual(story);
    expect(run.deferred).toEqual(story);
    expect(run.turnStories).toEqual(["story"]);
  });

  it("gives the turn no story when only a nested call told one", async () => {
    const director: RuntimeManifest = {
      name: "director",
      pluginId: "director",
      description: "Calls a story",
      runtimeType: "function",
      handler: "./handler.js",
      stage: "narrative",
      outputKind: "system",
    };
    const runtimes = [
      director,
      asideStory({ type: "manual" }, "director"),
      later,
    ];
    const run = await runAndCommit(runtimes, {
      director: async (ctx) => {
        await ctx.recursiveCall!({
          manualTrigger: { runtimeId: "director/aside" },
        });
        return { outcome: "success", value: {} };
      },
      "director/aside": async () => ({ outcome: "success", value: aside }),
    });
    expect(run.told).toEqual(["director/aside"]);
    expect(run.inline).toBeUndefined();
    expect(run.deferred).toBeUndefined();
    expect(run.turnStories).toEqual([]);
  });
});
