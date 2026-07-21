import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

const RUNTIME_PROXY_PATHS = ["/api"] as const;

const RUNTIME_NOT_READY_BODY = JSON.stringify({
  error: "runtime server not ready",
});

/**
 * The runtime server (3001) boots a few seconds after Vite. Until it's up,
 * proxied `/api/*` requests hit ECONNREFUSED — Vite's default handler answers
 * with a 500 or resets the socket, so the first page load fails and the user
 * has to reload. Answer with a clean 503 ("backend not ready") instead: the
 * frontend `request()` helper retries idempotent GETs on 503, so the first load
 * simply waits for the server to finish booting — no manual reload needed.
 */
function configureRuntimeProxy(proxy: {
  on(
    event: "error",
    handler: (err: Error, req: unknown, res: unknown) => void,
  ): void;
}): void {
  proxy.on("error", (_err, _req, res) => {
    const response = res as Partial<ServerResponse>;
    if (typeof response.writeHead === "function" && !response.headersSent) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end?.(RUNTIME_NOT_READY_BODY);
    }
  });
}

function readEnvString(
  name: string,
  fallback: string,
  env: Record<string, string | undefined>,
): string {
  const value = env[name];
  return value === undefined || value === "" ? fallback : value;
}

function readEnvInt(
  name: string,
  fallback: number,
  env: Record<string, string | undefined>,
): number {
  const raw = readEnvString(name, "", env);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function resolveRuntimeProxyTarget(
  env: Record<string, string | undefined> = process.env,
): string {
  const host = readEnvString("RUNTIME_HOST", "127.0.0.1", env);
  const port = readEnvInt("RUNTIME_PORT", 3001, env);
  return `http://${host}:${port}`;
}

export function createRuntimeProxyConfig(
  env: Record<string, string | undefined> = process.env,
): Record<string, ProxyOptions> {
  const target = resolveRuntimeProxyTarget(env);
  const entry: ProxyOptions = { target, configure: configureRuntimeProxy };

  return Object.fromEntries(RUNTIME_PROXY_PATHS.map((path) => [path, entry]));
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
      allow: [resolveWorkspaceRoot()],
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../../dist/web", import.meta.url)),
    emptyOutDir: true,
    // Bundle budget: warn (don't fail) when any chunk exceeds 600 kB raw.
    // The main chunk currently sits ~350 kB raw after manualChunks; bumping
    // this floor higher would hide regressions, lower would noise on
    // every CI run.
    chunkSizeWarningLimit: 600,
    rolldownOptions: {
      output: {
        // Stage 6 (audit): split heavy vendors and feature surfaces out of
        // the main chunk so the first-paint critical path doesn't ship
        // dependencies the homepage / session view never touches.
        //
        // Naming convention:
        //   - `react-vendor`: React + react-dom (always needed at root)
        //   - `router-vendor`: TanStack Router (always needed at root)
        //   - `i18n-vendor`: i18next + react-i18next (used everywhere)
        //   - `markdown-vendor`: react-markdown + remark/rehype (lazy on
        //                       message render)
        //   - `graph-vendor`: react-force-graph + three (debug page only)
        //   - `motion-vendor`: framer-motion (animation surfaces)
        //   - `tanstack-query-vendor`: TanStack Query
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          // Match against the path AFTER node_modules/ to be resilient to
          // pnpm's `.pnpm/<pkg>@<ver>/node_modules/<pkg>/` layout.
          const after = id.split("node_modules/").pop() ?? "";
          if (
            /^(?:\.pnpm\/[^/]+\/node_modules\/)?(react|react-dom|scheduler)\//.test(
              after,
            )
          ) {
            return "react-vendor";
          }
          if (/(?:^|\/)@tanstack\/(?:react-)?router/.test(after)) {
            return "router-vendor";
          }
          if (/(?:^|\/)@tanstack\/(?:react-)?query/.test(after)) {
            return "tanstack-query-vendor";
          }
          if (
            /(?:^|\/)(react-i18next|i18next|i18next-browser-languagedetector)\//.test(
              after,
            )
          ) {
            return "i18n-vendor";
          }
          if (
            /(?:^|\/)(react-markdown|remark-|rehype-|hast-util|mdast-util|micromark)/.test(
              after,
            )
          ) {
            return "markdown-vendor";
          }
          if (/(?:^|\/)(react-force-graph|three|d3-)/.test(after)) {
            return "graph-vendor";
          }
          if (/(?:^|\/)(framer-motion|motion)\//.test(after)) {
            return "motion-vendor";
          }
          // json-render engine (core + react bindings) — drives every plugin
          // panel and the message surface, so it can't be lazy, but peeling it
          // into its own chunk trims the main bundle and lets it load in
          // parallel (M-03 bundle budget).
          if (/(?:^|\/)@json-render\//.test(after)) {
            return "json-render-vendor";
          }
          // Radix primitives (dialog/tabs/scroll-area/…) + the umbrella
          // Radix UI packages — shared across screens.
          if (/(?:^|\/)@radix-ui\//.test(after)) {
            return "radix-vendor";
          }
          // Schema / serialization libs used at panel + form boundaries.
          if (/(?:^|\/)(zod|yaml)\//.test(after)) {
            return "forms-vendor";
          }
          return undefined;
        },
      },
    },
  },
});
