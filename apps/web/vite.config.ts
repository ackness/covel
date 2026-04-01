import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [
    TanStackRouterVite({ quoteStyle: "double" }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/worlds": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/sessions": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/actions": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/commands": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/packages": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/presets": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/health": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
