export interface DiagnosedError {
  title: string;
  detail: string;
  hint?: string;
}

export function diagnoseStartupError(err: unknown): DiagnosedError {
  const msg = err instanceof Error ? err.message : String(err);
  if (/EADDRINUSE|address already in use/i.test(msg)) {
    return {
      title: "Port conflict",
      detail: msg,
      hint: "Another process is using the required port. Close other Covel instances or restart your computer.",
    };
  }
  if (/EACCES|permission denied/i.test(msg)) {
    return {
      title: "Permission denied",
      detail: msg,
      hint: "Covel could not access a required directory. Check that the app has permission to write to its data folder.",
    };
  }
  if (/did not start within|timeout/i.test(msg)) {
    return {
      title: "Server timed out",
      detail: msg,
      hint: "The backend took too long to boot. Check the logs. A missing llm.toml or slow disk can cause this.",
    };
  }
  if (/ENOENT/i.test(msg)) {
    return {
      title: "Missing file",
      detail: msg,
      hint: "A required bundled file is missing. The installation may be corrupt — reinstall the app.",
    };
  }
  return { title: "Startup failed", detail: msg };
}
