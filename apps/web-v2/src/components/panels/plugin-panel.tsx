/**
 * PluginPanel — renders a single plugin panel from a json-render spec.
 *
 * Wraps <JSONUIProvider> + <Renderer> with the covel component registry
 * and injects pluginData as initial state.
 */

import { useMemo } from "react";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { nestedToFlat } from "@json-render/core";
import type { Spec } from "@json-render/core";
import { covelRegistry } from "@/lib/catalog.js";
import { usePluginNamespace } from "@/stores/plugin-data-store.js";

interface PluginPanelProps {
  pluginId: string;
  spec: Record<string, unknown>;
  onAction?: (actionName: string, params?: Record<string, unknown>) => void;
}

/**
 * Convert our JSON spec format (uses "component" key) to json-render's
 * nested format (uses "type" key), then flatten to Spec.
 */
function convertToSpec(view: unknown): Spec | null {
  if (!view || typeof view !== "object") return null;
  try {
    const nested = rewriteComponentToType(view as Record<string, unknown>);
    return nestedToFlat(nested);
  } catch (e) {
    console.warn("[PluginPanel] Failed to convert spec:", e);
    return null;
  }
}

/** Recursively rename "component" → "type" to match json-render's expected format. */
function rewriteComponentToType(node: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "component") {
      result.type = value;
    } else if (key === "children" && Array.isArray(value)) {
      result.children = value.map((child) => {
        if (typeof child === "object" && child !== null) {
          return rewriteComponentToType(child as Record<string, unknown>);
        }
        return child;
      });
    } else {
      result[key] = value;
    }
  }
  return result;
}

function resolveEmptyMessage(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const obj = value as Record<string, string>;
    const candidates = [obj["zh"], obj["zh-CN"], obj["en"], ...Object.values(obj)];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "string" && candidate.trim() !== "") {
        return candidate;
      }
    }
    return "";
  }
  return String(value);
}

export function PluginPanel({ pluginId, spec, onAction }: PluginPanelProps) {
  const namespace = (spec.dataSource as Record<string, string> | undefined)?.namespace ?? "default";
  const data = usePluginNamespace(pluginId, namespace);

  const initialState = useMemo(() => {
    const entries = Object.entries(data).map(([key, value]) => ({ key, value }));
    return { ...data, entries };
  }, [data]);

  const flatSpec = useMemo(() => convertToSpec(spec.view), [spec.view]);

  const handlers = onAction
    ? {
      apiCall: async (params: Record<string, unknown>) => { onAction("apiCall", params); },
      emitEvent: async (params: Record<string, unknown>) => { onAction("emitEvent", params); },
    }
    : undefined;

  if (!flatSpec) {
    return <p className="text-xs text-zinc-400 italic">Invalid panel spec</p>;
  }

  // Empty state: namespace has no data yet
  const isEmpty = Object.keys(data).length === 0;
  if (isEmpty) {
    const emptySpec = spec.emptyState as Record<string, unknown> | undefined;
    const customMsg = resolveEmptyMessage(emptySpec?.message);
    const label = resolveEmptyMessage(spec.label) || pluginId;
    const emptyMsg = customMsg || `${label} 暂无数据，等待游戏推进……`;
    return (
      <p className="text-xs text-zinc-400 italic text-center leading-relaxed px-4 pt-6">
        {emptyMsg}
      </p>
    );
  }

  return (
    <JSONUIProvider
      registry={covelRegistry}
      initialState={initialState}
      handlers={handlers}
    >
      <Renderer spec={flatSpec} registry={covelRegistry} />
    </JSONUIProvider>
  );
}
