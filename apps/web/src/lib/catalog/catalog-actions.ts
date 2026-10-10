import type { CatalogAction } from "@covel/shared";
import { resolvePath, asRecord } from "./helpers.js";
import {
  postPluginRpcWithApproval,
  emitPluginRpcRuntimeResponse,
} from "@/components/session/plugin-rpc-ui.js";
import { requestConfirm } from "@/lib/confirm-channel.js";

/** Resolve only explicit selectors; ordinary payload strings remain literal. */
export function resolveCatalogPayload(
  value: unknown,
  scope: Record<string, unknown>,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => resolveCatalogPayload(item, scope));
  const record = asRecord(value);
  if (!record) return value;
  if (typeof record.from === "string" && Object.keys(record).length === 1)
    return resolvePath(scope, record.from);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      resolveCatalogPayload(item, scope),
    ]),
  );
}
export async function invokeCatalogAction(args: {
  sessionId: string;
  action: CatalogAction;
  scope: Record<string, unknown>;
  t: (key: string, options?: Record<string, unknown>) => string;
  prepare?: () => Promise<Record<string, unknown>>;
}): Promise<void> {
  let prepared: Record<string, unknown> | undefined;
  const response = await postPluginRpcWithApproval({
    sessionId: args.sessionId,
    pluginId: args.action.pluginId,
    actionLabel: args.action.runtimeId,
    confirm: requestConfirm,
    t: args.t,
    request: async () => {
      prepared ??= args.prepare ? await args.prepare() : {};
      return {
        kind: "runtime",
        pluginId: args.action.pluginId,
        runtimeId: args.action.runtimeId,
        payload: resolveCatalogPayload(args.action.payload, {
          ...args.scope,
          ...prepared,
        }) as Record<string, unknown>,
      };
    },
  });
  if (response)
    emitPluginRpcRuntimeResponse({
      response,
      runtimeId: args.action.runtimeId,
      t: args.t,
    });
}
export function catalogItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value))
    return value
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== null);
  const record = asRecord(value);
  return record
    ? Object.entries(record).flatMap(([key, value]) => {
        const item = asRecord(value);
        return item ? [{ ...item, key }] : [];
      })
    : [];
}
