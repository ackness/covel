### Breaking

- **`GameViewMode` includes plugin view modes, and `PluginDetail.ui.view` is required.** `GameViewMode` now includes `PluginViewMode`; typed consumers of `PluginDetail` must supply the new `ui.view` array. No session data needs recreation.

### Added

- **Plugins can provide full-column views.** Declare spec files in `contributes.ui.view`; players switch views in the session header and always retain host back controls.
- **Sandbox views can read a bounded session projection.** `bridge: session` requires explicit player consent bound to the plugin and the SHA-256 hash of its spec plus HTML, stored on the device and revocable from the view menu.
- **World and pack defaults accept plugin views.** `defaultViewMode` supports `plugin:<pluginId>:<viewId>` with a host fallback and consent before mounting bridge views.
- **UI discovery includes views.** `GET /api/ui-specs` always returns a `view` array and reports rejected or duplicate views in diagnostics.
