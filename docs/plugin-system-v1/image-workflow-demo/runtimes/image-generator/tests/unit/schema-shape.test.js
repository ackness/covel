import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

describe("image-generator output schema", () => {
  it("declares the expected required fields", () => {
    const raw = JSON.parse(
      readFileSync(
        new URL("../output.schema.json", import.meta.url),
        "utf-8",
      ),
    );

    assert.deepEqual(raw.required, ["messageId", "status", "imageUrl", "caption"]);
  });
});
