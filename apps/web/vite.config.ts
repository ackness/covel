import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const RUNTIME_PROXY_PATHS = [
  "/actions",
  "/archives",
  "/commands",
  "/packages",
  "/presets",
  "/sessions",
  "/traces",
  "/worlds"
] as const;

export function resolveRuntimeProxyTarget(env: Record<string, string | undefined> = process.env): string {
  const host = env.RUNTIME_HOST?.trim() || "127.0.0.1";
  const port = env.RUNTIME_PORT?.trim() || "8787";
  return `http://${host}:${port}`;
}

export function createRuntimeProxyConfig(env: Record<string, string | undefined> = process.env) {
  const target = resolveRuntimeProxyTarget(env);

  return Object.fromEntries(
    RUNTIME_PROXY_PATHS.map((path) => [
      path,
      {
        target
      }
    ])
  );
}

export function resolveWorkspaceRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  plugins: [react()],
  server: {
    proxy: createRuntimeProxyConfig(),
    fs: {
      allow: [resolveWorkspaceRoot()]
    }
  },
  build: {
    outDir: fileURLToPath(new URL("../../dist/web", import.meta.url)),
    emptyOutDir: true
  }
});
