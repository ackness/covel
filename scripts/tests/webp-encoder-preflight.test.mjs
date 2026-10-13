import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertWebpEncoder } from "../lib/webp-image.mjs";

const scripts = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("a missing WebP encoder is reported with how to install it", async () => {
  await assert.rejects(
    assertWebpEncoder("covel-no-such-encoder"),
    /cwebp is not installed; install libwebp/,
  );
});

// A generator pays for a picture and then encodes it, so the check must come
// before the first request.
for (const script of ["generate-portraits.mjs", "generate-scenes.mjs"]) {
  test(`${script} checks the encoder before it requests a picture`, async () => {
    const source = await readFile(path.join(scripts, script), "utf8");
    const check = source.indexOf("await assertWebpEncoder()");
    const request = source.indexOf("await fetchImageBytes(");
    assert.ok(check > 0, "the encoder check is missing");
    assert.ok(check < request, "the encoder check comes after the request");
  });
}
