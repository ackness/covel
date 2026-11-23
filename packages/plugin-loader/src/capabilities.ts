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
  const allPermissions = [
    root.plugin.permissions,
    ...runtimes.map(({ manifest }) => manifest.permissions),
  ];
  const isInstance =
    root.plugin.scope === "instance" || root.plugin.scope === "both";
  const secrets = allPermissions.some((perm) => perm?.secrets === true);
  const authProxy = allPermissions.some((perm) => perm?.authProxy === true);
  const scheduler =
    allPermissions.some((perm) => perm?.scheduler === true) ||
    Boolean(contributes?.schedules?.length);
  const sandboxWorker = allPermissions.some(
    (perm) => perm?.sandboxWorker === true,
  );
  const loopbackCallback = root.plugin.permissions?.loopbackCallback;
  const appEvents = [
    ...new Set([
      ...allPermissions.flatMap((perm) => perm?.appEvents ?? []),
      ...(contributes?.appEvents ?? []),
    ]),
  ];
  const appActions = contributes?.appActions ?? [];
  const flows = contributes?.flows ?? [];
  const providerSources = (contributes?.providerSources ?? []).map(
    (source) => source.id,
  );

  return pluginCapabilitiesSchema.parse({
    serverCode: hasServerCode,
    ...(isInstance ? { instanceScope: true } : {}),
    ...(secrets ? { secrets: true } : {}),
    ...(authProxy ? { authProxy: true } : {}),
    ...(scheduler ? { scheduler: true } : {}),
    ...(sandboxWorker ? { sandboxWorker: true } : {}),
    ...(loopbackCallback ? { loopbackCallback } : {}),
    ...(appEvents.length > 0 ? { appEvents } : {}),
    ...(appActions.length > 0 ? { appActions } : {}),
    ...(flows.length > 0 ? { flows } : {}),
    ...(providerSources.length > 0 ? { providerSources } : {}),
    http: allPermissions.flatMap((permissions) =>
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
