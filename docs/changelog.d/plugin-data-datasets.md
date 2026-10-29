### Added

- **A plugin can declare typed data datasets.** `contributes.datasets.<name>` names a plugin-data namespace and the JSON Schema its records satisfy, with an optional `key` field and the allowed operation kinds (`ops`, default all). Loading, `pnpm validate:plugin` and installation check the schema file, the `key` and the same-schema rule with `contributes.data`.
