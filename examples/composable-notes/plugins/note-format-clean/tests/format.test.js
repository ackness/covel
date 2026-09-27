import assert from "node:assert/strict";
import test from "node:test";
import { cleanNote } from "../server/format.js";

test("cleans whitespace and line endings while preserving paragraphs", () => {
  assert.equal(
    cleanNote(
      "  First line  \r\n next line\t\r\n\r\n\r\n Second paragraph  \r",
    ),
    "First line\nnext line\n\nSecond paragraph",
  );
});

test("returns markup as literal text without interpreting it", () => {
  assert.equal(
    cleanNote("  <script>alert(1)</script>  "),
    "<script>alert(1)</script>",
  );
});
