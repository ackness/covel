import * as nodeFs from "node:fs/promises";
import type { PathLike } from "node:fs";
import { join } from "node:path";

import { ZodError } from "zod";

import { PackageRuntimeError } from "./error.js";
import {
  type BlockContribution,
  type CommandContribution,
  type ContextContribution,
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

export interface RegisteredContextProvider extends ContextContribution {
  packageName: string;
}

export interface RegisteredCommand extends CommandContribution {
  packageName: string;
}

export interface RegisteredBlock extends BlockContribution {
  packageName: string;
}

export interface RegisteredRenderer extends RendererContribution {
  packageName: string;
}

export interface RuntimePackageRecord {
  name: string;
  rootDir: string;
  manifest: PackageManifest;
  enabled: boolean;
  skillMarkdown?: string;
}

interface MutablePackageRecord extends RuntimePackageRecord {
  registrations: {
    contextIds: string[];
    commandNames: string[];
    blockTypes: string[];
    rendererNames: string[];
  };
}

export class PackageRuntime {
  readonly #packagesRoot: string;
  readonly #fs: RuntimeFs;
  readonly #packages = new Map<string, MutablePackageRecord>();
  readonly #contexts = new Map<string, RegisteredContextProvider>();
  readonly #commands = new Map<string, RegisteredCommand>();
  readonly #blocks = new Map<string, RegisteredBlock>();
  readonly #renderers = new Map<string, RegisteredRenderer>();

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
          blockTypes: [],
          rendererNames: []
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

    this.#registerPackage(pkg);
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
    for (const blockType of pkg.registrations.blockTypes) {
      this.#blocks.delete(blockType);
    }
    for (const rendererName of pkg.registrations.rendererNames) {
      this.#renderers.delete(rendererName);
    }

    pkg.registrations = {
      contextIds: [],
      commandNames: [],
      blockTypes: [],
      rendererNames: []
    };
    pkg.enabled = false;
  }

  getContextProvider(id: string): RegisteredContextProvider | undefined {
    return this.#contexts.get(id);
  }

  getCommand(name: string): RegisteredCommand | undefined {
    return this.#commands.get(name);
  }

  getBlock(type: string): RegisteredBlock | undefined {
    return this.#blocks.get(type);
  }

  getRenderer(name: string): RegisteredRenderer | undefined {
    return this.#renderers.get(name);
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

  #registerPackage(pkg: MutablePackageRecord): void {
    const nextRegistrations = {
      contextIds: [] as string[],
      commandNames: [] as string[],
      blockTypes: [] as string[],
      rendererNames: [] as string[]
    };

    try {
      for (const context of pkg.manifest.contributes.context) {
        resolvePackageRelativePath(pkg.rootDir, context.entry);
        this.#registerUnique(this.#contexts, context.id, {
          ...context,
          packageName: pkg.name
        }, "context provider");
        nextRegistrations.contextIds.push(context.id);
      }

      for (const command of pkg.manifest.contributes.commands) {
        resolvePackageRelativePath(pkg.rootDir, command.entry);
        resolvePackageRelativePath(pkg.rootDir, command.argsSchema);
        this.#registerUnique(this.#commands, command.name, {
          ...command,
          packageName: pkg.name
        }, "command");
        nextRegistrations.commandNames.push(command.name);
      }

      for (const block of pkg.manifest.contributes.blocks) {
        resolvePackageRelativePath(pkg.rootDir, block.dataSchema);
        resolvePackageRelativePath(pkg.rootDir, block.responseSchema);
        this.#registerUnique(this.#blocks, block.type, {
          ...block,
          packageName: pkg.name
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
    } catch (error) {
      for (const contextId of nextRegistrations.contextIds) {
        this.#contexts.delete(contextId);
      }
      for (const commandName of nextRegistrations.commandNames) {
        this.#commands.delete(commandName);
      }
      for (const blockType of nextRegistrations.blockTypes) {
        this.#blocks.delete(blockType);
      }
      for (const rendererName of nextRegistrations.rendererNames) {
        this.#renderers.delete(rendererName);
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
