import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { DimensionValueView } from "../dimension-value-view.js";

const caseBoard = {
  type: "object",
  additionalProperties: {
    type: "object",
    properties: {
      lead: { type: "string", title: { "zh-CN": "线索", "en-US": "Lead" } },
      settled: {
        type: "boolean",
        title: { "zh-CN": "已结", "en-US": "Settled" },
      },
      owner: { type: "string", title: { "zh-CN": "持有人", "en-US": "Owner" } },
    },
  },
} as const;

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

describe("DimensionValueView", () => {
  it("shows a world record's translated text in the language asked for", () => {
    render(
      <DimensionValueView
        schema={caseBoard}
        value={{
          "torn-letter": {
            lead: { "zh-CN": "半封信", "en-US": "The torn letter" },
            settled: false,
            owner: null,
          },
        }}
        locale="en-US"
        baseLocale="zh-CN"
      />,
    );
    expect(screen.getByText("The torn letter")).toBeTruthy();
    expect(screen.queryByText("半封信")).toBeNull();
    expect(screen.queryByText("zh-CN")).toBeNull();
    expect(screen.getByText(i18n.t("common.no"))).toBeTruthy();
    expect(screen.queryByText("null")).toBeNull();
  });

  it("keeps an object whose keys only look like languages", () => {
    render(
      <DimensionValueView
        schema={{ type: "object" }}
        value={{ id: "fogRot", no: "3" }}
        locale="en-US"
        baseLocale="zh-CN"
      />,
    );
    expect(screen.getByText("fogRot")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });
});
