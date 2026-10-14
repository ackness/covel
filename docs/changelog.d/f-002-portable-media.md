### Breaking

- **SQLite media paths are now relative to the media directory.** Development databases containing absolute `media_assets.path` values must be recreated. There is no migration or compatibility read. Back up the old database and media before recreating data.

### Fixed

- **Desktop “Copy my data” includes stored media.** The copy stages `media/` alongside `worlds/` before placing the database. Reads, repairs, new writes and deletions use the current media root after relocation. Backup instructions now include `media/`.

### Upgrade notes

- **Recover media omitted by an earlier copy manually.** If the old data root still exists, copy its `media/` directory into your backup before upgrading or recreating development data; copying the files alone does not convert an absolute-path database. If the old files were deleted and no backup exists, they cannot be recovered.
