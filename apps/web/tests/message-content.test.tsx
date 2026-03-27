// @vitest-environment jsdom
import React from "react";

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { MessageContent } from "../src/components/message-content.js";

describe("MessageContent", () => {
  it("renders assistant content as markdown and updates as content streams", () => {
    const { container, rerender } = render(
      <MessageContent
        content={"# 雾港十三号\n\n- 潮雾\n- 灯塔"}
        role="assistant"
        streaming={true}
      />
    );

    expect(screen.getByRole("heading", { name: "雾港十三号" })).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(2);

    rerender(
      <MessageContent
        content={"# 雾港十三号\n\n- 潮雾\n- 灯塔\n- 锚链"}
        role="assistant"
        streaming={true}
      />
    );

    expect(screen.getByText("锚链")).toBeTruthy();
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("keeps user content as plain text", () => {
    const { container } = render(
      <MessageContent
        content={"**不要渲染成粗体**"}
        role="user"
        streaming={false}
      />
    );

    expect(screen.getByText("**不要渲染成粗体**")).toBeTruthy();
    expect(container.querySelector("strong")).toBeNull();
  });
});
