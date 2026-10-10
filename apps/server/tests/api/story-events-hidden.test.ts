import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DIMENSION_DATA_NAMESPACE,
  dimensionRecordSchema,
  type LLMMessage,
} from "@covel/shared";
import type {
  LLMAdapter,
  LLMResponse,
  LLMToolDefinition,
} from "@covel/runtime";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import { closeTestApi } from "../helpers/close-api.js";

const SECRET = "SECRET-PAYLOAD-7f3";
const PLANNED_SECRET = "PLANNED-PAYLOAD-2c9";

/** Records every prompt so the test can prove where the hidden payload went. */
class RecordingLLM implements LLMAdapter {
  readonly calls: {
    readonly tools: readonly string[];
    readonly text: string;
  }[] = [];

  async generate(params: {
    readonly messages: readonly LLMMessage[];
    readonly tools?: readonly LLMToolDefinition[];
  }): Promise<LLMResponse> {
    const tools = (params.tools ?? []).map((tool) => tool.name);
    const text = params.messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content),
      )
      .join("\n");
    this.calls.push({ tools, text });
    const usage = { inputTokens: 10, outputTokens: 10 };
    if (/memory manager|记忆管理器/.test(text))
      return { content: "{}", toolCalls: [], finishReason: "stop", usage };
    if (tools.includes("advance-world-time"))
      return {
        content: null,
        toolCalls: [
          {
            id: `time-${this.calls.length}`,
            name: "advance-world-time",
            arguments: JSON.stringify({
              amount: 0,
              unit: "phase",
              reason: "Brief.",
            }),
          },
        ],
        finishReason: "tool_calls",
        usage,
      };
    if (tools.includes("plan-story-events"))
      return {
        content: null,
        toolCalls: [
          {
            id: `plan-${this.calls.length}`,
            name: "plan-story-events",
            arguments: JSON.stringify({
              events: [
                {
                  id: "keeper-returns",
                  title: "The Keeper Returns",
                  all: [{ dimension: "location", equals: "lighthouse" }],
                  payload: `${PLANNED_SECRET} The keeper's lamp is lit again.`,
                  priority: 5,
                },
              ],
              reason: "The keeper was mentioned and never found.",
            }),
          },
        ],
        finishReason: "tool_calls",
        usage,
      };
    if (tools.includes("sync-characters"))
      return {
        content: null,
        toolCalls: [
          {
            id: `tracker-${this.calls.length}`,
            name: "runtime-done",
            arguments: JSON.stringify({ reason: "no changes" }),
          },
        ],
        finishReason: "tool_calls",
        usage,
      };
    return {
      content: "The fog rolls over the pier while you wait.",
      toolCalls: [],
      finishReason: "stop",
      usage,
    };
  }
}

async function makeWorld(): Promise<{ worldsDir: string; worldDir: string }> {
  const worldsDir = await mkdtemp(path.join(tmpdir(), "covel-hidden-worlds-"));
  const worldDir = path.join(worldsDir, "hidden-demo");
  await mkdir(path.join(worldDir, "data/hidden"), { recursive: true });
  await writeFile(
    path.join(worldDir, "world.yaml"),
    `schemaVersion: "1.0"
id: hidden-demo
name: Hidden Demo
summary: A harbor with a secret.
defaultLocale: en-US
supportedLocales:
  - en-US
dimensions:
  location:
    name: Location
    schema: { type: string, enum: [harbor, lighthouse] }
    initialValue: harbor
worldData: data/world.data.yaml
`,
  );
  await writeFile(
    path.join(worldDir, "WORLD.md"),
    "# Hidden Demo\n\nA foggy harbor.\n",
  );
  await writeFile(
    path.join(worldDir, "data/world.data.yaml"),
    `schemaVersion: 1
sources:
  time:
    kind: yaml
    path: data/time.yaml
    schema: contract:world.time-definition@1
    to: contract:world.time-definition@1
    key: id
  events:
    kind: yaml
    path: data/hidden/events.yaml
    schema: contract:story.events@1
    to: contract:story.events@1
    key: id
    visibility: hidden
`,
  );
  await writeFile(
    path.join(worldDir, "data/time.yaml"),
    `id: world
definition:
  kind: phases
  name: Watches
  cycleLabel: Day
  phases: [Dawn, Day, Dusk, Night]
  initial: { cycle: 1, phase: 3 }
  evolution:
    mode: forward
    defaultStep: 1
    maxStep: 4
    prompt: Count watches.
`,
  );
  await writeFile(
    path.join(worldDir, "data/hidden/events.yaml"),
    `- id: lighthouse-charge
  title: The Lighthouse Charge
  when:
    all:
      - time: phase
        equals: 3
      - dimension: location
        equals: lighthouse
  payload: ${SECRET} The old keeper hands you a sleeping child.
`,
  );
  return { worldsDir, worldDir };
}

describe("hidden world data and story events", () => {
  let boot: Awaited<ReturnType<typeof bootstrapApi>>;
  const llm = new RecordingLLM();
  const sessionId = "hidden-demo-session";
  let requestIndex = 0;

  beforeAll(async () => {
    const { worldsDir, worldDir } = await makeWorld();
    boot = await bootstrapApi({
      pluginsDir: path.resolve(import.meta.dirname, "../../../../plugins"),
      worldsDirs: [worldsDir],
      llmAdapter: llm,
      canRunRuntimeJobWithServerServices: () => true,
      pluginGateway: {
        async generateText(input) {
          const result = await llm.generate({
            messages: [
              { role: "system", content: input.system ?? "" },
              { role: "user", content: input.prompt ?? "" },
            ],
          });
          return {
            text: result.content ?? "",
            finishReason: "stop",
            usage: result.usage,
          };
        },
      } as import("@covel/shared/plugin-runtime").PluginRuntimeGateway,
      store: createMemoryStore(),
      storeBackend: "memory",
    });
    await boot.store.upsertWorld((await loadSingleWorld(worldDir))!);
  });

  afterAll(async () => {
    await closeTestApi(boot);
  });

  async function createPlayingSession(
    id: string,
    plugins: readonly string[],
  ): Promise<readonly string[]> {
    const created = await boot.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        worldId: "hidden-demo",
        locale: "en-US",
        plugins,
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const activePlugins = (await created.json()).activePlugins as string[];

    const now = new Date().toISOString();
    await boot.store.upsertCharacter({
      id: `player-${id}`,
      sessionId: id,
      name: "Ren",
      type: "player",
      description: "A courier.",
      fields: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await boot.store.updateSession(id, {
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: Object.fromEntries(
        boot.registry
          .getActiveRuntimes(id)
          .filter((runtime) => runtime.stage === "setup")
          .map((runtime) => [
            runtime.name,
            {
              state: "done" as const,
              resolution: "completed" as const,
              generation: 1,
              attempts: 1,
              completedAt: now,
              pluginVersion: runtime.version ?? "0.0.0",
            },
          ]),
      ),
      updatedAt: now,
    });
    return activePlugins;
  }

  async function sendTurn(
    id: string,
    content: string,
    settings?: Record<string, Record<string, unknown>>,
  ): Promise<void> {
    requestIndex += 1;
    const res = await boot.app.request("/api/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(settings
          ? {
              "X-Plugin-User-Settings": Buffer.from(
                JSON.stringify(settings),
              ).toString("base64"),
            }
          : {}),
      },
      body: JSON.stringify({
        requestId: `hidden-${requestIndex}`,
        type: "send_message",
        sessionId: id,
        payload: { content },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
  }

  /** Move to the lighthouse as the dimension tracker would. */
  async function moveToLighthouse(id: string): Promise<void> {
    const row = await boot.store.getPluginData(
      id,
      "world-init",
      DIMENSION_DATA_NAMESPACE,
      "location",
    );
    const record = dimensionRecordSchema.parse(row!.value);
    await boot.store.setPluginData({
      ...row!,
      value: { ...record, value: "lighthouse", version: record.version + 1 },
      updatedAt: new Date().toISOString(),
    });
  }

  async function publicSurfaces(
    id: string,
    routes = [
      `/api/sessions/${id}/plugin-data/story-events`,
      `/api/sessions/${id}/state`,
      `/api/sessions/${id}/view`,
    ],
  ): Promise<string> {
    const bodies: string[] = [];
    for (const route of routes)
      bodies.push(await (await boot.app.request(route)).text());
    return bodies.join("\n");
  }

  it("keeps the payload out of prompts and public APIs until its turn, then gives it only to narration", async () => {
    expect(
      await createPlayingSession(sessionId, ["narrator", "story-events"]),
    ).toEqual(expect.arrayContaining(["story-events", "world-time"]));

    // Imported into the hidden bucket, invisible to every public surface.
    expect(
      (
        await boot.store.listPluginData(
          sessionId,
          "story-events",
          "_hidden.events",
        )
      ).map((row) => row.key),
    ).toEqual(["lighthouse-charge"]);
    expect(await publicSurfaces(sessionId)).not.toContain(SECRET);
    expect(
      (
        await boot.app.request(
          `/api/sessions/${sessionId}/plugin-data/story-events/_hidden.events/lighthouse-charge`,
        )
      ).status,
    ).toBe(404);

    // Turn 1: still at the harbor, so nothing is revealed anywhere.
    await sendTurn(sessionId, "I wait on the pier.");
    expect(llm.calls.some((call) => call.text.includes(SECRET))).toBe(false);
    expect(
      await boot.store.listPluginData(sessionId, "story-events", "revealed"),
    ).toEqual([]);

    await moveToLighthouse(sessionId);

    // Turn 2: the condition holds, so narration (and only narration) gets it.
    const before = llm.calls.length;
    await sendTurn(sessionId, "I climb to the lighthouse.");
    const turnCalls = llm.calls.slice(before);
    const withSecret = turnCalls.filter((call) => call.text.includes(SECRET));
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0]!.tools).not.toContain("advance-world-time");
    expect(withSecret[0]!.tools).not.toContain("sync-characters");
    // The planner is off unless the world or player turns it on.
    expect(
      llm.calls.some((call) => call.tools.includes("plan-story-events")),
    ).toBe(false);

    const revealed = await boot.store.listPluginData(
      sessionId,
      "story-events",
      "revealed",
    );
    expect(revealed.map((item) => item.key)).toEqual(["lighthouse-charge"]);
    expect(JSON.stringify(revealed)).not.toContain(SECRET);
    // After the reveal the brief is part of this turn's narration input (and
    // so its execution detail), but stored plugin data stays payload-free.
    expect(
      await publicSurfaces(sessionId, [
        `/api/sessions/${sessionId}/plugin-data/story-events`,
        `/api/sessions/${sessionId}/state`,
      ]),
    ).not.toContain(SECRET);

    // A snapshot keeps the hidden bucket (fork needs it); reading it back does not.
    const created = await boot.app.request(
      `/api/sessions/${sessionId}/snapshots`,
      { method: "POST" },
    );
    const createdText = await created.text();
    expect(createdText).not.toContain(SECRET);
    const { id: snapshotId } = JSON.parse(createdText) as { id: string };
    const stored = await boot.store.getSnapshot(snapshotId);
    expect(JSON.stringify(stored?.payload.pluginData)).toContain(SECRET);
    expect(
      await publicSurfaces(sessionId, [
        `/api/sessions/${sessionId}/snapshots/${snapshotId}`,
      ]),
    ).not.toContain(SECRET);
  }, 30_000);

  it("stores events planned during play as hidden data and reveals them later", async () => {
    const id = "hidden-demo-planned";
    expect(
      await createPlayingSession(id, ["narrator", "story-events"]),
    ).toEqual(expect.arrayContaining(["story-events"]));
    const planner = { "story-events": { planner: true } };

    const plannedRows = () =>
      boot.store.listPluginData(id, "story-events", "_hidden.planned");
    // The planner runs every few turns; stay at the harbor until it has.
    for (let turn = 1; turn <= 4 && !(await plannedRows()).length; turn += 1)
      await sendTurn(
        id,
        "I ask the dockhands about the missing keeper.",
        planner,
      );
    const planned = await plannedRows();
    // The planner knows the world it is planning for.
    const plannerPrompt = llm.calls.find((call) =>
      call.tools.includes("plan-story-events"),
    )!.text;
    expect(plannerPrompt).toContain("Hidden Demo");
    expect(plannerPrompt).toContain("A harbor with a secret.");
    expect(plannerPrompt).toContain("Ren");
    expect(planned.map((row) => row.key)).toEqual(["keeper-returns"]);
    expect(planned[0]!.value).toMatchObject({
      once: true,
      origin: { pluginId: "story-events", runtimeId: "story-events/plot" },
    });

    // Only the planner itself has handled the planned payload so far.
    const narrationCalls = (calls: typeof llm.calls) =>
      calls.filter((call) => !call.tools.includes("plan-story-events"));
    expect(
      narrationCalls(llm.calls).some((call) =>
        call.text.includes(PLANNED_SECRET),
      ),
    ).toBe(false);
    // The planner's own prompts, tool calls, and output are concealed from
    // traces, the session view, and execution history.
    expect(
      await publicSurfaces(id, [
        `/api/sessions/${id}/plugin-data/story-events`,
        `/api/sessions/${id}/state`,
        `/api/sessions/${id}/view`,
        `/api/sessions/${id}/turns`,
        `/api/traces/${id}`,
      ]),
    ).not.toContain(PLANNED_SECRET);

    await moveToLighthouse(id);
    const before = llm.calls.length;
    await sendTurn(id, "I climb to the lighthouse.");
    const withSecret = narrationCalls(llm.calls.slice(before)).filter((call) =>
      call.text.includes(PLANNED_SECRET),
    );
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0]!.tools).not.toContain("advance-world-time");
    expect(
      (await boot.store.listPluginData(id, "story-events", "revealed")).map(
        (row) => row.key,
      ),
    ).toEqual(["keeper-returns"]);
  }, 60_000);
});
