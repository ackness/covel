import { extname } from "node:path";
import { pathToFileURL } from "node:url";
import type { LoadedPlugin, LoadedRuntime, RegisteredToolV1, ToolFileDefinition } from "./types.js";

function toQualifiedToolId(pluginId: string, toolId: string): string {
  return `${pluginId}.${toolId}`;
}

export async function loadRuntimeTools(
  plugin: LoadedPlugin,
  runtime: LoadedRuntime,
): Promise<{ tools: RegisteredToolV1[]; errors: string[] }> {
  const tools: RegisteredToolV1[] = [];
  const errors: string[] = [];

  for (const file of runtime.toolFiles) {
    const ext = extname(file).toLowerCase();
    if (ext !== ".js" && ext !== ".mjs") {
      errors.push(`Tool file "${file}" is not loadable yet. Only .js/.mjs tools are supported in V1 runtime loader.`);
      continue;
    }

    try {
      const mod = await import(`${pathToFileURL(file).href}?generation=${plugin.generationId}`);
      const raw = (mod.tool ?? mod.default?.tool ?? mod.default) as ToolFileDefinition | undefined;
      if (!raw || typeof raw !== "object") {
        errors.push(`Tool file "${file}" does not export a valid tool definition.`);
        continue;
      }
      if (typeof raw.id !== "string" || typeof raw.execute !== "function") {
        errors.push(`Tool file "${file}" is missing required "id" or "execute" fields.`);
        continue;
      }

      tools.push({
        qualifiedId: toQualifiedToolId(plugin.manifest.id, raw.id),
        pluginId: plugin.manifest.id,
        runtimeId: runtime.manifest.id,
        toolId: raw.id,
        description: raw.description,
        exported: raw.exported === true,
        inputSchema: raw.inputSchema,
        outputSchema: raw.outputSchema,
        execute: raw.execute,
      });
    } catch (err) {
      errors.push(`Failed to load tool "${file}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { tools, errors };
}
