import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { fileURLToPath } from "node:url";

const RUNTIME_PROXY_PATHS = [
  "/api",
] as const;

function readEnvString(name: string, fallback: string, env: Record<string, string | undefined>): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

function readEnvInt(name: string, fallback: number, env: Record<string, string | undefined>): number {
  const raw = readEnvString(name, "", env);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveRuntimeProxyTarget(env: Record<string, string | undefined> = process.env): string {
  const host = readEnvString("RUNTIME_HOST", "127.0.0.1", env);
  const port = readEnvInt("RUNTIME_PORT", 3001, env);
  return `http://${host}:${port}`;
}

export function createRuntimeProxyConfig(env: Record<string, string | undefined> = process.env) {
  const target = resolveRuntimeProxyTarget(env);

  return Object.fromEntries(
    RUNTIME_PROXY_PATHS.map((path) => [
      path,
      { target }
    ])
  );
}

export function resolveWorkspaceRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [TanStackRouterVite(), tailwindcss(), react()],
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
