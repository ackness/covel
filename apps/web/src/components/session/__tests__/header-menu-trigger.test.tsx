import { cleanup, render, screen } from "@testing-library/react";
import { Menu } from "lucide-react";
import { afterEach, expect, it } from "vitest";
import { HeaderMenu } from "../game-view/header-menu.js";

afterEach(cleanup);

// The stage appearance draws every `ui-session-action` as a round glass
// button, so a trigger's width and that class decide its shape.

it("lets a trigger with words grow with them instead of keeping the icon width", () => {
  render(
    <HeaderMenu label="Menu" text="Menu" icon={Menu} active={false}>
      <p>item</p>
    </HeaderMenu>,
  );
  const trigger = screen.getByRole("button", { name: "Menu" });
  expect(trigger.className).toContain("ui-session-action");
  expect(trigger.className).toContain("min-w-10");
  expect(trigger.className).not.toMatch(/(^|\s)(md:)?w-(8|10)(\s|$)/);
});

it("keeps an icon-only trigger square", () => {
  render(
    <HeaderMenu label="More" active={false}>
      <p>item</p>
    </HeaderMenu>,
  );
  const trigger = screen.getByRole("button", { name: "More" });
  expect(trigger.className).toContain("w-10");
  expect(trigger.className).toContain("md:w-8");
});

it("does not style a trigger inside a grouped switch as a standalone header button", () => {
  render(
    <HeaderMenu
      label="Plugin pages"
      inGroup
      triggerClassName="w-7"
      active={false}
    >
      <p>item</p>
    </HeaderMenu>,
  );
  const trigger = screen.getByRole("button", { name: "Plugin pages" });
  expect(trigger.className).not.toContain("ui-session-action");
  expect(trigger.className).toContain("w-7");
});
