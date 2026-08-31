import { lazy, Suspense } from "react";
import type { Spec } from "@json-render/core";

const JsonRenderDevtools = import.meta.env.DEV
  ? lazy(async () => {
      const module = await import("@json-render/devtools-react");
      return { default: module.JsonRenderDevtools };
    })
  : null;

/**
 * Development-only inspector for the currently active plugin panel. The
 * dynamic import keeps the inspector implementation out of production chunks.
 */
export function PluginJsonRenderDevtools({ spec }: { spec: Spec }) {
  if (!JsonRenderDevtools) return null;

  return (
    <Suspense fallback={null}>
      <JsonRenderDevtools spec={spec} position="right" reserveSpace={false} />
    </Suspense>
  );
}
