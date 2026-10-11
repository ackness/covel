import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// A static site: `vite build` writes `dist/`, which any static host serves.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174 },
});
