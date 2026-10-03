#!/usr/bin/env node
/**
 * build — run `vite build` as a production build.
 *
 * Vite reads the workspace-root `.env` (see `envDir` in vite.config.ts), and
 * that file is the server's development config: `.env.example` ships
 * `NODE_ENV=development`. When the process has no NODE_ENV of its own, Vite
 * takes that value and emits a development bundle (`import.meta.env.DEV`,
 * React's dev JSX transform), which then ends up in a locally packaged
 * desktop app. A NODE_ENV exported in the shell still wins.
 */
import { build } from "vite";

process.env.NODE_ENV ??= "production";

await build();
