### Fixed

- **Story notes respect the story runtime's selected model budget.** The kernel now uses the same model resolution as agent execution, including session and request overrides, when limiting `story-context@1`. Each story reader uses its own budget; function stories use their default text role without agent overrides. See [story context](../reference/plugins.md#story-context).
