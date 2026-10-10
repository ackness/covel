import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { SuspensionsPanel } from "../suspensions-panel.js";

beforeAll(async () => {
  await i18n.changeLanguage("en-US");
});

const base = {
  id: "s1",
  sessionId: "sess",
  turnId: "t1",
  runtimeId: "guide",
  pluginId: "guide",
  reason: "Which way do you go?",
  createdAt: new Date().toISOString(),
};

it("resumes a choice suspension with the picked option, without asking for JSON", () => {
  const onResume = vi.fn().mockResolvedValue(undefined);
  render(
    <SuspensionsPanel
      suspensions={[{ ...base, resumeSchema: { enum: ["left", "right"] } }]}
      onResume={onResume}
      onCancel={vi.fn()}
    />,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "right" }));
  expect(onResume).toHaveBeenCalledWith("s1", "right");
});

it("builds a form from an object schema and resumes with the typed values", () => {
  const onResume = vi.fn().mockResolvedValue(undefined);
  render(
    <SuspensionsPanel
      suspensions={[
        {
          ...base,
          resumeSchema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      ]}
      onResume={onResume}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "name" }), {
    target: { value: "Ada" },
  });
  fireEvent.click(screen.getByRole("button", { name: /resume/i }));
  expect(onResume).toHaveBeenCalledWith("s1", { name: "Ada" });
});
