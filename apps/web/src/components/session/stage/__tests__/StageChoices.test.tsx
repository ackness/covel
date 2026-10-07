import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StageChoices } from "../StageChoices.js";

afterEach(cleanup);

const baseProps = {
  visible: true,
  executing: false,
  interactionChoices: [],
  locale: "zh-CN",
  onSendMessage: vi.fn(),
} as const;

describe("StageChoices", () => {
  it("renders recap, current decision, suggestions, and composer as one panel", () => {
    const onSendMessage = vi.fn();
    render(
      <StageChoices
        {...baseProps}
        suggestions={{
          scene: "旧校舍门前",
          recap: "你答应夏帆放学后一起调查旧校舍，门内刚传来脚步声。",
          decision: "你要直接推门，还是先确认里面的人？",
          choices: [
            {
              id: "prompt:1",
              text: "我先贴近门缝听清脚步声",
              label: { zh: "观察", en: "Observe" },
            },
            {
              id: "prompt:2",
              text: "我小声问夏帆有没有看见人影",
              label: { zh: "追问", en: "Ask" },
            },
          ],
        }}
        onSendMessage={onSendMessage}
      />,
    );

    expect(screen.getByText("旧校舍门前")).toBeDefined();
    expect(
      screen.getByText("你答应夏帆放学后一起调查旧校舍，门内刚传来脚步声。"),
    ).toBeDefined();
    expect(
      screen.getByText("你要直接推门，还是先确认里面的人？"),
    ).toBeDefined();
    expect(screen.getByText("当前信息")).toBeDefined();
    expect(screen.getByText("现在需要决定")).toBeDefined();
    expect(screen.getByTestId("stage-decision-input")).toBeDefined();

    fireEvent.click(screen.getByText("我先贴近门缝听清脚步声"));
    expect(onSendMessage).toHaveBeenCalledWith("我先贴近门缝听清脚步声");
  });

  it("keeps an interaction question attached to its choices", () => {
    const onSubmitInteraction = vi.fn().mockResolvedValue(undefined);
    render(
      <StageChoices
        {...baseProps}
        interactionChoices={[
          {
            blockId: "block-1",
            turnId: "turn-1",
            interactionId: "reply",
            prompt: "你要如何回应朝仓凛？",
            choices: [{ id: "accept", label: "答应替她保守秘密" }],
          },
        ]}
        suggestions={{ choices: [] }}
        onSubmitInteraction={onSubmitInteraction}
      />,
    );

    expect(screen.getByText("你要如何回应朝仓凛？")).toBeDefined();
    fireEvent.click(screen.getByText("答应替她保守秘密"));
    expect(onSubmitInteraction).toHaveBeenCalledWith(
      "block-1",
      "turn-1",
      "reply",
      "choice",
      { selectedId: "accept", selectedLabel: "答应替她保守秘密" },
      undefined,
    );
  });

  it("clears an abandoned draft when a suggested reply is selected", () => {
    const onSendMessage = vi.fn();
    render(
      <StageChoices
        {...baseProps}
        suggestions={{ choices: [{ id: "prompt:1", text: "继续追问" }] }}
        onSendMessage={onSendMessage}
      />,
    );

    const input = screen.getByTestId(
      "stage-decision-input",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "这是已放弃的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "继续追问" }));

    expect(onSendMessage).toHaveBeenCalledWith("继续追问");
    expect(input.value).toBe("");
  });

  it("shows a contextual fallback with inline free input when no plugin suggestions exist", () => {
    const onSendMessage = vi.fn();
    render(
      <StageChoices
        {...baseProps}
        suggestions={{ choices: [] }}
        onSendMessage={onSendMessage}
      />,
    );

    expect(screen.getByText("接下来你准备怎么做？")).toBeDefined();
    const input = screen.getByTestId("stage-decision-input");
    fireEvent.change(input, { target: { value: "  我先查看窗外  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSendMessage).toHaveBeenCalledWith("我先查看窗外");
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("leaves Enter and Escape to an input method that is still composing", () => {
    const onSendMessage = vi.fn();
    render(
      <StageChoices
        {...baseProps}
        suggestions={{ choices: [] }}
        onSendMessage={onSendMessage}
      />,
    );

    const input = screen.getByTestId(
      "stage-decision-input",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "我先 chakan" } });
    // Enter picks the candidate; Escape discards it. Neither is the field's.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    // Safari reports the committing key after the composition has ended.
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSendMessage).not.toHaveBeenCalled();
    expect(input.value).toBe("我先 chakan");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSendMessage).toHaveBeenCalledWith("我先 chakan");
  });

  it("uses the current story and scene to contextualize legacy prompt data", () => {
    render(
      <StageChoices
        {...baseProps}
        fallbackRecap="纸还在你手里。被划掉的那半句，你其实认得字。"
        suggestions={{
          scene: "开学第一天：先回应谁",
          choices: [{ id: "prompt:1", text: "先问凛刚才记下了什么" }],
        }}
      />,
    );

    expect(screen.getByText("当前信息")).toBeDefined();
    expect(
      screen.getByText("纸还在你手里。被划掉的那半句，你其实认得字。"),
    ).toBeDefined();
    expect(screen.getByText("现在需要决定")).toBeDefined();
    expect(
      screen.getByText("围绕「开学第一天：先回应谁」，你准备怎么回应？"),
    ).toBeDefined();
  });

  it("locks choices and the composer while the next turn is running", () => {
    render(
      <StageChoices
        {...baseProps}
        executing
        suggestions={{ choices: [{ id: "prompt:1", text: "继续追问" }] }}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "继续追问" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId("stage-decision-input") as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText("叙事生成中…")).toBeDefined();
  });

  it("keeps the recap collapsed while decisions and free input remain available", () => {
    const onSendMessage = vi.fn();
    render(
      <StageChoices
        {...baseProps}
        suggestions={{
          recap: "A long recap. ".repeat(80),
          choices: [{ id: "prompt:1", text: "Ask Rin" }],
        }}
        onSendMessage={onSendMessage}
      />,
    );
    const summary = screen.getByText("当前信息");
    const disclosure = summary.closest("details");
    expect(disclosure?.open).toBe(false);
    fireEvent.click(summary);
    expect(disclosure?.open).toBe(true);
    fireEvent.click(summary);
    expect(disclosure?.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Ask Rin" }));
    expect(onSendMessage).toHaveBeenCalledWith("Ask Rin");
    expect(
      (screen.getByTestId("stage-decision-input") as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
  });
});
