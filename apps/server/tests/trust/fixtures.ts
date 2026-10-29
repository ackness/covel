import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createServerSettings } from "../../src/lib/server-settings.js";
import { createTrustedSourceService } from "../../src/trust/trusted-source-service.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compileInlineRuntime,
  computePluginCapabilities,
  packageHasServerCode,
  parsePluginMd,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { GithubPluginPreview, PluginCapabilities } from "@covel/shared";
import { digestEntries } from "../../src/routes/api/install/github-source.js";
import { receiptEntry } from "../../src/routes/api/install/github-preview.js";
import {
  INSTALL_RECEIPT_FILE,
  type ExtractedEntry,
} from "../../src/routes/api/install/shared.js";
export const id = "trusted-probe";
export const repository = "https://github.com/example/plugins";
export const md = (value: object) =>
  `---\n${JSON.stringify(value)}\n---\nPrompt`;
export async function packageFixture(
  root: string,
  options: {
    manifest?: object;
    files?: Record<string, string>;
    snapshot?: PluginCapabilities | null;
    trusted?: boolean;
    source?: "builtin" | "community";
    repository?: string;
  } = {},
) {
  const directory = path.join(root, id);
  const manifest = { id, description: "Probe", ...options.manifest };
  const files = { "PLUGIN.md": md(manifest), ...options.files };
  const entries: ExtractedEntry[] = Object.entries(files).map(
    ([relativePath, content]) => ({
      relativePath,
      content: Buffer.from(content),
    }),
  );
  const parsed = parsePluginMd(
    files["PLUGIN.md"],
    path.join(directory, "PLUGIN.md"),
  );
  const inline = compileInlineRuntime(parsed);
  const runtimes = inline ? [inline] : [];
  const capabilities = computePluginCapabilities({
    root: parsed,
    runtimes,
    hasServerCode: packageHasServerCode(Object.keys(files), parsed, runtimes),
  });
  const preview: GithubPluginPreview = {
    id,
    description: "Probe",
    author: null,
    version: null,
    hasServerCode: capabilities.serverCode,
    capabilities: options.snapshot ?? capabilities,
    trustedSource: options.snapshot !== null && options.trusted !== false,
    source: {
      repository: options.repository ?? repository,
      digest: digestEntries(entries),
      commit: "a".repeat(40),
      path: "",
      tracking: { kind: "default-branch" },
    },
    token: "preview",
    expiresAt: Date.now() + 900_000,
  };
  const receipt = receiptEntry(preview);
  for (const entry of [...entries, receipt]) {
    const filename = path.join(directory, entry.relativePath);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, entry.content);
  }
  const entry: PluginRegistryEntry = {
    id,
    rootPath: directory,
    source: options.source ?? "community",
    packageManifest: parsed,
    manifests: runtimes,
    summary: {
      id,
      name: id,
      description: "Probe",
      kind: "plugin",
      runtimeCount: runtimes.length,
    },
    status: "discovered",
    loadedRuntimes: new Map(),
  };
  return {
    directory,
    entry,
    entries,
    capabilities,
    preview,
    receiptPath: path.join(directory, INSTALL_RECEIPT_FILE),
  };
}

export async function installTrustPolicy(pluginsRoot: string) {
  const settings = createServerSettings(createMemoryStore(), {
    playerWritable: true,
  });
  await settings.load();
  return createTrustedSourceService({
    settings,
    registry: createPluginRegistry(),
    pluginsRoot,
  });
}
