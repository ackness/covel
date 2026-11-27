import type {
  ConfigFlowRunSnapshot,
  ProviderSourceSummary,
  ProviderSourceUsageSummary,
} from "@covel/shared/platform";
import {
  ensureDesktopRestToken,
  getDesktopRestAuthHeaders,
} from "@/lib/desktop-bridge.js";
import { request, type JsonRequestOptions } from "./request.js";

export type {
  ConfigFlowField,
  ConfigFlowRunSnapshot,
  ConfigFlowStep,
  ConfigFlowStepKind,
  ProviderSourceAccountSummary,
  ProviderSourceCredentialStatus,
  ProviderSourceSummary,
  ProviderSourceUsageSummary,
} from "@covel/shared/platform";

export interface PluginInstanceDataEntry {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: string;
}

const PLATFORM_READ_OPTIONS = {
  operatorAuth: true,
  silentErrors: true,
  retry: false,
} as const;

const PLATFORM_WRITE_OPTIONS = {
  operatorAuth: true,
  silentErrors: true,
} as const;

async function platformRequest<T>(
  url: string,
  options: JsonRequestOptions<T>,
): Promise<T> {
  await ensureDesktopRestToken();
  const desktopHeaders = getDesktopRestAuthHeaders();
  const mergedHeaders =
    options.headers !== undefined
      ? {
          ...desktopHeaders,
          ...Object.fromEntries(new Headers(options.headers).entries()),
        }
      : desktopHeaders;
  return request<T>(url, {
    ...options,
    headers: mergedHeaders,
  });
}

function flowBasePath(pluginId: string, flowId: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/flows/${encodeURIComponent(flowId)}`;
}

function flowRunPath(pluginId: string, flowId: string, runId: string): string {
  return `${flowBasePath(pluginId, flowId)}/runs/${encodeURIComponent(runId)}`;
}

export async function invokePluginAppAction<T = unknown>(
  pluginId: string,
  action: string,
  input?: Record<string, unknown>,
): Promise<{ ok: true; result: T }> {
  return platformRequest<{ ok: true; result: T }>(
    `/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(action)}`,
    {
      ...PLATFORM_WRITE_OPTIONS,
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function fetchPluginInstanceData(
  pluginId: string,
  namespace: string,
  signal?: AbortSignal,
): Promise<{ ok: true; entries: PluginInstanceDataEntry[] }> {
  return platformRequest<{ ok: true; entries: PluginInstanceDataEntry[] }>(
    `/api/plugins/${encodeURIComponent(pluginId)}/instance-data/${encodeURIComponent(namespace)}`,
    signal ? { ...PLATFORM_READ_OPTIONS, signal } : PLATFORM_READ_OPTIONS,
  );
}

export async function startPluginConfigFlow(
  pluginId: string,
  flowId: string,
  initial?: Record<string, unknown>,
): Promise<{ ok: true; run: ConfigFlowRunSnapshot }> {
  return platformRequest<{ ok: true; run: ConfigFlowRunSnapshot }>(
    `${flowBasePath(pluginId, flowId)}/start`,
    {
      ...PLATFORM_WRITE_OPTIONS,
      method: "POST",
      body: JSON.stringify(initial !== undefined ? { initial } : {}),
    },
  );
}

export async function getPluginConfigFlowRun(
  pluginId: string,
  flowId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<{ ok: true; run: ConfigFlowRunSnapshot }> {
  return platformRequest<{ ok: true; run: ConfigFlowRunSnapshot }>(
    flowRunPath(pluginId, flowId, runId),
    signal ? { ...PLATFORM_READ_OPTIONS, signal } : PLATFORM_READ_OPTIONS,
  );
}

export async function stepPluginConfigFlow(
  pluginId: string,
  flowId: string,
  runId: string,
  input: {
    readonly stepId: string;
    readonly data?: Record<string, unknown>;
    readonly callbackUrl?: string;
    readonly cancelled?: boolean;
  },
): Promise<{ ok: true; run: ConfigFlowRunSnapshot }> {
  return platformRequest<{ ok: true; run: ConfigFlowRunSnapshot }>(
    `${flowRunPath(pluginId, flowId, runId)}/step`,
    {
      ...PLATFORM_WRITE_OPTIONS,
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function cancelPluginConfigFlow(
  pluginId: string,
  flowId: string,
  runId: string,
): Promise<{ ok: true; run: ConfigFlowRunSnapshot }> {
  return platformRequest<{ ok: true; run: ConfigFlowRunSnapshot }>(
    flowRunPath(pluginId, flowId, runId),
    {
      ...PLATFORM_WRITE_OPTIONS,
      method: "DELETE",
    },
  );
}

export async function fetchProviderSources(): Promise<{
  sources: ProviderSourceSummary[];
}> {
  return platformRequest<{ sources: ProviderSourceSummary[] }>(
    "/api/provider-sources",
    PLATFORM_READ_OPTIONS,
  );
}

export async function fetchProviderSourceUsage(
  pluginId: string,
  sourceId: string,
  accountId?: string,
): Promise<{ usage: ProviderSourceUsageSummary | null }> {
  const qs = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
  return platformRequest<{ usage: ProviderSourceUsageSummary | null }>(
    `/api/provider-sources/${encodeURIComponent(pluginId)}/${encodeURIComponent(sourceId)}/usage${qs}`,
    PLATFORM_READ_OPTIONS,
  );
}
