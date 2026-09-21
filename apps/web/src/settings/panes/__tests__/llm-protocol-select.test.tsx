import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ProtocolSelect } from "../llm-provider-dialogs.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("evaluation protocol selection", () => {
  it.each([
    ["typesafe", "typesafe-systemone-v1"],
    ["openrouter", "openrouter-decisions-v1"],
    ["vercel", "vercel-evaluation-v4"],
  ])(
    "suggests the %s wire through one Evaluation choice",
    (provider, protocol) => {
      const onChange = vi.fn();
      render(
        <ProtocolSelect
          provider={provider}
          value="openai-chat-v1"
          onChange={onChange}
        />,
      );
      const select = screen.getByRole("combobox", {
        name: /^API protocol$/,
      });
      expect(
        within(select)
          .getAllByRole("option")
          .map((option) => option.textContent),
      ).toEqual([
        "OpenAI Chat",
        "OpenAI Responses",
        "Anthropic Messages",
        "Evaluation",
      ]);
      fireEvent.change(select, { target: { value: "evaluation" } });
      expect(onChange).toHaveBeenCalledWith(protocol);
    },
  );

  it("preserves an explicitly configured wire even when the provider family changes", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ProtocolSelect
        provider="openrouter"
        value="vercel-evaluation-v4"
        onChange={onChange}
      />,
    );
    expect(
      (
        screen.getByRole("combobox", {
          name: "Evaluation API",
        }) as HTMLSelectElement
      ).value,
    ).toBe("vercel-evaluation-v4");
    rerender(
      <ProtocolSelect
        provider="custom-proxy"
        value="vercel-evaluation-v4"
        onChange={onChange}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("combobox", {
          name: /^API protocol$/,
        }) as HTMLSelectElement
      ).value,
    ).toBe("evaluation");
  });

  it("supports a custom connection, an explicit wire override, and restoring inheritance", () => {
    function Fixture() {
      const [value, onChange] = useState("");
      return (
        <ProtocolSelect
          provider="custom-proxy"
          inheritedProtocol="vercel-evaluation-v4"
          inheritLabel="Use provider protocol"
          value={value}
          onChange={onChange}
        />
      );
    }
    render(<Fixture />);
    const select = screen.getByRole("combobox", {
      name: /^API protocol$/,
    });
    fireEvent.change(select, { target: { value: "evaluation" } });
    const wire = screen.getByRole("combobox", {
      name: "Evaluation API",
    }) as HTMLSelectElement;
    expect(wire.value).toBe("vercel-evaluation-v4");
    fireEvent.change(wire, { target: { value: "openrouter-decisions-v1" } });
    expect(wire.value).toBe("openrouter-decisions-v1");
    fireEvent.change(select, { target: { value: "" } });
    expect(
      screen.queryByRole("combobox", { name: "Evaluation API" }),
    ).toBeNull();
  });
});
