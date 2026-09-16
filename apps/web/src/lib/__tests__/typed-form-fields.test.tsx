import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { nestedToFlat } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { covelRegistry } from "../catalog.js";
import { messageToSpec, messageToSpecDisabled } from "../message-to-spec.js";
import {
  buildInitialFormState,
  MessageBlockRenderer,
} from "../../components/session/chat-messages/message-blocks.js";
import type { StreamMessage } from "../../stores/session-store.js";

vi.mock("../../stores/session-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../stores/session-store.js")>()),
  useSessionActions: () => ({ upsertInteractionDraft: vi.fn() }),
}));
afterEach(cleanup);
const block = {
  type: "interactive_form",
  interactionId: "allocation",
  title: "Allocate",
  submitLabel: "Save",
  fields: [
    {
      type: "number",
      name: "points",
      label: "Points",
      min: 0,
      max: 5,
      step: 1,
      defaultValue: 0,
      required: true,
    },
    { type: "checkbox", name: "ready", label: "Ready", defaultValue: false },
    { type: "textarea", name: "notes", label: "Notes" },
  ],
};
const message = {
  id: "form",
  role: "assistant",
  content: "",
  block,
} as unknown as StreamMessage;

describe("typed form rendering and input", () => {
  it("binds numeric and boolean values, preserves empty numbers, and renders textarea", () => {
    const changed = vi.fn();
    const spec = nestedToFlat(messageToSpec(message)!);
    render(
      <JSONUIProvider
        registry={covelRegistry}
        initialState={buildInitialFormState(block, false)}
        handlers={{}}
        onStateChange={changed}
      >
        <Renderer spec={spec} registry={covelRegistry} />
      </JSONUIProvider>,
    );
    const number = screen.getByRole("spinbutton", { name: "Points" });
    expect(number.getAttribute("min")).toBe("0");
    expect(number.getAttribute("max")).toBe("5");
    expect(number.getAttribute("step")).toBe("1");
    expect((number as HTMLInputElement).value).toBe("0");
    fireEvent.change(number, { target: { value: "3" } });
    expect(changed.mock.calls.at(-1)?.[0]).toEqual([
      { path: "/form/points", value: 3 },
    ]);
    fireEvent.change(number, { target: { value: "" } });
    expect(changed.mock.calls.at(-1)?.[0]).toEqual([
      { path: "/form/points", value: "" },
    ]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Ready" }));
    expect(changed.mock.calls.at(-1)?.[0]).toEqual([
      { path: "/form/ready", value: true },
    ]);
    expect(screen.getByRole("textbox", { name: "Notes" }).tagName).toBe(
      "TEXTAREA",
    );
  });
  it("preserves numeric zero and unchecked values in submitted forms", () => {
    const spec = nestedToFlat(
      messageToSpecDisabled(message, { points: 0, ready: false })!,
    );
    render(
      <JSONUIProvider registry={covelRegistry} handlers={{}}>
        <Renderer spec={spec} registry={covelRegistry} />
      </JSONUIProvider>,
    );
    expect(
      (screen.getByRole("spinbutton", { name: "Points" }) as HTMLInputElement)
        .value,
    ).toBe("0");
    expect(
      (screen.getByRole("checkbox", { name: "Ready" }) as HTMLInputElement)
        .checked,
    ).toBe(false);
  });
});

it("submits untouched zero defaults and edited values with their original types", async () => {
  const submitted = vi.fn(async () => {});
  render(
    <MessageBlockRenderer
      msg={{ ...message, turnId: "turn" }}
      block={block}
      submitted={false}
      executing={false}
      onSubmitInteraction={submitted}
      onSendMessage={() => {}}
      onSubmitBlock={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(submitted).toHaveBeenCalledWith(
      "form",
      "turn",
      "allocation",
      "form",
      { points: 0, ready: false },
      undefined,
    ),
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Points" }), {
    target: { value: "3" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Ready" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(submitted).toHaveBeenLastCalledWith(
      "form",
      "turn",
      "allocation",
      "form",
      { points: 3, ready: true },
      undefined,
    ),
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Points" }), {
    target: { value: "" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(submitted).toHaveBeenCalledTimes(2);
});
