### Fixed

- **Connection tests and model lists use newly saved keys immediately.** Replacing or deleting a desktop key updates the same live key map used by turns, while preserving external environment keys and their precedence (F-033).

### Security

- **Listing saved key providers requires the configured desktop token.** `GET /api/config/keys` now uses the same guard as sensitive configuration routes (F-107).
- **Public hosted model catalogs hide gateway addresses.** `/api/presets` and `/api/llm-config` omit `baseUrl` unless the caller has operator access (F-108).
