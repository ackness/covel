### Fixed

- **Bundled worlds refresh even before a user worlds directory exists.** Missing directories count as empty inventories.
- **Failed dimension reads preserve the last complete world.** Startup and hot reload reject incomplete dimension sources without sending a dimension-change notice.
- **Dimension and gallery translations follow the declared locale names.** Bare-language overlay files reported as ignored are no longer compiled into catalog or session data.
