import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHookPipeline } from "../../../packages/runtime/src/index.js";
import {
  characterActorOutputSchema,
  type LLMAdapter,
  type LLMResponse,
  type Proposal,
} from "@covel/shared";
import { startStageRenderHost } from "../../../apps/server/tests/helpers/stage-render-browser.js";

export const sandboxThemeFixture = resolve(
  import.meta.dirname,
  "../../third-party/sandbox-surface-probe",
);
export const themeSecrets = [
  "hidden-theme-sentinel",
  "concealed-theme-sentinel",
  "delegate-intent-theme-sentinel",
  "delegate-brief-theme-sentinel",
  "private-reasoning-theme-sentinel",
] as const;
export const streamingThemeStory = "Public streaming theme story.";

/** Real delegate and write-service paths, scripted like the orchestration API fixtures. */
export async function startThemeOrchestrationHost() {
  const root = await mkdtemp(join(tmpdir(), "theme-orchestration-"));
  const plugin = join(root, "theme-story-probe");
  const provider = join(root, "theme-change-probe");
  await mkdir(provider);
  for (const id of ["story", "secret"])
    await mkdir(join(plugin, "runtimes", id), { recursive: true });
  await cp(
    resolve(
      import.meta.dirname,
      "../../../plugins/narrator/schemas/narrative-engine.schema.json",
    ),
    join(plugin, "narrative-engine.schema.json"),
  );
  await writeFile(
    join(plugin, "PLUGIN.md"),
    `---
description: Scripted story with private planning and a write operation
contracts:
  narrative-engine@2: { schema: ./narrative-engine.schema.json }
---
`,
  );
  await writeFile(
    join(provider, "PLUGIN.md"),
    `---
description: Scripted write-service provider
entry: ./entry.mjs
contributes:
  services: [{ contract: theme-change@1, access: write, modelFacing: true }]
---
`,
  );
  await writeFile(
    join(provider, "entry.mjs"),
    `export default function(api) {
  const z = api.toolkit.z;
  api.registerService({
    name: "change", contract: "theme-change@1", access: "write",
    modelFacing: true, description: "Record a change",
    input: z.object({ key: z.string() }), output: z.unknown(),
    handler: async ({ key }, ctx) => {
      await ctx.pluginData.set("values", key, true);
      return { key };
    }
  });
}
`,
  );
  await writeFile(
    join(plugin, "runtimes/story/RUNTIME.md"),
    `---
description: Public story with one private actor and one operation
schedule: { stage: narrative }
io: { visibility: story, output: { contract: narrative-engine@2, schema: "contract:narrative-engine@2" } }
agent:
  tools:
    builtin: [delegate]
    services: [{ contract: theme-change@1, as: change }]
---
Compose the public theme story.
`,
  );
  await writeFile(
    join(plugin, "runtimes/secret/RUNTIME.md"),
    `---
description: Private planning
schedule: { stage: pre-turn }
io: { concealed: true }
---
Private theme planning.
`,
  );
  const hooks = createHookPipeline();
  let rejectChange = true;
  hooks.register<{ proposal: Proposal }>({
    id: "reject-theme-change",
    pluginId: "theme-change-probe",
    event: "PreStateCommit",
    handler: async (_ctx, { proposal }) =>
      rejectChange &&
      "key" in proposal.payload &&
      proposal.payload.key === "change"
        ? { action: "abort", reason: "The change is refused." }
        : { action: "continue" },
  });
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const deltas = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const calls: string[] = [];
  let turn = 0;
  let step = 0;
  const prose = (content: string): LLMResponse => ({
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const generate: LLMAdapter["generate"] = async ({ messages }) => {
    const prompt = messages
      .filter((message) => message.role === "system")
      .map((message) => String(message.content))
      .join("\n");
    if (prompt.includes("Private theme planning.")) {
      calls.push("concealed");
      return prose(JSON.stringify({ text: themeSecrets[1] }));
    }
    if (prompt.includes("Play only the character assigned")) {
      calls.push("actor");
      return prose(
        JSON.stringify({
          segments: [{ kind: "dialogue", text: "A public actor reply." }],
          intent: themeSecrets[2],
        }),
      );
    }
    const actorReceipt = messages.find(
      (message) =>
        message.role === "tool" &&
        String(message.content).includes(themeSecrets[2]),
    );
    if (step > 0 && !actorReceipt)
      throw new Error("The parent must receive its actor's private intent");
    if (step++ < 2) {
      const delegate = step === 1;
      calls.push(delegate ? "delegate" : "change");
      return {
        ...prose(""),
        toolCalls: [
          {
            id: `${turn}-${step}`,
            name: delegate ? "delegate" : "change",
            arguments: JSON.stringify(
              delegate
                ? {
                    target: { contract: "character-actor@1" },
                    character: "Mira",
                    brief: themeSecrets[3],
                  }
                : { key: "change" },
            ),
          },
        ],
        finishReason: "tool_calls",
      };
    }
    calls.push("story");
    step = 0;
    turn++;
    if (!actorReceipt) throw new Error("Missing actor receipt");
    const envelope: { data?: unknown } = JSON.parse(
      String(actorReceipt.content),
    );
    const actor = characterActorOutputSchema.parse(envelope.data);
    return prose(
      JSON.stringify({
        segments: [
          { kind: "narration", text: streamingThemeStory },
          ...actor.segments.map((segment) => ({ ...segment, speaker: "Mira" })),
        ],
        cues: { scene: "Library", present: ["Mira"] },
        yield: "user",
      }),
    );
  };
  const llmAdapter: LLMAdapter = {
    generate,
    async *stream(request) {
      const response = await generate(request);
      yield { type: "reasoning-delta", reasoningDelta: themeSecrets[4] };
      for (const call of response.toolCalls)
        yield { type: "tool-call", ...call };
      if (response.content) {
        const start = response.content.indexOf(streamingThemeStory);
        const split = start + "Public streaming ".length;
        if (start >= 0) {
          yield {
            type: "text-delta",
            textDelta: response.content.slice(0, split),
          };
          await deltas[turn - 1]?.promise;
          request.signal?.throwIfAborted();
          yield {
            type: "text-delta",
            textDelta: response.content.slice(split),
          };
          await gates[turn - 1]?.promise;
          request.signal?.throwIfAborted();
        } else yield { type: "text-delta", textDelta: response.content };
      }
      yield {
        type: "done",
        finishReason: response.finishReason,
        usage: response.usage,
      };
    },
  };
  try {
    const host = await startStageRenderHost({
      plugins: ["character-agent"],
      fixturePlugins: [sandboxThemeFixture, plugin, provider],
      llmAdapter,
      perRequestMiddleware: [
        async (c, next) => {
          c.set("hookPipeline", hooks);
          await next();
        },
      ],
    });
    const disabled = await host.app.request(
      `/api/sessions/${host.sessionId}/plugins/story-probe`,
      { method: "DELETE" },
    );
    if (!disabled.ok) throw new Error(await disabled.text());
    return {
      host,
      calls,
      allowChange() {
        rejectChange = false;
      },
      nextDelta(index: number) {
        deltas[index]?.resolve();
      },
      release(index: number) {
        gates[index]?.resolve();
      },
      async close() {
        for (const gate of deltas) gate.resolve();
        for (const gate of gates) gate.resolve();
        await host.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
