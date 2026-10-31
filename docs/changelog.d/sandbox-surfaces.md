### Added

- **Plugins can provide independently selected main and composer pages.** Both reuse content-bound capability consent and the existing public session bridge. Host return, Stop, permissions and interaction recovery remain outside sandbox frames, including narrow screens and immersive stage.
- **Broken pages restore only their affected region.** Inline and URL views have ready deadlines, fixed page-error reporting and visible-tab heartbeat recovery, with explicit consent-checked Retry.

### Changed

- **An explicit main replacement retains the host composer.** Independently selected composers also work in ordinary plugin views and stage, where duplicate input controls are suppressed. Selection remains local to the current visit; device consent persists.

- **Host view menus stay above replacement controls.** Normal document unload does not report a page error; uncaught errors and unhandled rejections still do.
