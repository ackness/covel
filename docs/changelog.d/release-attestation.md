### Security

- **Release installers carry a build provenance attestation.** `gh attestation verify <file> --repo ackness/covel` confirms that a downloaded `.dmg`, `.zip` or `.exe` was built by this repository's release workflow, and from which commit. The installers stay unsigned; `SHA256SUMS.txt` is unchanged. Details: `docs/guide/desktop-packaging.md`.
