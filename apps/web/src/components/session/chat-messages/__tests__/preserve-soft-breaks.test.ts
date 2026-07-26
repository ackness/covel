import { describe, expect, it } from "vitest";
import { preserveSoftBreaks } from "../message-primitives.js";

describe("preserveSoftBreaks", () => {
  it("turns a lone newline into a markdown hard break", () => {
    // Without this, markdown joins the two lines with a space and the player's
    // Enter key silently does nothing.
    expect(preserveSoftBreaks("第一行\n第二行")).toBe("第一行  \n第二行");
  });

  it("leaves paragraph breaks alone", () => {
    // A blank line is already a paragraph separator; padding it would inject a
    // stray hard break before the gap.
    expect(preserveSoftBreaks("段落一\n\n段落二")).toBe("段落一\n\n段落二");
  });

  it("handles a run of three newlines without touching the boundary", () => {
    expect(preserveSoftBreaks("a\n\n\nb")).toBe("a\n\n\nb");
  });

  it("promotes every lone break in a multi-line block", () => {
    expect(preserveSoftBreaks("a\nb\nc")).toBe("a  \nb  \nc");
  });

  it("leaves single-line and empty text untouched", () => {
    expect(preserveSoftBreaks("just one line")).toBe("just one line");
    expect(preserveSoftBreaks("")).toBe("");
  });

  it("does not rewrite a literal backslash-n, which is not a newline", () => {
    // The `\n` a model emits inside an over-escaped JSON string is two
    // characters, not a break — this function must not paper over that.
    expect(preserveSoftBreaks(String.raw`一段\n\n另一段`)).toBe(
      String.raw`一段\n\n另一段`,
    );
  });
});
