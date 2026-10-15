### Fixed

- **A model role that is not set up no longer shows as an error.** The prep screen and the session's plugin list said "Model role plugin is unavailable" for a role the player never defined, although the game runs it on the first text role. They now say "plugin is not set up; uses story · …"; a role that is defined but cannot be used is still reported.
- **Reply Variants is listed as calling a model.** It asks the fast role for alternative phrasings, and now declares that role, so its tag reads "Calls a model".
