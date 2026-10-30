### Fixed

- **Invalid world dimension values can be corrected as input errors.** `update-dimensions` reports schema validation failures as `invalid-input` without reclassifying version conflicts or unexpected failures.
- **Successful tool audit output survives absent optional fields.** Audit serialization omits undefined object properties while preserving strict JSON validation and concealed-runtime boundaries.
