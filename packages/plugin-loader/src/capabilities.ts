import {
  DATA_OP_KINDS,
  pluginCapabilitiesSchema,
  serviceContributionAccess,
  serviceContributionContract,
  type PluginCapabilities,
} from "@covel/shared";
import type { ParsedPluginMd, ParsedRuntimeMd } from "./types.js";
import type { PluginExecutionAssessment } from "./execution-assessment.js";

export function packageHasServerCode(
  assessment: PluginExecutionAssessment,
): boolean {
  return assessment.mode !== "declarative";
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
    // Offering a service to models gives its code no new power; changing
    // its data for other plugins' callers does, so a write service is listed
    // as such and a change of access asks again.
    services: (contributes?.services ?? []).map((service) =>
      serviceContributionAccess(service) === "write"
        ? `${serviceContributionContract(service)} (write)`
        : serviceContributionContract(service),
    ),
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
