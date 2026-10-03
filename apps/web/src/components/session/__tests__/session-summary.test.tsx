import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionSummaryModel } from "@covel/shared";
import i18n from "@/i18n";
import { SummaryLines, useSessionSummary } from "../session-summary.js";

const slot = vi.hoisted(() => ({
  value: null as SessionSummaryModel | null,
}));
vi.mock("@/stores/ui-slot-store.js", () => ({
  useUiSlot: (_sessionId: string, name: string) =>
    name === "session.summary@1" && slot.value
      ? { slot: name, value: slot.value, revision: "r" }
      : undefined,
}));

function Summary() {
  return <SummaryLines lines={useSessionSummary("session")} />;
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);

it("draws text, gauge and list entries in the interface language", () => {
  slot.value = {
    entries: [
      {
        id: "quest.current",
        kind: "text",
        label: { zh: "当前目标", en: "Objective" },
        value: "问铁姑第七十四号",
      },
      {
        id: "quest.progress",
        kind: "meter",
        label: "失踪的公会长",
        value: 1,
        max: 3,
      },
      {
        id: "inventory.items",
        kind: "list",
        label: { zh: "行囊", en: "Pack" },
        items: ["冷光雾灯", "潮币 ×12"],
        total: 5,
      },
    ],
  };
  render(<Summary />);
  expect(screen.getByText("当前目标")).toBeTruthy();
  expect(screen.getByText("问铁姑第七十四号")).toBeTruthy();
  const meter = screen.getByRole("meter", { name: "失踪的公会长" });
  expect(meter.getAttribute("aria-valuenow")).toBe("1");
  expect(meter.getAttribute("aria-valuemax")).toBe("3");
  expect(screen.getByText("潮币 ×12")).toBeTruthy();
  // Three more items than the list shows.
  expect(screen.getByText("+3")).toBeTruthy();
});

it("lets a later entry replace an earlier one with the same id and drops empty lists", () => {
  slot.value = {
    entries: [
      { id: "time.now", kind: "text", label: "时间", value: "清晨" },
      { id: "time.now", kind: "text", label: "时间", value: "黄昏" },
      { id: "inventory.items", kind: "list", label: "行囊", items: [] },
    ],
  };
  render(<Summary />);
  expect(screen.queryByText("清晨")).toBeNull();
  expect(screen.getByText("黄昏")).toBeTruthy();
  expect(screen.queryByText("行囊")).toBeNull();
});

it("renders nothing without a summary", () => {
  slot.value = null;
  const view = render(<Summary />);
  expect(view.container.innerHTML).toBe("");
});
