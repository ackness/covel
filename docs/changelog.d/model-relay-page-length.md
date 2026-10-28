### Fixed

- **Shared deployments load the full page when local model relay is enabled.** Rewriting the page's connection policy now removes the static file's original content length from the response context, preventing truncated HTML and a blank screen. Personal and desktop deployments keep their existing policy.
