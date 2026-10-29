### Added

- **Import SillyTavern character cards and lorebooks as a world.** Settings → Install & manage offers a data-only preview and import for V1/V2/V3 JSON cards, PNG cards and world-info JSON, with conversion reports, content cleaning and a metadata-free PNG cover. Extensions, scripts and executable macros are never run.

### Fixed

- **Imported creator notes stay out of model prompts.** Notes are omitted and reported; the world summary comes from the character description.
- **Lorebook activation rules survive import.** Lorebook-only worlds use a neutral premise without copying disabled or selective entries into world text.
- **Additional PNG images are reported as omitted.** The first PNG supplies the cover, and each later image gets its own source-specific report item.
