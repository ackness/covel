### Added

- **Plugin views can serve multi-file pages.** A view can declare `webview.root` and an HTML entry, load classic scripts, styles and images from a public digest URL, embed fonts as data: URIs, and use the existing session bridge after content-bound player consent. Failed pages show Retry and distinguish expired URLs from other load failures.

### Fixed

- **Plugin page HTML revalidates after host upgrades.** Entry responses use `no-cache` and a bridge-aware ETag; other assets retain immutable caching. Font files remain publishable, but custom page fonts must use embedded data: URIs because opaque-origin URL font requests require CORS permission, which the asset route does not grant.

### Security

- **The API refuses requests from opaque or embedded pages.** All `/api` methods reject `Origin: null` and iframe, frame, embed or object destinations before CORS. Plugin page files are limited to an indexed root, checked again when served, and delivered under response CSP without credentials or CORS allow headers.
