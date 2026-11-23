import { z } from "zod";
import { DATA_OP_KINDS } from "@covel/plugin-handlers-utils";
import {
  APP_EVENT_NAMES,
  loopbackCallbackPermissionSchema,
} from "../platform/index.js";

export const trustedSourceEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(100)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38})(?:\/[a-z0-9._-]{1,100})?$/);
const sorted = (values: string[]) => [...new Set(values)].sort();
export function normalizeTrustedSources(list: readonly string[]): string[] {
  return sorted(z.array(trustedSourceEntrySchema).max(100).parse(list));
}

/** Match complete GitHub owner/repository components, never URL prefixes. */
export function trustedSourceMatches(
  entries: readonly string[],
  repositoryUrl: string,
): boolean {
  const match =
    /^https:\/\/github\.com\/([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9._-]{1,100})$/i.exec(
      repositoryUrl,
    );
  if (!match || !match[1] || !match[2] || /\.git$/i.test(match[2]))
    return false;
  const owner = match[1].toLowerCase();
  const repository = `${owner}/${match[2].toLowerCase()}`;
  return entries.some((entry) => {
    const parsed = trustedSourceEntrySchema.safeParse(entry);
    return (
      parsed.success && (parsed.data === owner || parsed.data === repository)
    );
  });
}
const names = z.array(z.string().min(1)).transform(sorted);
const methods = z
  .array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]))
  .transform(sorted);
const operations = z.array(z.enum(DATA_OP_KINDS)).transform(sorted);
const hookSchema = z.strictObject({
  event: z.string().min(1),
  enforce: z.enum(["pre", "normal", "post"]).default("normal"),
});
function uniqueRecords<T>(values: T[]): T[] {
  return [
    ...new Map(values.map((value) => [JSON.stringify(value), value])).entries(),
  ]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, value]) => value);
}
export const pluginCapabilitiesSchema = z.strictObject({
  serverCode: z.boolean(),
  instanceScope: z.boolean().optional(),
  secrets: z.boolean().optional(),
  authProxy: z.boolean().optional(),
  scheduler: z.boolean().optional(),
  sandboxWorker: z.boolean().optional(),
  loopbackCallback: loopbackCallbackPermissionSchema.optional(),
  appEvents: z.array(z.enum(APP_EVENT_NAMES)).transform(sorted).optional(),
  appActions: names.optional(),
  flows: names.optional(),
  providerSources: names.optional(),
  http: z
    .array(
      z.strictObject({
        origin: z.string().regex(/^https:\/\/[^/?#@]+$/),
        methods,
      }),
    )
    .transform((values) => {
      const merged = new Map<string, string[]>();
      for (const value of values)
        merged.set(
          value.origin,
          sorted([...(merged.get(value.origin) ?? []), ...value.methods]),
        );
      return [...merged]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([origin, methods]) => ({ origin, methods }));
    }),
  hooks: z.array(hookSchema).transform(uniqueRecords),
  tools: names,
  actions: names,
  services: names,
  wires: names,
  extensions: names,
  forms: names,
  datasets: z
    .array(z.strictObject({ namespace: z.string().min(1), ops: operations }))
    .transform((values) => {
      const merged = new Map<string, string[]>();
      for (const value of values)
        merged.set(
          value.namespace,
          sorted([...(merged.get(value.namespace) ?? []), ...value.ops]),
        );
      return [...merged]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([namespace, ops]) => ({ namespace, ops }));
    }),
});
export type PluginCapabilities = z.infer<typeof pluginCapabilitiesSchema>;
export const pluginSourceTrustSchema = z.strictObject({
  source: z.string().nullable(),
  trustedSource: z.boolean(),
  integrity: z.enum(["verified", "modified", "no-receipt", "unreadable"]),
  autoApproved: z.boolean(),
});
export type PluginSourceTrust = z.infer<typeof pluginSourceTrustSchema>;
export type PackageIntegrity = PluginSourceTrust["integrity"];
const subset = (current: readonly string[], snapshot: readonly string[]) =>
  current.every((item) => snapshot.includes(item));
function loopbackWithin(
  current: PluginCapabilities["loopbackCallback"],
  snapshot: PluginCapabilities["loopbackCallback"],
): boolean {
  if (!current) return true;
  if (!snapshot || current.path !== snapshot.path) return false;
  const currentPorts = current.ports ?? "ephemeral";
  const snapshotPorts = snapshot.ports ?? "ephemeral";
  if (currentPorts === "ephemeral") return snapshotPorts === "ephemeral";
  return (
    Array.isArray(snapshotPorts) &&
    currentPorts.every((port) => snapshotPorts.includes(port))
  );
}
export function capabilitiesWithin(
  current: PluginCapabilities,
  snapshot: PluginCapabilities,
): boolean {
  return (
    (!current.serverCode || snapshot.serverCode) &&
    (!current.instanceScope || Boolean(snapshot.instanceScope)) &&
    (!current.secrets || Boolean(snapshot.secrets)) &&
    (!current.authProxy || Boolean(snapshot.authProxy)) &&
    (!current.scheduler || Boolean(snapshot.scheduler)) &&
    (!current.sandboxWorker || Boolean(snapshot.sandboxWorker)) &&
    loopbackWithin(current.loopbackCallback, snapshot.loopbackCallback) &&
    subset(current.appEvents ?? [], snapshot.appEvents ?? []) &&
    subset(current.appActions ?? [], snapshot.appActions ?? []) &&
    subset(current.flows ?? [], snapshot.flows ?? []) &&
    subset(current.providerSources ?? [], snapshot.providerSources ?? []) &&
    (
      ["tools", "actions", "services", "wires", "extensions", "forms"] as const
    ).every((key) => subset(current[key], snapshot[key])) &&
    current.hooks.every((hook) =>
      snapshot.hooks.some(
        (saved) =>
          saved.event === hook.event &&
          (saved.enforce ?? "normal") === (hook.enforce ?? "normal"),
      ),
    ) &&
    current.http.every((http) =>
      snapshot.http.some(
        (saved) =>
          saved.origin === http.origin && subset(http.methods, saved.methods),
      ),
    ) &&
    current.datasets.every((dataset) =>
      snapshot.datasets.some(
        (saved) =>
          saved.namespace === dataset.namespace &&
          subset(dataset.ops, saved.ops),
      ),
    )
  );
}
