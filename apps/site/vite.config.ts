import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// A static site: `vite build` writes `dist/`, which any static host serves.
// `SITE_BASE` is the path the site is served under: `/` by default, and
// `/covel/` for the GitHub Pages build (.github/workflows/site.yml).
export default defineConfig({
  base: process.env.SITE_BASE ?? "/",
  plugins: [react(), tailwindcss()],
  server: { port: 5174 },
});
