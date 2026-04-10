/**
 * World package generator — uses LLM to create world.yaml + WORLD.md,
 * validates against worldManifestSchema, and writes to disk.
 *
 * Only requires a concept string. The LLM autonomously decides
 * all details (id, name, tags, dimensions, lore).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateWorldManifest, formatValidationErrors } from '@covel/shared';
import type { CreateWorldOptions, CreateResult } from './types.js';
import { buildWorldPrompt } from './prompts.js';

const MAX_RETRIES = 2;

function parseWorldOutput(raw: string): { yaml: string; lore: string } | null {
  const yamlMatch = raw.match(/===WORLD_YAML===\s*([\s\S]*?)\s*===WORLD_MD===/);
  const loreMatch = raw.match(/===WORLD_MD===\s*([\s\S]*?)\s*===END===/);
  if (!yamlMatch || !loreMatch) return null;
  return {
    yaml: yamlMatch[1].trim(),
    lore: loreMatch[1].trim(),
  };
}

export async function createWorld(options: CreateWorldOptions): Promise<CreateResult> {
  const locale = options.locale ?? 'zh-CN';
  const prompt = buildWorldPrompt(options.concept, locale);

  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const messages = [
      { role: 'system' as const, content: prompt },
      ...(attempt > 0
        ? [{
            role: 'user' as const,
            content: `The previous output had validation errors:\n${lastErrors.join('\n')}\n\nPlease fix and regenerate.`,
          }]
        : [{ role: 'user' as const, content: options.concept }]),
    ];

    const response = await options.llm.generate({
      model: options.model,
      messages,
    });

    if (!response.content) {
      lastErrors = ['LLM returned empty response'];
      continue;
    }

    const parsed = parseWorldOutput(response.content);
    if (!parsed) {
      lastErrors = ['Failed to parse output — expected ===WORLD_YAML=== and ===WORLD_MD=== delimiters'];
      continue;
    }

    // Parse and validate YAML
    let yamlData: Record<string, unknown>;
    try {
      yamlData = parseYaml(parsed.yaml) as Record<string, unknown>;
    } catch (err) {
      lastErrors = [`Invalid YAML: ${err instanceof Error ? err.message : String(err)}`];
      continue;
    }

    const validation = validateWorldManifest(yamlData);
    if (!validation.valid) {
      lastErrors = formatValidationErrors(validation.errors!).split('\n');
      continue;
    }

    // Extract id from validated data
    const id = yamlData.id as string;
    const lang = locale.split('-')[0];

    // Write files
    const worldDir = path.join(options.outputDir, id);
    await mkdir(worldDir, { recursive: true });

    await writeFile(path.join(worldDir, 'world.yaml'), parsed.yaml, 'utf-8');
    await writeFile(path.join(worldDir, `WORLD.${lang}.md`), parsed.lore, 'utf-8');
    await writeFile(path.join(worldDir, 'WORLD.md'), parsed.lore, 'utf-8');

    return {
      success: true,
      files: [`${id}/world.yaml`, `${id}/WORLD.${lang}.md`, `${id}/WORLD.md`],
      id,
    };
  }

  return {
    success: false,
    files: [],
    errors: lastErrors,
    id: 'unknown',
  };
}
