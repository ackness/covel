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
} from "@covel/ai-provider";
import { createMemoryStore } from "@covel/store/memory";
import { bootstrapApi } from "../../src/routes/api/bootstrap.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import { closeTestApi } from "../helpers/close-api.js";

const SECRET = "SECRET-PAYLOAD-7f3";

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

  async function sendTurn(content: string, index: number): Promise<void> {
    const res = await boot.app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: `hidden-${index}`,
        type: "send_message",
        sessionId,
        locale: "en-US",
        payload: { content },
      }),
    });
    expect(res.status).toBe(200);
    await res.text();
  }

  async function publicSurfaces(
    routes = [
      `/api/sessions/${sessionId}/plugin-data/story-events`,
      `/api/sessions/${sessionId}/state`,
      `/api/sessions/${sessionId}/view`,
    ],
  ): Promise<string> {
    const bodies: string[] = [];
    for (const route of routes)
      bodies.push(await (await boot.app.request(route)).text());
    return bodies.join("\n");
  }

  it("keeps the payload out of prompts and public APIs until its turn, then gives it only to narration", async () => {
    const created = await boot.app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: sessionId,
        worldId: "hidden-demo",
        locale: "en-US",
        plugins: ["narrator", "story-events"],
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await created.json()).activePlugins as readonly string[]).toEqual(
      expect.arrayContaining(["story-events", "world-time"]),
    );

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
    expect(await publicSurfaces()).not.toContain(SECRET);
    expect(
      (
        await boot.app.request(
          `/api/sessions/${sessionId}/plugin-data/story-events/_hidden.events/lighthouse-charge`,
        )
      ).status,
    ).toBe(404);

    const now = new Date().toISOString();
    await boot.store.upsertCharacter({
      id: "player-hidden-demo",
      sessionId,
      name: "Ren",
      type: "player",
      description: "A courier.",
      fields: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
    await boot.store.updateSession(sessionId, {
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: Object.fromEntries(
        boot.registry
          .getActiveRuntimes(sessionId)
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

    // Turn 1: still at the harbor, so nothing is revealed anywhere.
    await sendTurn("I wait on the pier.", 1);
    expect(llm.calls.some((call) => call.text.includes(SECRET))).toBe(false);
    expect(
      await boot.store.listPluginData(sessionId, "story-events", "revealed"),
    ).toEqual([]);

    // Move to the lighthouse as the dimension tracker would.
    const row = await boot.store.getPluginData(
      sessionId,
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

    // Turn 2: the condition holds, so narration (and only narration) gets it.
    const before = llm.calls.length;
    await sendTurn("I climb to the lighthouse.", 2);
    const turnCalls = llm.calls.slice(before);
    const withSecret = turnCalls.filter((call) => call.text.includes(SECRET));
    expect(withSecret).toHaveLength(1);
    expect(withSecret[0]!.tools).not.toContain("advance-world-time");
    expect(withSecret[0]!.tools).not.toContain("sync-characters");

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
      await publicSurfaces([
        `/api/sessions/${sessionId}/plugin-data/story-events`,
        `/api/sessions/${sessionId}/state`,
      ]),
    ).not.toContain(SECRET);
  }, 30_000);
});
