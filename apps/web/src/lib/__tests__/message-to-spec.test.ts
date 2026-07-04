import { describe, expect, it } from "vitest";
import { messageToSpec } from "../message-to-spec.js";
import type { StreamMessage } from "@/stores/session-store.js";

type Spec = {
  type: string;
  props?: Record<string, unknown>;
  children?: Spec[];
};

function formMsg(narrativeTemplate: string): StreamMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    block: {
      type: "interactive_form",
      title: "角色创建",
      submitLabel: "走进教室",
      fields: [{ type: "text", name: "characterName", label: "你的名字" }],
      narrativeTemplate,
    },
  } as unknown as StreamMessage;
}

/** Pull the muted preview Text node out of a Form spec's children. */
function previewText(spec: Spec | null): string {
  const child = spec?.children?.find(
    (c) => c.type === "Text" && c.props?.variant === "muted",
  );
  return (child?.props?.content as string) ?? "";
}

describe("formToSpec narrativeTemplate preview", () => {
  it("strips markdown bold and collapses escaped/real newlines", () => {
    const spec = messageToSpec(
      formMsg(
        "你已说出口——**{{characterName}}**。\\n\\n关于你转学的原因：「{{reason}}」。\n\n第一天。",
      ),
    ) as Spec;
    const preview = previewText(spec);

    expect(preview).not.toContain("**");
    expect(preview).not.toContain("\\n");
    expect(preview).not.toContain("\n");
    expect(preview).toContain("你已说出口——___。");
    expect(preview).toContain("关于你转学的原因：「___」。");
  });
});
