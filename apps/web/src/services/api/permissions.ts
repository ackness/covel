import type {
  I18nText,
  PluginCapabilities,
  ServerSettingSource,
} from "@covel/shared";
import type {
  CapabilityCeiling,
  CapabilityDefinition,
  CapabilityKey,
  EffectiveCapabilityState,
  PermissionsPolicyOverrides,
  PluginGrantDecisions,
  PluginGrantRecord,
  PluginGrantStatus,
} from "@covel/shared/permissions";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";
import { request } from "./request.js";

export interface PermissionsSnapshot {
  readonly deploymentForm: "personal" | "browser-private" | "hosted";
  readonly capabilities: Readonly<Record<CapabilityKey, CapabilityCeiling>>;
  readonly policy: {
    readonly overrides: PermissionsPolicyOverrides;
    readonly effective: Readonly<
      Record<CapabilityKey, EffectiveCapabilityState>
    >;
    readonly source: ServerSettingSource;
    readonly settable: boolean;
  };
  readonly catalog: Readonly<Record<CapabilityKey, CapabilityDefinition>>;
}

export interface PermissionPluginSummary {
  readonly pluginId: string;
  readonly name: I18nText;
  readonly version: string;
  readonly source: "builtin" | "community";
  readonly executionMode: "declarative" | "code" | "unknown";
  readonly tier: 0 | 3;
  readonly contentDigest: string | null;
  readonly integrity:
    "builtin" | "verified" | "modified" | "no-receipt" | "unreadable";
  readonly trustedSource: boolean;
  readonly sourceAutoApproved: boolean;
  readonly capabilities: PluginCapabilities | null;
  readonly grantStatus: PluginGrantStatus | "builtin";
  readonly grant: PluginGrantRecord | null;
  readonly effectiveCapabilities: Readonly<
    Record<CapabilityKey, EffectiveCapabilityState>
  >;
}

export function getPermissionsSnapshot(
  signal?: AbortSignal,
): Promise<PermissionsSnapshot> {
  return request<PermissionsSnapshot>("/api/permissions/snapshot", {
    signal,
    silentErrors: true,
    retry: false,
  });
}

export function updatePermissionsPolicy(
  policy: PermissionsPolicyOverrides | null,
): Promise<PermissionsSnapshot> {
  return request<PermissionsSnapshot>("/api/permissions/policy", {
    method: "PUT",
    headers: getDesktopRestAuthHeaders(),
    body: JSON.stringify({ policy }),
    operatorAuth: true,
  });
}

export async function listPermissionPlugins(
  signal?: AbortSignal,
): Promise<PermissionPluginSummary[]> {
  const response = await request<{ items: PermissionPluginSummary[] }>(
    "/api/permissions/plugins",
    {
      signal,
      headers: getDesktopRestAuthHeaders(),
      operatorAuth: true,
      silentErrors: true,
      retry: false,
    },
  );
  return response.items;
}

export async function setPluginGrants(
  pluginId: string,
  body: {
    readonly decisions: PluginGrantDecisions;
    readonly expectedDigest?: string;
  },
): Promise<PermissionPluginSummary> {
  const response = await request<{
    ok: boolean;
    plugin: PermissionPluginSummary;
  }>(`/api/permissions/plugins/${encodeURIComponent(pluginId)}/grants`, {
    method: "PUT",
    headers: getDesktopRestAuthHeaders(),
    body: JSON.stringify(body),
    operatorAuth: true,
  });
  return response.plugin;
}

export function deletePluginGrants(pluginId: string): Promise<{
  readonly ok: boolean;
  readonly pluginId: string;
  readonly revokedSessionGrants: number;
}> {
  return request<{
    ok: boolean;
    pluginId: string;
    revokedSessionGrants: number;
  }>(`/api/permissions/plugins/${encodeURIComponent(pluginId)}/grants`, {
    method: "DELETE",
    headers: getDesktopRestAuthHeaders(),
    operatorAuth: true,
  });
}
