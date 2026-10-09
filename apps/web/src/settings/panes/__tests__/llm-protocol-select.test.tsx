import { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { listProviderModels } from "@/services/api.js";
import { ProtocolSelect, ProviderDialog } from "../llm-provider-dialogs.js";
import { EMPTY_PROVIDER_DRAFT } from "../llm-provider-catalog.js";

vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  listProviderModels: vi.fn(),
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("evaluation protocol selection", () => {
  it.each([
    ["typesafe", "typesafe-systemone-v1"],
    ["openrouter", "openrouter-decisions-v1"],
    ["vercel", "vercel-evaluation-v4"],
    ["openai", "openai-decisions-v1"],
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
        "Google Gemini",
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

describe("provider picker", () => {
  function renderDialog(draft = EMPTY_PROVIDER_DRAFT) {
    const onDraftChange = vi.fn();
    render(
      <ProviderDialog
        open
        busy={false}
        error={null}
        draft={draft}
        onOpenChange={() => {}}
        onDraftChange={onDraftChange}
        onSubmit={() => {}}
      />,
    );
    return {
      onDraftChange,
      picker: screen.getByRole("combobox", {
        name: "Provider",
      }) as HTMLSelectElement,
    };
  }

  it("fills the ID and endpoint of a built-in provider", () => {
    const { onDraftChange, picker } = renderDialog();
    expect(picker.value).toBe("");
    fireEvent.change(picker, { target: { value: "zhipu" } });
    expect(onDraftChange).toHaveBeenCalledWith({
      ...EMPTY_PROVIDER_DRAFT,
      providerId: "zhipu",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    });
  });

  it("shows a typed built-in ID as that provider and any other as custom", () => {
    expect(
      renderDialog({ ...EMPTY_PROVIDER_DRAFT, providerId: " Groq " }).picker
        .value,
    ).toBe("groq");
  });

  it("clears the endpoint when the player goes back to a custom provider", () => {
    const { onDraftChange, picker } = renderDialog({
      ...EMPTY_PROVIDER_DRAFT,
      providerId: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      modelIds: "some-model",
    });
    fireEvent.change(picker, { target: { value: "" } });
    expect(onDraftChange).toHaveBeenCalledWith({
      ...EMPTY_PROVIDER_DRAFT,
      modelIds: "some-model",
    });
  });
});

describe("model list picker", () => {
  function Fixture() {
    const [draft, setDraft] = useState({
      ...EMPTY_PROVIDER_DRAFT,
      providerId: "ollama",
      baseUrl: "http://localhost:11434/v1",
      modelIds: "typed-by-hand",
    });
    return (
      <ProviderDialog
        open
        busy={false}
        error={null}
        draft={draft}
        onOpenChange={() => {}}
        onDraftChange={setDraft}
        onSubmit={() => {}}
      />
    );
  }

  it("adds and removes a listed model beside the IDs typed by hand", async () => {
    vi.mocked(listProviderModels).mockResolvedValue({
      ok: true,
      models: ["codex/gpt-6-luna", "qwen3:8b"],
    });
    render(<Fixture />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Read the model list from the service",
      }),
    );
    const listed = await screen.findByRole("checkbox", { name: "qwen3:8b" });
    expect(listProviderModels).toHaveBeenCalledWith({
      provider: "ollama",
      baseUrl: "http://localhost:11434/v1",
    });
    const ids = screen.getByRole("textbox", {
      name: /Model IDs/,
    }) as HTMLTextAreaElement;

    fireEvent.click(listed);
    expect(ids.value).toBe("typed-by-hand\nqwen3:8b");
    fireEvent.change(screen.getByRole("textbox", { name: "Filter models" }), {
      target: { value: "LUNA" },
    });
    expect(screen.queryByRole("checkbox", { name: "qwen3:8b" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "codex/gpt-6-luna" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "codex/gpt-6-luna" }));
    expect(ids.value).toBe("typed-by-hand\nqwen3:8b");
  });

  it("shows why the service gave no list", async () => {
    vi.mocked(listProviderModels).mockResolvedValue({
      ok: false,
      models: [],
      error: "connect ECONNREFUSED 127.0.0.1:11434",
    });
    render(<Fixture />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Read the model list from the service",
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "connect ECONNREFUSED 127.0.0.1:11434",
      ),
    );
  });
});
