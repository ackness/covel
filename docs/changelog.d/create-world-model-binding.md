### Fixed

- **AI world creation and revision honor the player's model bindings.** Authoring uses the `story` role by default; API callers can select another role or preset. Every generated part, retry, and repair keeps the selected role and request-scoped provider keys.
