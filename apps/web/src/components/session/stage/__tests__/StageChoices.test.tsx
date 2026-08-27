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
        promptsNamespace={{
          scene: "旧校舍门前",
          recap: "你答应夏帆放学后一起调查旧校舍，门内刚传来脚步声。",
          decision: "你要直接推门，还是先确认里面的人？",
          prompt1Text: "我先贴近门缝听清脚步声",
          prompt1Label: { zh: "观察", en: "Observe" },
          prompt2Text: "我小声问夏帆有没有看见人影",
          prompt2Label: { zh: "追问", en: "Ask" },
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
        promptsNamespace={{}}
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

  it("shows a contextual fallback with inline free input when no plugin suggestions exist", () => {
    const onSendMessage = vi.fn();
    render(
      <StageChoices
        {...baseProps}
        promptsNamespace={{}}
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

  it("locks choices and the composer while the next turn is running", () => {
    render(
      <StageChoices
        {...baseProps}
        executing
        promptsNamespace={{ prompt1Text: "继续追问" }}
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
});
