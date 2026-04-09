/**
 * Progressive plugin loading — three levels of detail.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';
import type { PluginType } from '@covel/shared';
import type {
  PluginDiscoveryResult,
  PluginSummary,
  LoadedRuntime,
  ParsedPluginMd,
  ParsedReference,
} from './types.js';
import { parsePluginMd } from './parse-plugin-md.js';
import { parseReference } from './parse-reference.js';

/**
 * Check whether a path exists and is a file.
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Check whether a path exists and is a directory.
 */
async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Level 0: Load lightweight plugin summary.
 * Only reads frontmatter `name` and `description` fields.
 */
export async function loadPluginSummary(discovery: PluginDiscoveryResult): Promise<PluginSummary> {
  // For multi-runtime, prefer root PLUGIN.md; fall back to first runtime's PLUGIN.md
  const rootPluginMd = path.join(discovery.rootPath, 'PLUGIN.md');
  const summaryPath = (await fileExists(rootPluginMd))
    ? rootPluginMd
    : discovery.pluginMdPaths[0];

  const content = await fs.readFile(summaryPath, 'utf-8');
  const { data } = matter(content);

  const name = typeof data.name === 'string' ? data.name : discovery.id;
  const description =
    typeof data.description === 'string' ? data.description : '';
  const pluginType: PluginType =
    data.pluginType === 'core-plugin' ? 'core-plugin' : 'plugin';

  return {
    id: discovery.id,
    name,
    description,
    pluginType,
    runtimeCount: discovery.pluginMdPaths.length,
  };
}

/**
 * Level 1: Load full plugin manifest (all frontmatter fields).
 * Returns parsed PLUGIN.md for single-runtime, or all runtimes for multi-runtime.
 */
export async function loadPluginManifest(discovery: PluginDiscoveryResult): Promise<readonly ParsedPluginMd[]> {
  const results: ParsedPluginMd[] = [];

  for (const mdPath of discovery.pluginMdPaths) {
    const content = await fs.readFile(mdPath, 'utf-8');
    const parsed = parsePluginMd(content, mdPath);
    results.push(parsed);
  }

  return results;
}

/**
 * Resolve the directory for a given runtime name within a discovery result.
 */
function resolveRuntimeDir(
  discovery: PluginDiscoveryResult,
  runtimeName: string,
): string {
  if (!discovery.isMultiRuntime) {
    return discovery.rootPath;
  }
  return path.join(discovery.rootPath, 'runtimes', runtimeName);
}

/**
 * Read all reference files from a `references/` directory.
 */
async function readReferences(runtimeDir: string): Promise<readonly ParsedReference[]> {
  const refsDir = path.join(runtimeDir, 'references');
  if (!(await dirExists(refsDir))) {
    return [];
  }

  const entries = await fs.readdir(refsDir, { withFileTypes: true });
  const refs: ParsedReference[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const filePath = path.join(refsDir, entry.name);
    const content = await fs.readFile(filePath, 'utf-8');
    refs.push(parseReference(content, filePath));
  }

  return refs;
}

/**
 * Level 2: Fully load a runtime for execution.
 * Reads prompt template, references, output schema.
 */
export async function loadRuntime(
  discovery: PluginDiscoveryResult,
  runtimeName: string,
): Promise<LoadedRuntime> {
  const runtimeDir = resolveRuntimeDir(discovery, runtimeName);
  const pluginMdPath = path.join(runtimeDir, 'PLUGIN.md');

  const content = await fs.readFile(pluginMdPath, 'utf-8');
  const parsed = parsePluginMd(content, pluginMdPath);

  const references = await readReferences(runtimeDir);

  const schemaPath = path.join(runtimeDir, 'output.schema.json');
  let outputSchema: Readonly<Record<string, unknown>> | undefined;
  if (await fileExists(schemaPath)) {
    const schemaContent = await fs.readFile(schemaPath, 'utf-8');
    outputSchema = JSON.parse(schemaContent) as Record<string, unknown>;
  }

  return {
    manifest: parsed.manifest,
    promptTemplate: parsed.promptTemplate,
    references,
    outputSchema,
  };
}
