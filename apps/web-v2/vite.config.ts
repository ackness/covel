import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("./", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  plugins: [tailwindcss(), react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: `http://${process.env.RUNTIME_HOST?.trim() || "127.0.0.1"}:${process.env.RUNTIME_PORT?.trim() || "3001"}`,
      },
    },
    fs: {
      allow: [fileURLToPath(new URL("../../", import.meta.url))],
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../../dist/web-v2", import.meta.url)),
    emptyOutDir: true,
  },
});
