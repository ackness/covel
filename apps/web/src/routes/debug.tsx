import { Suspense, lazy } from "react";
import { createFileRoute } from "@tanstack/react-router";

// Lazy-load the debug page tree (trace/cost/session panels, ~a dozen modules)
// so it never lands in the main app chunk — /debug is a dev-only surface the
// homepage and session view never touch. See R-18 (main-chunk trimming).
const DebugRoutePage = lazy(() =>
  import("./debug/-debug-route-page.js").then((m) => ({
    default: m.DebugRoutePage,
  })),
);

export interface DebugSearchParams {
  sid?: string;
}

export function validateDebugSearch(
  search: Record<string, unknown>,
): DebugSearchParams {
  return {
    sid: typeof search.sid === "string" ? search.sid : undefined,
  };
}

export const Route = createFileRoute("/debug")({
  component: DebugPage,
  validateSearch: validateDebugSearch,
});

function DebugPage() {
  const { sid } = Route.useSearch();
  return (
    <Suspense fallback={null}>
      <DebugRoutePage sid={sid} />
    </Suspense>
  );
}
