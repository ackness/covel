import { describe, expect, it } from "vitest";
import { buildInitialFormState } from "../chat-messages/message-blocks.js";

describe("message block form defaults", () => {
  it("prefills text and valid select defaults", () => {
    expect(
      buildInitialFormState(
        {
          data: {
            fields: [
              { type: "text", name: "persona", defaultValue: "冷静克制" },
              {
                type: "select",
                name: "club",
                options: [{ value: "新闻部", label: "新闻部" }],
                defaultValue: "新闻部",
              },
            ],
          },
        },
        false,
      ),
    ).toEqual({ form: { persona: "冷静克制", club: "新闻部" } });
  });

  it("ignores an invalid select default and restores submitted values", () => {
    const block = {
      fields: [
        {
          type: "select",
          name: "club",
          options: ["新闻部"],
          defaultValue: "不存在的社团",
        },
      ],
    };
    expect(buildInitialFormState(block, false)).toEqual({ form: {} });
    expect(buildInitialFormState(block, true, { club: "新闻部" })).toEqual({
      form: { club: "新闻部" },
    });
  });
});
