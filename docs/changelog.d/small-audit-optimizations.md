### Security

- **Image uploads are checked by their bytes.** `POST /api/media` now requires the body to start with a PNG, JPEG, GIF, WebP, AVIF or BMP header and stores the type the bytes declare, so a file labelled `image/png` that is really markup or script is refused with 400.
