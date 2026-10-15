### Changed

- **AI world creation offers every gameplay pack.** The "Player Experience" choices are now the packs of the server's catalogue (`packs/builtin.yaml`), with their own names and descriptions, so "Low Cost" and any pack added later can be chosen too; before, only two fixed choices existed. A pack's `defaultViewMode` is data of the pack: a world generated for "Dialogue Mode" opens on the stage because that pack says so, not because the generator knows its ID. `GET /api/framework/authoring` lists the catalogue in a new `packs` field, and `pnpm describe:authoring` prints it.

### Breaking

- **`POST /api/ai/generate-world` takes `brief.pack` instead of `brief.experienceMode`.** The value is the ID of a pack of the catalogue; an unknown ID returns `400`. A brief without `pack` names no pack: the world gets no `pluginPolicy.preset` (it used to get `traditional-story`). Documented in `docs/reference/api.md`.
