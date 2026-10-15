### Fixed

- **New players no longer inherit a lore character's name and biography from generated schema defaults.** World initialization clears generated biography defaults, and player creation uses the submitted name for declared text name attributes. Both schema-generation prompt languages explain that defaults belong to a new, unnamed character. World Dimensions is now 0.0.42 and Character Creator is 0.0.41; see `docs/reference/tools.md`.
