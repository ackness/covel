### Changed

- **A plugin package must declare `"type": "module"` in its `package.json`.** `pnpm validate:plugin` and the ZIP and GitHub installers now refuse a package without it. Plugin packages were always ESM; without the line Node read the package's `.js` files as CommonJS, so an `import` failed and the development reload never picked up a change. The bundled plugins and both scaffolds already declare it. An existing package without the line needs it added.

### Fixed

- **`pnpm validate:world` also warns about an ID that is a UUID.** A field named `id`, or ending in `Id` / `Ids`, that holds a UUID is left out of what a model reads, like a write time. The `model-hidden-field` warning now reports it too and suggests a readable ID.
