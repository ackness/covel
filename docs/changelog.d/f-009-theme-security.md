### Fixed

- **Themes cannot probe saved API keys through CSS selectors or load resources from arbitrary hosts (F-009).** Credential inputs no longer render saved values or reflect new drafts into HTML attributes. Page CSP restricts CSS images, fonts and styles in web and desktop, including development mode. See `docs/internals/security.md`.

### Breaking

- **Remote theme resources no longer load directly.** Reimport background images to embed them, or use local resources; remote fonts must be replaced. Theme imports and appearance edits download HTTPS raster images with CORS support, up to 5 MiB each. Allowed Markdown images use the same download path, so an image from a host that does not allow cross-origin reads (CORS) no longer shows, even after the player allows it. Existing settings backups do not download remote resources automatically. See `docs/reference/theme-packages.md`.
