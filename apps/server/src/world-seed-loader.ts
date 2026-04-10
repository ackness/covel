/**
 * World seed loader — reads worlds/ directory and upserts into the DataStore.
 *
 * Each world package has:
 *   world.yaml  — manifest (id, name, summary, dimensions, tags, …)
 *   WORLD.md    — default lore (fallback)
 *   WORLD.zh.md — Chinese lore (optional, locale-specific)
 *   WORLD.en.md — English lore (optional, locale-specific)
 *
 * Lore resolution: WORLD.<locale-prefix>.md → WORLD.md → empty string
 */

import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateWorldManifest, formatValidationErrors } from '@covel/shared';
import type { DataStore, WorldRecord } from '@covel/store';

async function fileExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/**
 * Resolve a single I18nText field to a plain display string.
 * If the value is a Record, pick `defaultLocale` key → first key → empty.
 */
function resolveText(value: string | Record<string, string> | undefined, defaultLocale?: string): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
  const keys = Object.keys(value);
  return keys.length > 0 ? value[keys[0]] : '';
}

/**
 * Read locale-aware WORLD.md lore file.
 * Priority: WORLD.<lang>.md → WORLD.md → ''
 */
async function readLore(worldDir: string, defaultLocale?: string): Promise<string> {
  const lang = defaultLocale?.split('-')[0]; // "zh-CN" → "zh"

  // Try locale-specific first
  if (lang) {
    const localePath = path.join(worldDir, `WORLD.${lang}.md`);
    if (await fileExists(localePath)) {
      return readFile(localePath, 'utf-8');
    }
  }

  // Fallback to default WORLD.md
  const defaultPath = path.join(worldDir, 'WORLD.md');
  if (await fileExists(defaultPath)) {
    return readFile(defaultPath, 'utf-8');
  }

  return '';
}

/**
 * Discover and load all world packages from a directory.
 * Validates each world.yaml against worldManifestSchema.
 * Returns WorldRecord[] ready for upsert.
 */
export async function loadWorldPackages(worldsDir: string): Promise<WorldRecord[]> {
  if (!(await fileExists(worldsDir))) return [];

  const entries = await readdir(worldsDir, { withFileTypes: true });
  const records: WorldRecord[] = [];
  const now = new Date().toISOString();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const worldDir = path.join(worldsDir, entry.name);
    const yamlPath = path.join(worldDir, 'world.yaml');

    if (!(await fileExists(yamlPath))) continue;

    try {
      const yamlContent = await readFile(yamlPath, 'utf-8');
      const raw = parseYaml(yamlContent) as Record<string, unknown>;

      // Validate against worldManifestSchema
      const validation = validateWorldManifest(raw);
      if (!validation.valid) {
        console.warn(
          `[world-seed] Invalid world.yaml in ${entry.name}:\n${formatValidationErrors(validation.errors!)}`,
        );
        continue;
      }

      const manifest = validation.data as Record<string, unknown>;
      const defaultLocale = manifest.defaultLocale as string | undefined;

      const lore = await readLore(worldDir, defaultLocale);

      const record: WorldRecord = {
        id: manifest.id as string,
        name: resolveText(manifest.name as string | Record<string, string>, defaultLocale),
        description: resolveText(manifest.summary as string | Record<string, string> | undefined, defaultLocale),
        lore: lore || undefined,
        tags: manifest.tags as string[] | undefined,
        locale: defaultLocale,
        metadata: {
          dimensions: manifest.dimensions as Record<string, unknown> | undefined,
          requiredPlugins: manifest.requiredPlugins as string[] | undefined,
          recommendedPlugins: manifest.recommendedPlugins as string[] | undefined,
        },
        createdAt: now,
        updatedAt: now,
      };

      records.push(record);
    } catch (err) {
      console.warn(`[world-seed] Failed to load world ${entry.name}:`, err);
    }
  }

  return records;
}

/**
 * Seed all world packages into the DataStore (idempotent via upsert).
 */
export async function seedWorlds(store: DataStore, worldsDir: string): Promise<number> {
  const records = await loadWorldPackages(worldsDir);

  for (const record of records) {
    await store.upsertWorld(record);
  }

  if (records.length > 0) {
    console.log(`[world-seed] Loaded ${records.length} world(s): ${records.map((r) => r.id).join(', ')}`);
  }

  return records.length;
}
