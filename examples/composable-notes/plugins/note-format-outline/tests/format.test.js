import assert from "node:assert/strict";
import test from "node:test";
import { outlineNote } from "../server/format.js";

test("creates one bullet per nonblank line without duplicate prefixes", () => {
  assert.equal(
    outlineNote(" First \r\n\r\n * Second\r• Third\n1. Fourth\n- 第五项 "),
    "- First\n- Second\n- Third\n- Fourth\n- 第五项",
  );
});

test("keeps punctuation and HTML-like content as literal text", () => {
  assert.equal(
    outlineNote("-dash\n<script>hi</script>"),
    "- -dash\n- <script>hi</script>",
  );
});
