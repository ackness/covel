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

it("labels form-derived controls with titles and submits answers by field name", () => {
  const onResume = vi.fn().mockResolvedValue(undefined);
  render(
    <SuspensionsPanel
      suspensions={[
        {
          ...base,
          resumeSchema: {
            type: "object",
            properties: {
              name: { type: "string", title: "Your name", minLength: 1 },
              age: {
                type: "number",
                title: "Your age",
                minimum: 1,
                maximum: 100,
              },
              agree: { type: "boolean", title: "I agree" },
              route: {
                type: "string",
                title: "Your route",
                enum: ["gate", "inn"],
              },
            },
            required: ["name", "age", "agree", "route"],
            additionalProperties: false,
          },
        },
      ]}
      onResume={onResume}
      onCancel={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Your name" }), {
    target: { value: "Alex" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Your age" }), {
    target: { value: "21" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "I agree" }));
  expect(screen.getByRole("combobox", { name: "Your route" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /resume/i }));
  expect(onResume).toHaveBeenCalledWith("s1", {
    name: "Alex",
    age: 21,
    agree: true,
    route: "gate",
  });
});

it.each([true, false])(
  "submits untouched form defaults when required is %s",
  (required) => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    const defaults = {
      route: "inn",
      count: 7,
      agree: true,
      zero: 0,
      unchecked: false,
      text: "",
    };
    render(
      <SuspensionsPanel
        suspensions={[
          {
            ...base,
            resumeSchema: {
              type: "object",
              properties: {
                route: {
                  type: "string",
                  enum: ["gate", "inn"],
                  default: defaults.route,
                },
                count: { type: "number", default: defaults.count },
                agree: { type: "boolean", default: defaults.agree },
                zero: { type: "number", default: defaults.zero },
                unchecked: { type: "boolean", default: defaults.unchecked },
                text: { type: "string", default: defaults.text },
                omitted: { type: "string" },
              },
              required: required ? Object.keys(defaults) : [],
              additionalProperties: false,
            },
          },
        ]}
        onResume={onResume}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: "route" })).toHaveProperty(
      "value",
      "1",
    );
    expect(screen.getByRole("spinbutton", { name: "count" })).toHaveProperty(
      "value",
      "7",
    );
    expect(screen.getByRole("checkbox", { name: "agree" })).toHaveProperty(
      "checked",
      true,
    );
    expect(screen.getByRole("spinbutton", { name: "zero" })).toHaveProperty(
      "value",
      "0",
    );
    expect(screen.getByRole("checkbox", { name: "unchecked" })).toHaveProperty(
      "checked",
      false,
    );
    expect(screen.getByRole("textbox", { name: "text" })).toHaveProperty(
      "value",
      "",
    );
    expect(screen.queryByRole("textbox", { name: "omitted" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect(onResume).toHaveBeenCalledWith("s1", defaults);
  },
);
