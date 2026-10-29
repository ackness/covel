import {
  DATA_OP_KINDS,
  pluginCapabilitiesSchema,
  type PluginCapabilities,
} from "@covel/shared";
import type { ParsedPluginMd, ParsedRuntimeMd } from "./types.js";
import { pluginImportReferences } from "./static-validation.js";

export function packageHasServerCode(
  files: readonly string[],
  root: ParsedPluginMd,
  runtimes: readonly ParsedRuntimeMd[],
): boolean {
  return (
    pluginImportReferences(root, runtimes).length > 0 ||
    files.some((file) => /\.(?:[cm]?[jt]s|tsx|node|wasm)$/i.test(file))
  );
}
export function computePluginCapabilities({
  root,
  runtimes,
  hasServerCode,
}: {
  root: ParsedPluginMd;
  runtimes: readonly ParsedRuntimeMd[];
  hasServerCode: boolean;
}): PluginCapabilities {
  const contributes = root.plugin.contributes;
  return pluginCapabilitiesSchema.parse({
    serverCode: hasServerCode,
    http: [
      root.plugin.permissions,
      ...runtimes.map(({ manifest }) => manifest.permissions),
    ].flatMap((permissions) =>
      (permissions?.http ?? []).map((http) => ({
        ...http,
        methods: http.methods ?? ["GET"],
      })),
    ),
    hooks: (contributes?.hooks ?? []).map((hook) => ({
      event: hook.event,
      enforce: hook.enforce ?? "normal",
    })),
    tools: [
      ...(contributes?.tools ?? []),
      ...runtimes.flatMap(({ manifest }) => manifest.tools?.builtin ?? []),
    ],
    actions: contributes?.actions ?? [],
    services: contributes?.services ?? [],
    wires: contributes?.wires ?? [],
    forms: contributes?.forms ?? [],
    extensions: (contributes?.extensions ?? []).map(
      (extension) => `${extension.point}/${extension.id}`,
    ),
    datasets: Object.entries(contributes?.datasets ?? {}).map(
      ([namespace, declaration]) => ({
        namespace,
        ops: declaration.ops ?? DATA_OP_KINDS,
      }),
    ),
  });
}
