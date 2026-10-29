### Added

- **Plugin views can serve multi-file pages.** A view can declare `webview.root` and an HTML entry, load classic scripts, styles, images and fonts from a public digest URL, and use the existing session bridge after content-bound player consent. Failed pages show Retry and distinguish expired URLs from other load failures.

### Security

- **The API refuses requests from opaque or embedded pages.** All `/api` methods reject `Origin: null` and iframe, frame, embed or object destinations before CORS. Plugin page files are limited to an indexed root, checked again when served, and delivered under response CSP without credentials or CORS allow headers.
