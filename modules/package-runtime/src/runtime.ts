import * as nodeFs from "node:fs/promises";
import type { PathLike } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ZodError } from "zod";

import type {
  CommandArgsSchema,
  CommandExecutionContext,
  CommandHandler,
  SlashCommandAutocompleteMetadata,
  SlashCommandHelpMetadata
} from "../../command-system/src/index.js";
import type {
  PackageContextFragment,
  PackageContextProviderExecutionContext,
  PackageContextProviderInput
} from "./context.js";
import { PackageRuntimeError } from "./error.js";
import {
  type ArtifactTypeContribution,
  type BlockContribution,
  type CapabilityContribution,
  type CommandContribution,
  type ContextContribution,
  type ContextProviderContribution,
  type HookContribution,
  type PackageManifest,
  PackageManifestSchema,
  type RendererContribution
} from "./manifest.js";
import { resolvePackageRelativePath } from "./path.js";

type RuntimeFs = {
  readdir(
    path: PathLike,
    options: {
      withFileTypes: true;
    }
  ): Promise<Array<{
    name: string | Buffer;
    isDirectory(): boolean;
  }>>;
  readFile(path: PathLike, encoding: BufferEncoding): Promise<string | Buffer>;
};

export interface PackageRuntimeOptions {
  packagesRoot: string;
  fs?: RuntimeFs;
}

export interface RegisteredContextProvider extends ContextProviderContribution {
  packageName: string;
  build: (
    input: PackageContextProviderInput,
    context: PackageContextProviderExecutionContext
  ) => Promise<PackageContextFragment[]> | PackageContextFragment[];
}

export interface RegisteredCommand extends Omit<CommandContribution, "argsSchema"> {
  packageName: string;
  argsSchema: CommandArgsSchema;
  execute: CommandHandler<any, any, CommandExecutionContext>;
  help?: SlashCommandHelpMetadata;
  autocomplete?: SlashCommandAutocompleteMetadata;
}

export interface RegisteredBlock extends BlockContribution {
  packageName: string;
  dataSchemaPath: string;
  responseSchemaPath: string;
}

export interface RegisteredHook extends HookContribution {
  packageName: string;
  execute: (input?: unknown, context?: CommandExecutionContext) => Promise<unknown> | unknown;
}

export interface RegisteredCapability extends Omit<CapabilityContribution, "inputSchema" | "outputSchema"> {
  packageName: string;
  inputSchemaPath: string;
  outputSchemaPath: string;
  execute: (input?: unknown, context?: CommandExecutionContext) => Promise<unknown> | unknown;
}

export interface RegisteredRenderer extends RendererContribution {
  packageName: string;
}

export interface RegisteredArtifactType extends ArtifactTypeContribution {
  packageName: string;
}

export interface RuntimePackageRecord {
  name: string;
  rootDir: string;
  manifest: PackageManifest;
  enabled: boolean;
  skillMarkdown?: string;
}

export interface PackageCommandModule<
  TArgs = any,
  TResult = any,
  TContext extends CommandExecutionContext = CommandExecutionContext
> {
  argsSchema: CommandArgsSchema<TArgs>;
  execute: CommandHandler<TArgs, TResult, TContext>;
  help?: SlashCommandHelpMetadata;
  autocomplete?: SlashCommandAutocompleteMetadata;
}

export interface PackageContextProviderModule<
  TContext extends PackageContextProviderExecutionContext = PackageContextProviderExecutionContext
> {
  build(
    input: PackageContextProviderInput,
    context: TContext
  ): Promise<PackageContextFragment[]> | PackageContextFragment[];
}

export interface PackageHookModule<
  TContext extends CommandExecutionContext = CommandExecutionContext
> {
  execute(input?: unknown, context?: TContext): Promise<unknown> | unknown;
}

export interface PackageCapabilityModule<
  TContext extends CommandExecutionContext = CommandExecutionContext
> {
  execute(input?: unknown, context?: TContext): Promise<unknown> | unknown;
}

interface MutablePackageRecord extends RuntimePackageRecord {
  registrations: {
    contextIds: string[];
    commandNames: string[];
    hookIds: string[];
    capabilityIds: string[];
    blockTypes: string[];
    rendererNames: string[];
    artifactTypes: string[];
  };
}

export class PackageRuntime {
  readonly #packagesRoot: string;
  readonly #fs: RuntimeFs;
  readonly #packages = new Map<string, MutablePackageRecord>();
  readonly #contexts = new Map<string, RegisteredContextProvider>();
  readonly #commands = new Map<string, RegisteredCommand>();
  readonly #hooks = new Map<string, RegisteredHook>();
  readonly #capabilities = new Map<string, RegisteredCapability>();
  readonly #blocks = new Map<string, RegisteredBlock>();
  readonly #renderers = new Map<string, RegisteredRenderer>();
  readonly #artifactTypes = new Map<string, RegisteredArtifactType>();

  constructor(options: PackageRuntimeOptions) {
    this.#packagesRoot = options.packagesRoot;
    this.#fs = options.fs ?? nodeFs;
  }

  async discover(): Promise<RuntimePackageRecord[]> {
    const entries = await this.#fs.readdir(this.#packagesRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const packageRoot = join(this.#packagesRoot, String(entry.name));
      const manifestPath = join(packageRoot, "manifest.json");

      let rawManifest: string | Buffer;
      try {
        rawManifest = await this.#fs.readFile(manifestPath, "utf8");
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }
        throw error;
      }

      const manifest = parseManifest(toUtf8String(rawManifest), manifestPath);

      this.#packages.set(manifest.name, {
        name: manifest.name,
        rootDir: packageRoot,
        manifest,
        enabled: false,
        registrations: {
          contextIds: [],
          commandNames: [],
          hookIds: [],
          capabilityIds: [],
          blockTypes: [],
          rendererNames: [],
          artifactTypes: []
        }
      });
    }

    return this.listPackages();
  }

  listPackages(): RuntimePackageRecord[] {
    return Array.from(this.#packages.values())
      .map((pkg) => this.#toPackageRecord(pkg))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getPackage(name: string): RuntimePackageRecord | undefined {
    const pkg = this.#packages.get(name);
    return pkg ? this.#toPackageRecord(pkg) : undefined;
  }

  async enable(name: string): Promise<RuntimePackageRecord> {
    const pkg = this.#getPackageOrThrow(name);

    if (pkg.enabled) {
      return this.#toPackageRecord(pkg);
    }

    const skillMarkdown = toUtf8String(await this.#fs.readFile(join(pkg.rootDir, "SKILL.md"), "utf8"));

    await this.#registerPackage(pkg);
    pkg.skillMarkdown = skillMarkdown;
    pkg.enabled = true;

    return this.#toPackageRecord(pkg);
  }

  disable(name: string): void {
    const pkg = this.#getPackageOrThrow(name);

    if (!pkg.enabled) {
      return;
    }

    for (const contextId of pkg.registrations.contextIds) {
      this.#contexts.delete(contextId);
    }
    for (const commandName of pkg.registrations.commandNames) {
      this.#commands.delete(commandName);
    }
    for (const hookId of pkg.registrations.hookIds) {
      this.#hooks.delete(hookId);
    }
    for (const capabilityId of pkg.registrations.capabilityIds) {
      this.#capabilities.delete(capabilityId);
    }
    for (const blockType of pkg.registrations.blockTypes) {
      this.#blocks.delete(blockType);
    }
    for (const rendererName of pkg.registrations.rendererNames) {
      this.#renderers.delete(rendererName);
    }
    for (const artifactType of pkg.registrations.artifactTypes) {
      this.#artifactTypes.delete(artifactType);
    }

    pkg.registrations = {
      contextIds: [],
      commandNames: [],
      hookIds: [],
      capabilityIds: [],
      blockTypes: [],
      rendererNames: [],
      artifactTypes: []
    };
    pkg.enabled = false;
  }

  getContextProvider(id: string): RegisteredContextProvider | undefined {
    return this.#contexts.get(id);
  }

  listContextProviders(): RegisteredContextProvider[] {
    return Array.from(this.#contexts.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  getCommand(name: string): RegisteredCommand | undefined {
    return this.#commands.get(name);
  }

  listCommands(): RegisteredCommand[] {
    return Array.from(this.#commands.values()).sort((left, right) => left.name.localeCompare(right.name));
  }

  getHook(id: string): RegisteredHook | undefined {
    return this.#hooks.get(id);
  }

  listHooks(): RegisteredHook[] {
    return Array.from(this.#hooks.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  getCapability(id: string): RegisteredCapability | undefined {
    return this.#capabilities.get(id);
  }

  listCapabilities(): RegisteredCapability[] {
    return Array.from(this.#capabilities.values()).sort((left, right) => left.id.localeCompare(right.id));
  }

  getBlock(type: string): RegisteredBlock | undefined {
    return this.#blocks.get(type);
  }

  getBlockType(type: string): RegisteredBlock | undefined {
    return this.getBlock(type);
  }

  getRenderer(name: string): RegisteredRenderer | undefined {
    return this.#renderers.get(name);
  }

  getArtifactType(type: string): RegisteredArtifactType | undefined {
    return this.#artifactTypes.get(type);
  }

  listArtifactTypes(): RegisteredArtifactType[] {
    return Array.from(this.#artifactTypes.values()).sort((left, right) => left.type.localeCompare(right.type));
  }

  #getPackageOrThrow(name: string): MutablePackageRecord {
    const pkg = this.#packages.get(name);

    if (!pkg) {
      throw new PackageRuntimeError({
        code: "PACKAGE_NOT_FOUND",
        message: `Package '${name}' was not found.`,
        details: { name }
      });
    }

    return pkg;
  }

  async #registerPackage(pkg: MutablePackageRecord): Promise<void> {
    const nextRegistrations = {
      contextIds: [] as string[],
      commandNames: [] as string[],
      hookIds: [] as string[],
      capabilityIds: [] as string[],
      blockTypes: [] as string[],
      rendererNames: [] as string[],
      artifactTypes: [] as string[]
    };

    try {
      for (const state of pkg.manifest.state) {
        resolvePackageRelativePath(pkg.rootDir, state.schema);
      }

      for (const context of pkg.manifest.contributes.contextProviders) {
        const contextEntryPath = resolvePackageRelativePath(pkg.rootDir, context.entry);
        const contextModule = await loadContextProviderModule(contextEntryPath);
        this.#registerUnique(this.#contexts, context.id, {
          ...context,
          packageName: pkg.name,
          build: contextModule.build
        }, "context provider");
        nextRegistrations.contextIds.push(context.id);
      }

      for (const command of pkg.manifest.contributes.commands) {
        const commandEntryPath = resolvePackageRelativePath(pkg.rootDir, command.entry);
        resolvePackageRelativePath(pkg.rootDir, command.argsSchema);
        const commandModule = await loadCommandModule(commandEntryPath);
        this.#registerUnique(this.#commands, command.name, {
          ...command,
          packageName: pkg.name,
          argsSchema: commandModule.argsSchema,
          execute: commandModule.execute,
          help: commandModule.help,
          autocomplete: commandModule.autocomplete
        }, "command");
        nextRegistrations.commandNames.push(command.name);
      }

      for (const hook of pkg.manifest.contributes.hooks) {
        const hookEntryPath = resolvePackageRelativePath(pkg.rootDir, hook.entry);
        const hookModule = await loadHookModule(hookEntryPath);
        this.#registerUnique(this.#hooks, hook.id, {
          ...hook,
          packageName: pkg.name,
          execute: hookModule.execute
        }, "hook");
        nextRegistrations.hookIds.push(hook.id);
      }

      for (const capability of pkg.manifest.contributes.capabilities) {
        const capabilityEntryPath = resolvePackageRelativePath(pkg.rootDir, capability.entry);
        const inputSchemaPath = resolvePackageRelativePath(pkg.rootDir, capability.inputSchema);
        const outputSchemaPath = resolvePackageRelativePath(pkg.rootDir, capability.outputSchema);
        const capabilityModule = await loadCapabilityModule(capabilityEntryPath);
        this.#registerUnique(this.#capabilities, capability.id, {
          ...capability,
          packageName: pkg.name,
          inputSchemaPath,
          outputSchemaPath,
          execute: capabilityModule.execute
        }, "capability");
        nextRegistrations.capabilityIds.push(capability.id);
      }

      for (const block of pkg.manifest.contributes.blockTypes) {
        const dataSchemaPath = resolvePackageRelativePath(pkg.rootDir, block.dataSchema);
        const responseSchemaPath = resolvePackageRelativePath(pkg.rootDir, block.responseSchema);
        this.#registerUnique(this.#blocks, block.type, {
          ...block,
          packageName: pkg.name,
          dataSchemaPath,
          responseSchemaPath
        }, "block");
        nextRegistrations.blockTypes.push(block.type);
      }

      for (const renderer of pkg.manifest.contributes.renderers) {
        resolvePackageRelativePath(pkg.rootDir, renderer.entry);
        this.#registerUnique(this.#renderers, renderer.name, {
          ...renderer,
          packageName: pkg.name
        }, "renderer");
        nextRegistrations.rendererNames.push(renderer.name);
      }

      for (const artifactType of pkg.manifest.contributes.artifactTypes) {
        this.#registerUnique(this.#artifactTypes, artifactType.type, {
          ...artifactType,
          packageName: pkg.name
        }, "artifact type");
        nextRegistrations.artifactTypes.push(artifactType.type);
      }
    } catch (error) {
      for (const contextId of nextRegistrations.contextIds) {
        this.#contexts.delete(contextId);
      }
      for (const commandName of nextRegistrations.commandNames) {
        this.#commands.delete(commandName);
      }
      for (const hookId of nextRegistrations.hookIds) {
        this.#hooks.delete(hookId);
      }
      for (const capabilityId of nextRegistrations.capabilityIds) {
        this.#capabilities.delete(capabilityId);
      }
      for (const blockType of nextRegistrations.blockTypes) {
        this.#blocks.delete(blockType);
      }
      for (const rendererName of nextRegistrations.rendererNames) {
        this.#renderers.delete(rendererName);
      }
      for (const artifactType of nextRegistrations.artifactTypes) {
        this.#artifactTypes.delete(artifactType);
      }

      throw error;
    }

    pkg.registrations = nextRegistrations;
  }

  #registerUnique<T extends { packageName: string }>(
    registry: Map<string, T>,
    key: string,
    value: T,
    contributionType: string
  ): void {
    if (registry.has(key)) {
      throw new PackageRuntimeError({
        code: "DUPLICATE_CONTRIBUTION",
        message: `Duplicate ${contributionType} registration '${key}'.`,
        details: {
          key,
          contributionType,
          packageName: value.packageName
        }
      });
    }

    registry.set(key, value);
  }

  #toPackageRecord(pkg: MutablePackageRecord): RuntimePackageRecord {
    return {
      name: pkg.name,
      rootDir: pkg.rootDir,
      manifest: pkg.manifest,
      enabled: pkg.enabled,
      ...(pkg.skillMarkdown ? { skillMarkdown: pkg.skillMarkdown } : {})
    };
  }
}

async function loadCommandModule(commandEntryPath: string): Promise<PackageCommandModule> {
  const imported = await import(pathToFileURL(commandEntryPath).href) as {
    command?: PackageCommandModule;
    default?: PackageCommandModule;
  };

  const commandModule = imported.command ?? imported.default;
  if (!commandModule || typeof commandModule.execute !== "function" || !commandModule.argsSchema) {
    throw new PackageRuntimeError({
      code: "INVALID_PACKAGE_MANIFEST",
      message: `Package command module at '${commandEntryPath}' is missing required exports.`,
      details: {
        commandEntryPath
      }
    });
  }

  return commandModule;
}

async function loadContextProviderModule(contextEntryPath: string): Promise<PackageContextProviderModule> {
  const imported = await import(pathToFileURL(contextEntryPath).href) as {
    contextProvider?: PackageContextProviderModule;
    default?: PackageContextProviderModule;
  };

  const contextModule = imported.contextProvider ?? imported.default;
  if (!contextModule || typeof contextModule.build !== "function") {
    throw new PackageRuntimeError({
      code: "INVALID_PACKAGE_MANIFEST",
      message: `Package context provider module at '${contextEntryPath}' is missing required exports.`,
      details: {
        contextEntryPath
      }
    });
  }

  return contextModule;
}

async function loadHookModule(hookEntryPath: string): Promise<PackageHookModule> {
  const imported = await import(pathToFileURL(hookEntryPath).href) as {
    hook?: PackageHookModule;
    default?: PackageHookModule;
  };

  const hookModule = imported.hook ?? imported.default;
  if (!hookModule || typeof hookModule.execute !== "function") {
    throw new PackageRuntimeError({
      code: "INVALID_PACKAGE_MANIFEST",
      message: `Package hook module at '${hookEntryPath}' is missing required exports.`,
      details: {
        hookEntryPath
      }
    });
  }

  return hookModule;
}

async function loadCapabilityModule(capabilityEntryPath: string): Promise<PackageCapabilityModule> {
  const imported = await import(pathToFileURL(capabilityEntryPath).href) as {
    capability?: PackageCapabilityModule;
    default?: PackageCapabilityModule;
  };

  const capabilityModule = imported.capability ?? imported.default;
  if (!capabilityModule || typeof capabilityModule.execute !== "function") {
    throw new PackageRuntimeError({
      code: "INVALID_PACKAGE_MANIFEST",
      message: `Package capability module at '${capabilityEntryPath}' is missing required exports.`,
      details: {
        capabilityEntryPath
      }
    });
  }

  return capabilityModule;
}

function parseManifest(rawManifest: string, manifestPath: string): PackageManifest {
  try {
    return PackageManifestSchema.parse(JSON.parse(rawManifest));
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new PackageRuntimeError({
        code: "INVALID_PACKAGE_MANIFEST",
        message: `Invalid package manifest at '${manifestPath}'.`,
        details: {
          manifestPath
        }
      });
    }

    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function toUtf8String(value: string | Buffer): string {
  return typeof value === "string" ? value : value.toString("utf8");
}
