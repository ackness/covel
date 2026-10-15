### Fixed

- **Generated worlds can finish setup after character schema generation.** The world initialization output contract no longer requires the completion signal that the kernel separates from business output. The contract still validates both generated and author-provided schemas; see `docs/reference/plugins.md`.
