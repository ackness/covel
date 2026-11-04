### Added

- **Plugin views can serve multi-file pages.** A view can declare `webview.root` and an HTML entry, load classic scripts, styles and images from a public digest URL, embed fonts as data: URIs, and use the existing session bridge after content-bound player consent. Entry HTML revalidates (`no-cache` with a bridge-aware ETag) while other assets keep immutable caching. Failed pages show Retry and distinguish expired URLs from other load failures.

### Security

- **The API refuses requests from opaque or embedded pages.** All `/api` methods reject `Origin: null` and iframe, frame, embed or object destinations before CORS. Plugin page files are limited to an indexed root, checked again when served, and delivered under response CSP without credentials or CORS allow headers.
