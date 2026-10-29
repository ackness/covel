### Breaking

- **A story runtime can no longer depend on another plugin.** A runtime with `io.visibility: story` must set `required: false` on every contract input (the default `true` is rejected), cannot list a contract in `schedule.needs`, and its package cannot list a plugin contract in the root `requires`. Community story plugins that did any of these no longer load: set `required: false`, move the contract out of `needs` (use `schedule.after` to order only), and drop the `requires` entry. Kernel extension contracts are exempt. Rule: `docs/reference/plugins.md`.

### Changed

- **Dialogue Narrator (`chat-mode-narrator`) works without Scene Stage.** It no longer requires `scene-cast@1`, `scene-stage@1` or `scene-prompts@1`, so it is no longer turned off when those plugins are missing. Without a stage it narrates as plain dialogue. The Dialogue Mode pack still includes Scene Stage.
