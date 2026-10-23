### Fixed

- **SQLite vector search stays available in the Alpine Docker image.** The image preloads its installed glibc compatibility library so `sqlite-vec` can resolve its required symbols under musl. An offline build check loads the extension as the runtime user and fails the build if it cannot load.

### Documentation

- **Deployment guidance now distinguishes personal instances from hosted demos.** The Render blueprint explains that it starts an operator-controlled service, without public sign-in or anonymous session creation. The API reference also clarifies the desktop-token and browser-private exceptions to personal-instance authentication; server behavior is unchanged.
