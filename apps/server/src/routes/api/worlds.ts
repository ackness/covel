/**
 * API World routes — list, get, create/update worlds, dimension import/export,
 * and session worldData sync.
 *
 * Thin composition root. Handlers live in `worlds/`:
 *   - `worlds/crud.ts`      — list / get / create / patch / delete.
 *   - `worlds/dimensions.ts`— dimensions export / import.
 *   - `worlds/data-sync.ts` — world-data preflight / sync-data / sync-dimensions.
 *   - `worlds/translate.ts` — add an edition of a world in another language.
 *   - `worlds/gallery.ts`   — the images a world package ships.
 *   - `worlds/shared.ts`    — shared Env type + metadata/entry helpers.
 *
 * Mount order: the data-sync and dimensions sub-paths are registered before the
 * CRUD `/:id` routes so the more specific paths win.
 */

import { Hono } from "hono";
import { type WorldEnv } from "./worlds/shared.js";
import { worldDataSyncRoutes } from "./worlds/data-sync.js";
import { worldDimensionRoutes } from "./worlds/dimensions.js";
import { worldPluginPlanRoutes } from "./worlds/plugin-plan.js";
import { worldCrudRoutes } from "./worlds/crud.js";
import { worldTranslateRoutes } from "./worlds/translate.js";
import { worldGalleryRoutes } from "./worlds/gallery.js";

export const worldRoutes = new Hono<WorldEnv>();

worldRoutes.route("/", worldDataSyncRoutes);
worldRoutes.route("/", worldDimensionRoutes);
worldRoutes.route("/", worldPluginPlanRoutes);
worldRoutes.route("/", worldTranslateRoutes);
worldRoutes.route("/", worldGalleryRoutes);
worldRoutes.route("/", worldCrudRoutes);
