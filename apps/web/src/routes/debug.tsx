import { createFileRoute } from "@tanstack/react-router";
import { DebugRoutePage } from "./debug/-debug-route-page.js";

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
  return <DebugRoutePage sid={sid} />;
}
