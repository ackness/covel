### Breaking

- **FilterContainer rows now use `props.itemTemplate`.** Replace `itemComponent`, `itemPropMap` and `itemLiteralProps` with a catalog subtree and `$item` bindings. Bind `items` to a state array with `$state` or `$item`; `$index`, editable fields and nested repeats keep their original array positions after filtering. Existing session data does not need recreation.
- **The unused `contributes.ui.left` placement is removed.** Use `right` or `message`. Loading ignores unsupported placements with a warning; `validate:plugin` reports an unknown field. UI discovery and API responses no longer advertise or return `left`.

### Added

- **Filtered rows can combine layouts, buttons and badges.** Their templates use the normal json-render scope and action handlers, with shared static and runtime validation.
- **`$map` displays translatable labels for data values.** Translate labels and string fallbacks through plugin locale catalogs. Character trait type and category badges now use these labels.

### Documentation

- **The component catalog states its limits.** General tables, statistical charts, custom timers and animation, and unlisted icons use webviews; existing specialized tables, transitions and media remain available.
