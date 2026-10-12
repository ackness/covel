### Changed

- **The installers and the Docker image are about 95 MB smaller.** The portraits and scenes of the bundled worlds ship as WebP (lossy colour at quality 90, lossless alpha) instead of PNG, 77 MB down to 10 MB, and the PNG originals of gallery pictures stay in the repository without being packaged; the gallery already showed their WebP versions. `scripts/generate-portraits.mjs` and `scripts/generate-scenes.mjs` now write WebP and need `cwebp` (libwebp) on PATH; `scripts/encode-world-webp.mjs` converts a picture made elsewhere. Rules: `docs/guide/world-art-direction.md`.

### Upgrade notes

- **A session started before this version keeps the pictures it imported.** A new session imports the WebP files. A world of your own that ships PNG portraits or scenes still works: PNG remains an accepted format, and the `emit-presence` / `emit-scenes` scripts read both.
