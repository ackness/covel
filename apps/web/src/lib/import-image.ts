const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Explicit application download, never a CSS-triggered resource request. */
export async function importImage(url: string): Promise<string> {
  const source = new URL(url, window.location.href);
  if (source.protocol !== "https:" || source.username || source.password) {
    throw new Error("Images require an HTTPS URL without credentials.");
  }
  const response = await fetch(source.href, {
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(15_000),
  });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (
    !response.ok ||
    !type ||
    !/^image\/(png|jpeg|webp|gif|avif)$/.test(type)
  ) {
    throw new Error("Image download failed: expected a raster image.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Image download has no body.");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds 5 MiB.");
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const blob = new Blob(chunks, { type });
  return new Promise((resolve, reject) => {
    const fileReader = new FileReader();
    fileReader.onload = () => resolve(String(fileReader.result));
    fileReader.onerror = () =>
      reject(new Error("Cannot read downloaded image."));
    fileReader.readAsDataURL(blob);
  });
}

/** Import literal HTTPS url() images once. CSP blocks all remaining remote
 * CSS resources, including escaped URLs and image-set() string sources.
 */
export async function importCssImages(css: string): Promise<string> {
  const urls = [
    ...css.matchAll(
      /url\(\s*(?:"(https:\/\/[^"\n]+)"|'(https:\/\/[^'\n]+)'|(https:\/\/[^\s)]+))\s*\)/gi,
    ),
  ];
  const downloaded = new Map<string, string>();
  let result = css;
  for (const match of urls) {
    const url = match[1] ?? match[2] ?? match[3];
    if (!url) continue;
    let data = downloaded.get(url);
    if (!data) {
      data = await importImage(url);
      downloaded.set(url, data);
    }
    result = result.replace(match[0], `url("${data}")`);
  }
  return result;
}
