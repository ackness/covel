### Fixed

- **Startup failures show recovery controls even when the splash loads slowly.** The desktop shell waits for the splash to load before delivering the error.

### Security

- **Sensitive desktop IPC rejects child frames.** Reading keys or the REST token and changing settings requires a trusted main frame.

### Documentation

- **Desktop key storage documentation now describes the IPC path.** The UI receives plaintext keys in memory; the provider-list markers belong to the optional REST transport.
