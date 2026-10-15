### Fixed

- **Submitted forms keep their saved values.** Empty or missing answers no longer read a live form draft. Development sessions without saved answers must be recreated and submitted again to retain them.
- **Plugin flow document links use discovery metadata.** Missing paths stay empty instead of guessing a runtime document location.

### Changed

- **Model lookup prices live only in `capability.pricing`.** `GET /api/model-db/lookup` no longer duplicates token prices directly under `capability`; clients must read the nested fields. No stored model data needs to be recreated.
