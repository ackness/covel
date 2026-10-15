### Fixed

- **World validation and import catch invalid dimension condition values.** Plugins declare candidate fields through `authoring.references.values`; story events now check equality and membership candidates against dimension schemas before any import writes.
- **In-game plugin toggle failures explain the problem in the UI language.** Known error codes have Chinese, English and Russian messages; unknown failures use a localized generic message, with the original server response retained in the details. Hyphenated plugin-resolution codes are preserved by the client.
