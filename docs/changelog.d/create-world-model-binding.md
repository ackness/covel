### Fixed

- **AI world creation and revision honor the player's model bindings.** Authoring uses the `utility` role by default, including the request-bound text fallback when that role is undefined. Every generated part, retry, and repair keeps the selected role and request-scoped provider keys.
