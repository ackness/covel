/**
 * Characterization of the reasoning controls: what every known model name
 * offers and what each protocol sends for each level. It records the current
 * behaviour, right or wrong, so a change to how the levels are decided shows
 * up as a diff in `__snapshots__/reasoning-characterization.snap.txt`.
 *
 * Models with the same behaviour share a class; the snapshot lists each class
 * once and then the class of every model.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BUILTIN_PROVIDER_PROTOCOLS } from "@covel/shared";

import type { ModelProviderAdapter } from "../src/adapters/adapter.js";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { createGoogleGenerativeAiAdapter } from "../src/adapters/google-generative-ai.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { withTextRequestDefaults } from "../src/adapters/request-defaults.js";
import { extractReasoningRequestFields } from "../src/protocol-registry.js";
import {
  REASONING_EFFORT_VALUES,
  resolveReasoningEffortProfile,
  type ReasoningEffortProfile,
} from "../src/reasoning-effort.js";
import type {
  ModelRequestContext,
  TextGenerationParams,
} from "../src/types.js";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Names the model checks are written for, with the prefixes, suffixes and
 * near misses that decide which side of a check a name falls on. The bundled
 * tables do not carry all of them.
 */
const NAMES_FROM_CHECKS = [
  // DeepSeek
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-flash",
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-r1",
  "deepseek-coder",
  "deepseek/deepseek-v4-flash",
  "DeepSeek-V4-Flash",
  // Anthropic
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-fable-5.1",
  "claude-mythos-5",
  "claude-mythos-5-1",
  "claude-opus-5",
  "claude-opus-5-5",
  "claude-opus-5.5",
  "claude-opus-5-5-20260901",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-sonnet-5.5",
  "claude-haiku-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-0",
  "claude-haiku-4-5",
  "claude-3-7-sonnet-latest",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-sonnet-4.6",
  "us.anthropic.claude-opus-4-6-v1:0",
  "anthropic/unknown-model",
  // Gemini
  "gemini-2.5-pro",
  "gemini-2.5-pro-preview-06-05",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash-latest",
  "gemini-2.5-flash-image",
  "gemini-2.0-flash",
  "gemini-3-pro",
  "gemini-3-pro-preview",
  "gemini-3-pro-image-preview",
  "gemini-3.1-pro",
  "gemini-3.1-pro-preview",
  "gemini-3-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.5-flash-001",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
  "gemini-4-pro",
  "models/gemini-2.5-flash",
  "google/gemini-3.5-flash",
  "google/gemma-4-31b-it",
  // xAI
  "grok-3",
  "grok-3-mini",
  "grok-4",
  "grok-4-fast",
  "grok-4.20",
  "grok-4.20-multi-agent",
  "grok-5",
  "xai/grok-4",
  "xai/unknown-model",
  // Qwen
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.8-omni-flash",
  "qwen3.8-27b",
  "qwen3.8-2.4t-a95b",
  "qwen3.8-plus",
  "qwen3.8-max-thinking",
  "qwen3.7-max",
  "qwen3.7-max-preview",
  "qwen3.7-max-2026-05-17",
  "qwen3.7-plus",
  "qwen3.6-flash",
  "qwen3.5-max",
  "qwen3.5-plus-2026-02-15",
  "qwen3-max",
  "qwen3-235b-a22b-thinking-2507",
  "qwen-plus",
  "qwen-max-latest",
  "qwen/qwen3.8-max",
  "alibaba/qwen3.7-plus",
  "alibaba/unknown-model",
  // OpenAI
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-pro",
  "gpt-5-pro-2025-10-06",
  "gpt-5-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.6-sol",
  "gpt-6",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-7",
  "o1",
  "o1-mini",
  "o3",
  "o3-mini",
  "o3-pro",
  "o4-mini",
  "o5",
  "openai/gpt-5.6-sol",
  "openai/o3",
  "openai/unknown-model",
  "codex/gpt-6-luna",
  "azure/o4-mini",
  // No family in the name
  "kimi-k3",
  "moonshot/kimi-k3",
  "glm-5.2",
  "mistral-medium-latest",
  "llama-4-70b",
  "unknown-model",
];

/** One provider ID per family the transport provider can select. */
const PROVIDERS = [
  "custom",
  "openai",
  "anthropic",
  "deepseek",
  "google",
  "xai",
  "dashscope",
];

const TEXT_PROTOCOLS = [
  "openai-chat-v1",
  "openai-responses-v1",
  "anthropic-messages-v1",
  "google-generative-ai-v1",
] as const;

function modelNames(): string[] {
  const bundled = JSON.parse(
    readFileSync(here("../data/model-db.json"), "utf-8"),
  ) as { models: Record<string, unknown> };
  const known = JSON.parse(
    readFileSync(here("../src/capability/known-models.data.json"), "utf-8"),
  ) as { models: Record<string, unknown>; aliases: Record<string, string> };
  return [
    ...new Set([
      ...Object.keys(bundled.models),
      ...Object.keys(known.models),
      ...Object.keys(known.aliases),
      ...NAMES_FROM_CHECKS,
    ]),
  ].sort();
}

function context(model: string, provider: string): ModelRequestContext {
  return {
    profile: { provider, model } as ModelRequestContext["profile"],
    preset: null,
    mode: "text",
  };
}

function describeProfile(profile: ReasoningEffortProfile | null): string {
  if (!profile) return "none";
  const levels = profile.options.map((option) =>
    option.thinkingBudgetTokens === undefined
      ? option.value
      : `${option.value}(${option.thinkingBudgetTokens})`,
  );
  return `${profile.family} default=${profile.defaultValue ?? "-"} [${levels.join(" ")}]`;
}

/** Group the keys that share a value: `a,b: value`. */
function grouped(entries: Array<[string, string]>, indent: string): string[] {
  const byValue = new Map<string, string[]>();
  for (const [key, value] of entries) {
    byValue.set(value, [...(byValue.get(value) ?? []), key]);
  }
  return [...byValue].map(
    ([value, keys]) => `${indent}${keys.join(",")}: ${value}`,
  );
}

/** What the settings UI is offered and what each level sends. */
function fieldsBehaviour(model: string, provider: string): string {
  const lines: string[] = [];
  const ctx = context(model, provider);
  for (const protocol of [undefined, ...BUILTIN_PROVIDER_PROTOCOLS]) {
    lines.push(`  ${protocol ?? "(no protocol)"}`);
    const plain = describeProfile(
      resolveReasoningEffortProfile(model, provider, protocol),
    );
    const advertised = describeProfile(
      resolveReasoningEffortProfile(model, provider, protocol, ["reasoning"]),
    );
    lines.push(`    profile: ${plain}`);
    if (advertised !== plain) {
      lines.push(`    profile, table says reasoning: ${advertised}`);
    }
    if (!protocol) continue;

    const warnings: string[] = [];
    const defaulted = withTextRequestDefaults(
      {
        model,
        messages: [],
        defaults: { reasoningEffort: "disabled" },
      },
      ctx,
      protocol,
      (message) => warnings.push(message.replaceAll(model, "<model>")),
    );
    lines.push(
      `    runtime default off: ${String(defaulted.providerRequestMetadata?.reasoningEffort ?? "nothing")}${warnings.map((warning) => ` (${warning})`).join("")}`,
    );
    lines.push(
      ...grouped(
        REASONING_EFFORT_VALUES.map((level) => [
          level,
          JSON.stringify(
            extractReasoningRequestFields(
              { reasoningEffort: level },
              ctx,
              protocol,
              model,
            ),
          ),
        ]),
        "    ",
      ),
    );
  }
  return lines.join("\n");
}

function allProviders(model: string): string {
  return grouped(
    PROVIDERS.map((provider) => [provider, fieldsBehaviour(model, provider)]),
    "provider ",
  )
    .map((block) => block.replace(": ", ":\n"))
    .join("\n");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}

const ADAPTERS: Record<(typeof TEXT_PROTOCOLS)[number], ModelProviderAdapter> =
  {
    "openai-chat-v1": createOpenAiChatAdapter(),
    "openai-responses-v1": createOpenAiResponsesAdapter(),
    "anthropic-messages-v1": createAnthropicMessagesAdapter(),
    "google-generative-ai-v1": createGoogleGenerativeAiAdapter(),
  };

/** Request parts that never depend on the reasoning level. */
const IGNORED_BODY_KEYS = new Set([
  "model",
  "messages",
  "input",
  "contents",
  "system",
  "systemInstruction",
  "tools",
  "stream",
]);

let lastBody: string | undefined;

/**
 * The body an adapter sends, with sampling overrides, one tool and a required
 * tool call, so the rules that depend on the thinking state take part.
 */
async function requestBody(
  protocol: (typeof TEXT_PROTOCOLS)[number],
  model: string,
  selection: string,
): Promise<string> {
  const ctx = context(model, "custom");
  const base: TextGenerationParams = {
    model,
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "roll", parameters: { type: "object" } },
      },
    ],
    providerRequestMetadata: {
      parameterOverrides: {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 1000,
        ...(selection === "runtime default off"
          ? {}
          : { reasoningEffort: selection }),
      },
    },
    defaults: {
      toolChoice: "required",
      ...(selection === "runtime default off"
        ? { reasoningEffort: "disabled" as const }
        : {}),
    },
  };
  lastBody = undefined;
  try {
    await ADAPTERS[protocol].generateText(
      { baseUrl: "https://api.example.com", apiKey: "k" },
      withTextRequestDefaults(base, ctx, protocol),
      ctx,
    );
  } catch {
    // Only the request matters; the canned reply need not parse.
  }
  if (lastBody === undefined) return "no request";
  const body = JSON.parse(lastBody) as Record<string, unknown>;
  for (const key of IGNORED_BODY_KEYS) delete body[key];
  return JSON.stringify(sortKeys(body));
}

async function bodiesBehaviour(model: string): Promise<string> {
  const lines: string[] = [];
  for (const protocol of TEXT_PROTOCOLS) {
    lines.push(`  ${protocol}`);
    const entries: Array<[string, string]> = [];
    for (const selection of [
      "runtime default off",
      ...REASONING_EFFORT_VALUES,
    ]) {
      entries.push([selection, await requestBody(protocol, model, selection)]);
    }
    lines.push(...grouped(entries, "    "));
  }
  return lines.join("\n");
}

function classId(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

function render(
  title: string,
  classes: Map<string, { text: string; example: string; count: number }>,
): string {
  return [...classes]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(
      ([id, entry]) =>
        `## ${title} ${id} (${entry.count} models, e.g. ${entry.example})\n${entry.text}\n`,
    )
    .join("\n");
}

describe("reasoning controls of every known model", () => {
  beforeAll(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        if (lastBody === undefined && typeof init?.body === "string") {
          lastBody = init.body;
        }
        return Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("offers and sends what the recorded snapshot says", async () => {
    const names = modelNames();
    const fieldClasses = new Map<
      string,
      { text: string; example: string; count: number }
    >();
    const bodyClasses = new Map<
      string,
      { text: string; example: string; count: number }
    >();
    const index: string[] = [];

    const record = (
      classes: typeof fieldClasses,
      text: string,
      model: string,
    ): string => {
      const id = classId(text);
      const entry = classes.get(id);
      if (entry) entry.count += 1;
      else classes.set(id, { text, example: model, count: 1 });
      return id;
    };

    for (const model of names) {
      const fields = record(fieldClasses, allProviders(model), model);
      const bodies = record(bodyClasses, await bodiesBehaviour(model), model);
      index.push(`${model}\t${fields}\t${bodies}`);
    }

    const snapshot = [
      `# ${names.length} models; levels: ${REASONING_EFFORT_VALUES.join(" ")}`,
      "",
      "# Offered levels and the fields each level sends, per provider and protocol",
      "",
      render("fields", fieldClasses),
      "# Adapter request bodies (provider `custom`), without the parts no level changes",
      "",
      render("bodies", bodyClasses),
      "# model, fields class, bodies class",
      "",
      ...index,
      "",
    ].join("\n");

    await expect(snapshot).toMatchFileSnapshot(
      "./__snapshots__/reasoning-characterization.snap.txt",
    );
  }, 120_000);
});
