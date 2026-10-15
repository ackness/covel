### Breaking

- **World packages no longer declare `schemaVersion`.** Remove it from `world.yaml`, `data/world.data.yaml`, and `world.data.override.yaml`; the current format has no version selector. Loading ignores unknown top-level fields, and `pnpm validate:world` warns about them, so existing packages still load. Source records, plugin contracts, and stored-data versions keep their own version fields. Existing worlds and sessions do not need to be recreated.
