### Fixed

- **Desktop package management explains failed restart checks and offers a retry.** Restart stays unavailable while desktop information is loading or failed, and becomes available after a successful check in a packaged app.
- **Desktop resource validation also checks the preload bundle.** Builds, packaged ASAR checks, and managed backend launches reject missing or mismatched preload bytes alongside the main bundle. Rebuild the complete desktop package; existing saves do not need recreation. These digests detect mixed or damaged builds and do not provide publisher signing or trusted-root tamper protection.
