import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { SharedServerInfo } from "@/services/api/health.js";
import { SharedServerNotice } from "../shared-server-notice.js";

const server = vi.hoisted(() => ({
  info: null as SharedServerInfo | null,
}));

vi.mock("@/services/api/health.js", () => ({
  getSharedServerInfo: () => server.info,
}));

beforeEach(async () => {
  localStorage.clear();
  server.info = null;
  await i18n.changeLanguage("en-US");
});

it("stays hidden on a server that is not shared", () => {
  const { container } = render(<SharedServerNotice />);
  expect(container.textContent).toBe("");
});

it("explains where saves and keys go and links the docs and the running source", () => {
  server.info = {
    repository: "https://github.com/ackness/covel",
    commit: "c1e2867d9abcdef",
  };
  render(<SharedServerNotice />);
  expect(screen.getByText("This is a public Covel trial")).toBeTruthy();
  expect(
    screen.getByText(/Create a temporary API key just for this trial/)
      .textContent,
  ).toContain("delete or rotate the key at your provider");
  expect(
    screen
      .getByRole("link", { name: "How your data and keys are handled" })
      .getAttribute("href"),
  ).toBe("https://covel.cc/docs/en/start/hosted-trial");
  expect(
    screen
      .getByRole("link", {
        name: "Source code: running c1e2867 (open source, deployed automatically)",
      })
      .getAttribute("href"),
  ).toBe("https://github.com/ackness/covel/tree/c1e2867d9abcdef");
});

it("links the Chinese docs for a Chinese reader and omits an unknown source", async () => {
  server.info = {};
  await i18n.changeLanguage("zh-CN");
  render(<SharedServerNotice />);
  expect(
    screen
      .getByRole("link", { name: "数据和密钥怎样处理" })
      .getAttribute("href"),
  ).toBe("https://covel.cc/docs/start/hosted-trial");
  expect(screen.queryByText(/源代码/)).toBeNull();
});

it("stays dismissed for this browser", () => {
  server.info = {};
  const first = render(<SharedServerNotice />);
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(first.container.textContent).toBe("");
  first.unmount();

  const second = render(<SharedServerNotice />);
  expect(second.container.textContent).toBe("");
});
