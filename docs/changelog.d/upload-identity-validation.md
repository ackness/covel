### Fixed

- **ZIP validation reports unresolved package identities as errors.** Invalid world filenames and flat plugins without a usable ID now return `identity-invalid` with `ok: false`, omitting the ID instead of inventing `package`. Manifest diagnostics remain separate.
