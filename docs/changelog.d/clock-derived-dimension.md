### Breaking

- **Emberback's Crownfire countdown has a new shape, so an Emberback development session made before this change must be created again.** `crownfire.stage` no longer has the member `passing`; the dimension has a new required field `frontPassed` (boolean) that the tracker sets when the narrative says the front has moved on. `minutesRemaining` and `stage` are computed from the station clock. A session keeps the definition it was created with, and that definition no longer matches the world. World version 1.2.0.

### Added

- **A world can declare that a dimension field is computed from the world clock, and code then computes it every turn.** A schema node takes `x-derive`: `source: clock.elapsedSinceStart`, a linear form (`start`, `perUnit`, optional `min` / `max`), and for a label an ordered list of `ranges`. The new function runtime `world-init/dimension-clock` reads the settled clock through `world-time-evolution@1`, after the time settlement and the tracker, and commits the value with a versioned `dimension.update`, in the same turn and without a model call. The value depends on the clock only, so a turn that is run again or a session forked from an earlier turn has the value of its clock. `pnpm validate:world` checks the declaration: where it may stand, the type, that every label is a value the field allows, that the bounds lie inside the field's `minimum` / `maximum`, and that `initialValue` is the value at the start. Reference: `docs/reference/dynamic-dimensions.md`.
- **The SDK exports the derivation helpers.** `@covel/plugin-handlers-utils/dimensions` has `applyDimensionDerivations`, `derivedDimensionFields`, `deriveDimensionValue`, `keepDerivedDimensionFields`, `dimensionSchemaWithoutDerived` and `dimensionValueWithoutDerived`. A schema in a `world.dimensions@1` snapshot can carry `x-derive`.

### Changed

- **The dimension tracker no longer settles a derived field.** The schema and the value that `world-init/dimension-tracker` is given leave derived fields out, its prompt says not to write them, and `update-dimensions` keeps the current value of a derived field whatever the model writes. `followsClock` stays for rules that depend on time and are not a derivation (Emberback's power drain per hour). Plugin `world-init` 0.0.37.
- **Emberback's storm countdown is computed, not calculated by a model.** `minutesRemaining` is 180 minus the minutes on the station clock since the start, and `stage` follows it by ranges. The prose rule that asked the tracker for the subtraction is gone.
