export type JobStatusBadgeVariant =
  "default" | "secondary" | "destructive" | "outline";

export function compactJobId(
  id: string,
  options?: { maxLength?: number; prefixLength?: number },
): string {
  const maxLength = options?.maxLength ?? 10;
  if (id.length <= maxLength) return id;
  const prefixLength = Math.max(1, options?.prefixLength ?? maxLength - 2);
  return `${id.slice(0, prefixLength)}…`;
}

export function formatJobDuration(
  ms: unknown,
  options?: { emptyValue?: string; style?: "rounded" | "fixed" | "clock" },
): string {
  const emptyValue = options?.emptyValue ?? "";
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return emptyValue;
  }
  if (ms < 1000) return `${ms}ms`;
  if (options?.style === "fixed") return `${(ms / 1000).toFixed(1)}s`;
  if (options?.style === "clock") {
    const seconds = ms / 1000;
    return seconds < 60
      ? `${seconds.toFixed(1)}s`
      : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
  }
  return `${Math.round(ms / 1000)}s`;
}

export function jobStatusBadgeVariant(
  status: string | undefined,
): JobStatusBadgeVariant {
  if (status === "failed") return "destructive";
  if (status === "done" || status === "completed") return "default";
  if (status === "pending" || status === "running") return "secondary";
  return "outline";
}
