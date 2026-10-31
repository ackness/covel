import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isPathInside,
  provideHostModules,
  readPlainYamlFrontmatter,
  EXTRACTED_KINDS,
  type ExtractedDeclarations,
} from "@covel/plugin-loader";
import {
  DEFAULT_PLUGIN_ENTRY,
  isModelFacingServiceContribution,
  pluginManifestSchema,
  serviceContributionAccess,
  serviceContributionContract,
  type ServiceContribution,
} from "@covel/shared";
import { PluginEntryScope, type PluginAPI } from "@covel/runtime";
import {
  tool,
  z,
  shortId,
  shortIdBatch,
  withModelView,
  ToolError,
  withPendingProposals,
} from "@covel/tools";

export type { ExtractedDeclarations } from "@covel/plugin-loader";

/** Runs the author's entry factory with their permissions; never runs handlers. */
export async function extractDeclarations(
  pluginRoot: string,
): Promise<ExtractedDeclarations> {
  const root = path.resolve(pluginRoot);
  const { data } = readPlainYamlFrontmatter(
    await fs.readFile(path.join(root, "PLUGIN.md"), "utf8"),
  );
  const authored = z
    .record(z.string(), z.unknown())
    .optional()
    .parse(data.contributes);
  const localizedContributes: string[] = [];
  for (const file of (await fs.readdir(root)).sort()) {
    if (!/^PLUGIN\..+\.md$/.test(file)) continue;
    const variantPath = path.join(root, file);
    const realVariant = await fs.realpath(variantPath);
    if (!isPathInside(await fs.realpath(root), realVariant))
      throw new Error(`localized manifest path escapes plugin root: ${file}`);
    const variant = readPlainYamlFrontmatter(
      await fs.readFile(variantPath, "utf8"),
    );
    const contributes = z
      .record(z.string(), z.unknown())
      .optional()
      .parse(variant.data.contributes);
    if (
      [...EXTRACTED_KINDS, "extensions", "commands"].some(
        (key) => contributes && Object.hasOwn(contributes, key),
      )
    )
      localizedContributes.push(file);
  }
  const tools: string[] = [];
  const actions: string[] = [];
  const services: ServiceContribution[] = [];
  const forms: string[] = [];
  const wires: string[] = [];
  const hooks: ExtractedDeclarations["hooks"][number][] = [];
  const extensions: string[] = [];
  const record = (list: string[], value: string) => {
    const name = z.string().min(1).parse(value);
    if (!list.includes(name)) list.push(name);
  };
  const unavailable = (name: string) => {
    throw new Error(`${name} is not available during extraction`);
  };
  const unavailableCapability = (name: string): unknown =>
    new Proxy(() => unavailable(name), {
      get(_target, key) {
        return key === "then"
          ? undefined
          : unavailableCapability(`${name}.${String(key)}`);
      },
    });
  const scope = new PluginEntryScope();
  const api: PluginAPI = {
    pluginId: path.basename(root),
    signal: scope.signal,
    toolkit: {
      tool,
      z,
      shortId,
      shortIdBatch,
      withPendingProposals,
      withModelView,
      ToolError,
    },
    http: {
      fetchWithRetry: () => unavailable("http.fetchWithRetry"),
      validateBaseUrl: () => unavailable("http.validateBaseUrl"),
    },
    onDispose(callback) {
      scope.onDispose(callback);
    },
    registerTool(definition) {
      record(tools, definition.name);
    },
    registerRpc(name) {
      record(actions, name);
    },
    registerService(definition) {
      const contract = z.string().min(1).parse(definition.contract);
      const modelFacing = definition.modelFacing === true;
      const write = definition.access === "write";
      // A write or model-facing service is declared as an object; others as
      // a string.
      const entry: ServiceContribution =
        modelFacing || write
          ? {
              contract,
              ...(write ? { access: "write" as const } : {}),
              ...(modelFacing ? { modelFacing: true } : {}),
            }
          : contract;
      if (
        !services.some(
          (service) =>
            serviceContributionContract(service) === contract &&
            isModelFacingServiceContribution(service) === modelFacing &&
            (serviceContributionAccess(service) === "write") === write,
        )
      )
        services.push(entry);
    },
    registerFormValidator(name) {
      record(forms, name);
    },
    registerWires(module) {
      for (const group of [
        module.text,
        module.image,
        module.speech,
        module.transcription,
        module.music,
      ])
        for (const wire of group ?? []) record(wires, wire.id);
    },
    on(event, _handler, options) {
      const phase = options?.enforce ?? "normal";
      const hook = phase === "normal" ? event : { event, enforce: phase };
      if (
        !hooks.some((old) =>
          typeof old === "string"
            ? old === hook
            : typeof hook !== "string" &&
              old.event === hook.event &&
              old.enforce === hook.enforce,
        )
      )
        hooks.push(hook);
    },
    provideExtension(point, id) {
      record(extensions, `${point}/${id}`);
    },
  };
  // Match runtime-loading's lexical and real-path containment and host imports.
  const realRoot = await fs.realpath(root);
  let entry = z.string().min(1).optional().parse(data.entry);
  if (!entry) {
    try {
      await fs.access(path.join(root, DEFAULT_PLUGIN_ENTRY));
      entry = DEFAULT_PLUGIN_ENTRY;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let entryFailed = false;
  let entryError: unknown;
  try {
    if (entry) {
      const fullPath = path.resolve(root, entry);
      if (!isPathInside(root, fullPath, { allowRoot: true }))
        throw new Error(`entry path escapes plugin root: ${entry}`);
      pluginManifestSchema.shape.entry.parse(entry);
      const realPath = await fs.realpath(fullPath);
      if (!isPathInside(realRoot, realPath, { allowRoot: true }))
        throw new Error(`entry path escapes plugin root: ${entry}`);
      provideHostModules(root);
      const module = await import(pathToFileURL(realPath).href);
      if (typeof module.default !== "function")
        throw new Error(
          `entry module must default-export a function: ${fullPath}`,
        );
      await module.default(
        new Proxy(api, {
          get(target, key, receiver) {
            return Reflect.has(target, key)
              ? Reflect.get(target, key, receiver)
              : key === "then"
                ? undefined
                : unavailableCapability(String(key));
          },
        }),
      );
    }
  } catch (error) {
    entryFailed = true;
    entryError = error;
  }
  try {
    await scope.dispose(entryError);
  } catch (cleanupError) {
    if (entryError !== undefined)
      throw new AggregateError(
        [entryError, cleanupError],
        entryError instanceof Error ? entryError.message : String(entryError),
      );
    throw cleanupError;
  }
  if (entryFailed) throw entryError;
  const fields = pluginManifestSchema.shape.contributes.unwrap().shape;
  for (const [key, values] of Object.entries({
    tools,
    actions,
    services,
    forms,
    wires,
    hooks,
    extensions,
  }))
    fields[key as keyof typeof fields].parse(values);
  return {
    tools,
    actions,
    services,
    forms,
    wires,
    hooks,
    extensions,
    commands: fields.commands.parse(authored?.commands) ?? [],
    localizedContributes,
  };
}
