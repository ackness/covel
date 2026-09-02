import { describe, expect, it } from "vitest";
import i18n from "@/i18n/index.js";
import { worldEnumLabel } from "../enum-labels.js";

describe("world detail enum labels", () => {
  it("uses interface translations for schema enums", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(worldEnumLabel(i18n.t, "factionType", "guild")).toBe("公会");
    expect(worldEnumLabel(i18n.t, "combat", "turn-based")).toBe("回合制");

    await i18n.changeLanguage("en-US");
    expect(worldEnumLabel(i18n.t, "rating", "teen")).toBe("Teen");
  });

  it("preserves unknown extension values", () => {
    expect(worldEnumLabel(i18n.t, "relation", "trade-partner")).toBe(
      "trade-partner",
    );
  });
});
