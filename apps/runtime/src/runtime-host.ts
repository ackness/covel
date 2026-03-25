const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

export function resolveRuntimeListenConfig(env: Record<string, string | undefined>) {
  const parsedPort = Number(env.PORT ?? DEFAULT_PORT);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT;
  const host = typeof env.HOST === "string" && env.HOST.trim().length > 0
    ? env.HOST
    : DEFAULT_HOST;

  return {
    host,
    port
  };
}
