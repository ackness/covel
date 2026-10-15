### Fixed

- **Function text calls use their declared model role by default.** Calls without `presetId` now use `function.model`; an explicit handler choice still wins. Session model overrides remain agent-only, and other generation capabilities keep their own roles.
- **Function model roles are visible before and during play.** The preparation screen and session plugin list show the declared role, resolved model, fallback label, and unavailable state as read-only text. See [Model roles](../reference/slots.md).
