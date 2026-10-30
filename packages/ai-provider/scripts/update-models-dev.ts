#!/usr/bin/env npx tsx
/**
 * Fetch the models.dev catalog (v2 API) and keep, for each model each host
 * serves, the request options Covel shapes requests with: reasoning controls,
 * sampling parameters the model fixes itself, and tool choices per protocol.
 * Writes src/capability/models-dev.data.json.
 *
 * models.dev (https://github.com/sst/models.dev, MIT) is maintained by its
 * community with per-host sources; Covel's own reasoning data only corrects
 * or extends it. Release builds read the committed output, never the network.
 *
 * Usage:
 *   pnpm --filter @covel/ai-provider update-models-dev
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type {
  ModelsDevFile,
  ModelsDevVariant,
} from "../src/capability/models-dev.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(
  __dirname,
  "../src/capability/models-dev.data.json",
);
const SOURCE_URL = "https://models.dev/experimental/v2.0/api.json";
const COMMIT_URL = "https://api.github.com/repos/sst/models.dev/commits/dev";
const LICENSE =
  "MIT License, Copyright (c) 2025 models.dev. https://github.com/sst/models.dev/blob/dev/LICENSE";

const effort = z.string();
const sourceModelSchema = z.looseObject({
  canonical_id: z.string().optional(),
  capabilities: z
    .looseObject({
      reasoning: z
        .looseObject({
          supported: z.boolean(),
          default: z
            .looseObject({ type: z.string(), value: z.unknown() })
            .optional(),
          toggle: z.boolean().optional(),
          effort: z.array(effort).optional(),
        })
        .optional(),
      temperature: z.boolean().optional(),
      top_p: z.boolean().optional(),
    })
    .optional(),
  api: z
    .record(
      z.string(),
      z.looseObject({
        base_url: z.string().optional(),
        capabilities: z
          .looseObject({
            tools: z
              .looseObject({ choice: z.array(z.string()).optional() })
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});
const sourceSchema = z.record(
  z.string(),
  z.looseObject({ models: z.record(z.string(), sourceModelSchema).optional() }),
);

/** The protocols Covel speaks, by their models.dev API name. */
const PROTOCOLS = ["chat-completions", "responses", "messages"] as const;
const EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function hostOf(url: string | undefined): string | undefined {
  if (!url || url.startsWith("${")) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

function variantOf(
  model: z.infer<typeof sourceModelSchema>,
): Omit<ModelsDevVariant, "providers" | "hosts"> | null {
  const capabilities = model.capabilities ?? {};
  const reasoning = capabilities.reasoning;
  const variant: Omit<ModelsDevVariant, "providers" | "hosts"> = {};
  if (reasoning?.supported) {
    const efforts = (reasoning.effort ?? []).filter((value) =>
      EFFORTS.has(value),
    );
    const fallback = reasoning.default;
    variant.reasoning = {
      ...(reasoning.toggle ? { toggle: true } : {}),
      ...(efforts.length > 0 ? { effort: efforts } : {}),
      ...(fallback?.type === "effort" &&
      typeof fallback.value === "string" &&
      EFFORTS.has(fallback.value)
        ? { default: fallback.value }
        : fallback?.type === "toggle" && typeof fallback.value === "boolean"
          ? { default: fallback.value ? "on" : "off" }
          : {}),
    } as ModelsDevVariant["reasoning"];
  }
  const fixed = (["temperature", "top_p"] as const).filter(
    (name) => capabilities[name] === false,
  );
  if (fixed.length > 0) variant.fixed = fixed;
  const choice: Record<string, string[]> = {};
  for (const protocol of PROTOCOLS) {
    const choices = model.api?.[protocol]?.capabilities?.tools?.choice;
    if (choices?.length) choice[protocol] = choices;
  }
  if (Object.keys(choice).length > 0) variant.toolChoice = choice;
  if (!variant.reasoning && !variant.fixed && !variant.toolChoice) return null;
  const lab = model.canonical_id?.split("/")[0];
  if (lab) variant.lab = lab;
  return variant;
}

async function main() {
  console.log(`Fetching ${SOURCE_URL}`);
  const response = await fetch(SOURCE_URL);
  if (!response.ok)
    throw new Error(
      `Failed to fetch: ${response.status} ${response.statusText}`,
    );
  const source = sourceSchema.parse(await response.json());
  const commit = await fetch(COMMIT_URL)
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => (body as { sha?: string } | null)?.sha)
    .catch(() => undefined);

  const models: Record<string, ModelsDevVariant[]> = {};
  for (const [providerId, provider] of Object.entries(source)) {
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const variant = variantOf(model);
      if (!variant) continue;
      const hosts = PROTOCOLS.map((protocol) =>
        hostOf(model.api?.[protocol]?.base_url),
      ).filter((host): host is string => Boolean(host));
      const key = modelId.toLowerCase();
      const list = (models[key] ??= []);
      const same = JSON.stringify(variant);
      const existing = list.find(
        ({ providers: _p, hosts: _h, ...rest }) =>
          JSON.stringify(rest) === same,
      );
      if (existing) {
        existing.providers.push(providerId);
        for (const host of hosts)
          if (!existing.hosts.includes(host)) existing.hosts.push(host);
      } else {
        list.push({
          providers: [providerId],
          hosts: [...new Set(hosts)],
          ...variant,
        });
      }
    }
  }

  const sorted = Object.fromEntries(
    Object.entries(models).sort(([a], [b]) => a.localeCompare(b)),
  );
  const file: ModelsDevFile = {
    source: SOURCE_URL,
    license: LICENSE,
    ...(commit ? { commit } : {}),
    fetchedAt: new Date().toISOString(),
    models: sorted,
  };
  // One model per line keeps refresh diffs reviewable.
  const lines = Object.entries(file.models).map(
    ([id, variants]) =>
      `    ${JSON.stringify(id)}: ${JSON.stringify(variants)}`,
  );
  const header = JSON.stringify(
    {
      source: file.source,
      license: file.license,
      commit: file.commit,
      fetchedAt: file.fetchedAt,
    },
    null,
    2,
  ).slice(0, -2);
  writeFileSync(
    OUTPUT_PATH,
    `${header},\n  "models": {\n${lines.join(",\n")}\n  }\n}\n`,
    "utf-8",
  );
  console.log(
    `Wrote ${lines.length} models (${Object.values(file.models).flat().length} host variants) to ${OUTPUT_PATH}`,
  );
}

await main();
