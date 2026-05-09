import type { I18nText } from "@covel/shared";
import { request } from "./request.js";

// -- Trace API -------------------------------------------------

export interface TraceEvent {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface TurnTrace {
  turnId: string;
  flowId: string;
  traceId: string;
  startedAt: string;
  completedAt: string;
  eventCount: number;
  events: TraceEvent[];
}

export interface PluginDataKeyIndex {
  key: string;
  createdAt: string;
  updatedAt: string;
  valueType: string;
}

export interface PluginDataNamespaceIndex {
  namespace: string;
  count: number;
  latestUpdatedAt?: string;
  keys: PluginDataKeyIndex[];
}

export interface PluginDataDiscoveryIndex {
  pluginId: string;
  namespaces: PluginDataNamespaceIndex[];
}

export interface PluginContract {
  id: string;
  name: I18nText | unknown;
  description?: I18nText | unknown;
  pluginType?: string;
  runtimeCount?: number;
  status?: string;
  source?: string;
  capabilities?: string[];
  declaredPluginDataNamespaces?: string[];
  tools?: {
    builtin?: string[];
    local?: Array<{ runtimeId: string; path: string; name: string }>;
  };
  rpc?: Array<Record<string, unknown>>;
  ui?: {
    right?: Array<{ runtimeId: string; path: string }>;
    message?: Array<{ runtimeId: string; path: string }>;
    left?: Array<{ runtimeId: string; path: string }>;
  };
  runtimes?: Array<Record<string, unknown>>;
  dataSchemas?: Record<string, unknown>;
}

export interface TraceDiscovery {
  framework: Record<string, unknown>;
  plugins: PluginContract[];
  pluginData: PluginDataDiscoveryIndex[];
}

export async function fetchTraceEvents(sessionId: string): Promise<{
  sessionId: string;
  count: number;
  discovery?: TraceDiscovery;
  events: TraceEvent[];
}> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}`);
}

export async function fetchTraceTurns(sessionId: string): Promise<{
  sessionId: string;
  turnCount: number;
  discovery?: TraceDiscovery;
  turns: TurnTrace[];
}> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}/turns`);
}
