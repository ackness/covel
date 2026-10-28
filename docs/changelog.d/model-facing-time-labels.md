### Fixed

- **Time rules show multilingual names from portable world data.** Cycle and era names, phases and weekdays are resolved before display, including worlds without a package directory.
- **A record repeating its own UUID through arrays or nested fields stays bookkeeping.** Independently identified child records still preserve references to their parent; model-facing projection and hidden-field diagnostics share the rule.
- **Desktop build failures give usable workflow-ref guidance for SHA inputs.** Select a branch or tag pointing to the required commit; workflow dispatch does not accept a commit SHA as its ref.
