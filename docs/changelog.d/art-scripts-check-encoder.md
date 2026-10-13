### Fixed

- **The world art scripts no longer lose a paid picture when `cwebp` is missing.** `scripts/generate-portraits.mjs` and `scripts/generate-scenes.mjs` asked the image provider for a picture and only then found that the WebP encoder was not installed, so the picture was paid for and discarded. They now check for `cwebp` before the first request and stop with the install hint.
