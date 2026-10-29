### Added

- **Plugins can provide full-column views.** Declare spec files in `contributes.ui.view`; players switch views in the session header and always retain host back controls.
- **Sandbox views can read a bounded session projection.** `bridge: session` requires explicit player consent bound to the plugin and the SHA-256 hash of its spec plus HTML, stored on the device and revocable from the view menu. Streaming text uses throttled appends.
- **World and pack defaults accept plugin views.** `defaultViewMode` supports `plugin:<pluginId>:<viewId>` with a host fallback and consent before mounting bridge views.
- **UI discovery includes views.** `GET /api/ui-specs` always returns a `view` array and reports rejected or duplicate views in diagnostics.

### Changed

- **View mode types include plugin modes.** `GameViewMode` now includes `PluginViewMode`, and `PluginDetail.ui.view` is required. Typed consumers must supply the new array; no session data needs recreation.
